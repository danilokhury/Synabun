import { detectProject as memoryProject } from '../../mcp-server/dist/config.js';
import { Codex } from '@openai/codex-sdk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EFFORT_LEVELS } from './claude-model-catalog.js';
import { CLAUDE_NOT_INSTALLED, resolveClaudeSdkExecutable } from './claude-executable.js';
import { extractOpenCodeText } from './session-title-generator.js';
import { patchCodexLineSplitting } from './jsonl-lines.js';
import { dirname } from 'node:path';
import { codexReasoningEffort } from './effort-levels.js';
import { codexStreamMedia, collectCodexMedia, openCodeMediaPart, ownCodexImages } from './assistant-media.js';
import { browserToolDenial } from './browser-tool-policy.js';
import { CODEX_BROWSER_POLICY_UNTRUSTED_NOTE, codexBrowserPolicyHook } from './assistant-route-gate-codex.js';

function stringEnv(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

function cleanClaudeEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (key === 'CLAUDECODE' || key === 'TERM_PROGRAM' || key === 'TERM_PROGRAM_VERSION') continue;
    if (key.startsWith('VSCODE_')) continue;
    env[key] = value;
  }
  env.ENABLE_TOOL_SEARCH = 'true';
  return env;
}

async function settleWithin(promise, timeoutMs = 1500) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolveWait) => { timer = setTimeout(resolveWait, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createInputQueue() {
  const values = [];
  let wake = null;
  let closed = false;
  return {
    push(value) {
      if (closed) return false;
      values.push(value);
      if (wake) { const resolveWake = wake; wake = null; resolveWake(); }
      return true;
    },
    close() {
      closed = true;
      if (wake) { const resolveWake = wake; wake = null; resolveWake(); }
    },
    async *[Symbol.asyncIterator]() {
      while (!closed || values.length) {
        while (values.length) yield values.shift();
        if (closed) return;
        await new Promise((resolveWake) => { wake = resolveWake; });
      }
    },
  };
}

function asAbortError(reason = 'aborted') {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}

function providerErrorMessage(error, fallback = 'Provider request failed') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  return error?.data?.message || error?.message || error?.name || fallback;
}

function codexFailureMessage(error) {
  const raw = providerErrorMessage(error, 'Codex turn failed');
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || raw;
  } catch { return raw; }
}

/** Every level Codex accepts passes through unchanged (max stays max); off → undefined. */
export function normalizeCodexEffort(effort) {
  return codexReasoningEffort(effort);
}

export function normalizeOpenCodeModel(model) {
  if (!model) return undefined;
  if (typeof model === 'object') return model;
  const value = String(model).trim();
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

// ── Task-mode (assistant dispatch) policy helpers ────────────────────────────
//
// permissionPolicy: 'auto' (unattended, today's behavior) | 'ask' (route
// permission prompts through a broker so the orchestrator/user can answer) |
// 'restricted' (unattended but sandboxed where the provider supports it).
// capability: 'read-only' | 'workspace' | 'full' — how much the worker may touch.

export const PERMISSION_POLICIES = new Set(['auto', 'ask', 'restricted']);
export const CAPABILITIES = new Set(['read-only', 'workspace', 'full']);
export const CLAUDE_READ_ONLY_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];

export function normalizePermissionPolicy(policy) {
  const value = String(policy || 'auto').trim().toLowerCase();
  return PERMISSION_POLICIES.has(value) ? value : 'auto';
}

export function normalizeCapability(capability) {
  const value = String(capability || 'full').trim().toLowerCase();
  return CAPABILITIES.has(value) ? value : 'full';
}

export function codexSandboxModeFor({ permissionPolicy, capability } = {}) {
  const cap = normalizeCapability(capability);
  if (cap === 'read-only') return 'read-only';
  if (cap === 'workspace' || normalizePermissionPolicy(permissionPolicy) === 'restricted') return 'workspace-write';
  return 'danger-full-access';
}

function policyUnsupportedError(provider, policy) {
  const error = new Error(`${provider} native adapter does not support permission policy "${policy}"`);
  error.code = 'PERMISSION_POLICY_UNSUPPORTED';
  return error;
}

/** Final assistant text carried by a Codex SDK stream event, or null. */
export function codexAgentMessageText(event) {
  if (!event) return null;
  if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
    const text = event.item.text ?? event.item.content;
    return typeof text === 'string' ? text : null;
  }
  if (event.type === 'agent_message') {
    const text = event.text ?? event.message;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

// ── Codex output schemas ─────────────────────────────────────────────────────
//
// Codex sends an output schema as a strict response_format: every object must
// set additionalProperties:false and list every property in `required`, or the
// turn fails in seconds with "Invalid schema for response_format".

const SCHEMA_UNIONS = ['anyOf', 'oneOf', 'allOf'];
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const isSchema = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** A schema that also accepts null: how a strict schema says a field may be left out. */
function nullableSchema(schema) {
  if (!isSchema(schema)) return schema;
  const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === 'string' ? [schema.type] : null;
  if (types?.includes('null')) return schema;
  // A plain scalar widens its type. Anything else (an enum or const would still refuse null, an
  // object, an array, a union) gets null as a branch of its own.
  if (types && types.every((type) => SCALAR_TYPES.has(type)) && !('enum' in schema) && !('const' in schema)) return { ...schema, type: [...types, 'null'] };
  if (!types && Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((branch) => branch?.type === 'null') ? schema : { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

/**
 * A copy of an output schema in the strict form Codex accepts: every object gets
 * additionalProperties:false and requires all its properties, and a property the
 * caller left optional also accepts null (see dropOptionalNulls). Recurses into
 * properties, items, anyOf / oneOf / allOf and $defs. The caller's schema is not touched.
 */
export function strictCodexSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictCodexSchema);
  if (!isSchema(schema)) return schema;
  const out = { ...schema };
  for (const key of SCHEMA_UNIONS) if (Array.isArray(out[key])) out[key] = out[key].map(strictCodexSchema);
  if (out.items && typeof out.items === 'object') out.items = strictCodexSchema(out.items);
  for (const key of ['$defs', 'definitions']) {
    if (isSchema(out[key])) out[key] = Object.fromEntries(Object.entries(out[key]).map(([name, value]) => [name, strictCodexSchema(value)]));
  }
  const isObject = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object')) || isSchema(out.properties);
  if (!isObject) return out;
  const wasRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
  out.properties = Object.fromEntries(Object.entries(isSchema(schema.properties) ? schema.properties : {}).map(([name, value]) => {
    const strict = strictCodexSchema(value);
    return [name, wasRequired.has(name) ? strict : nullableSchema(strict)];
  }));
  out.required = Object.keys(out.properties);
  out.additionalProperties = false;
  return out;
}

/** The schema itself and every anyOf / oneOf / allOf branch under it: the shapes a value may have. */
function schemaBranches(schema) {
  if (!isSchema(schema)) return [];
  const out = [schema];
  for (const key of SCHEMA_UNIONS) for (const branch of Array.isArray(schema[key]) ? schema[key] : []) out.push(...schemaBranches(branch));
  return out;
}

/**
 * A structured answer read back against the caller's own schema: a null in a field that schema
 * left optional (strictCodexSchema made it required and nullable) means "left out", so the key
 * is dropped. A null in a field the caller required stays.
 */
export function dropOptionalNulls(value, schema) {
  if (Array.isArray(value)) {
    const items = schemaBranches(schema).map((branch) => branch.items).find(isSchema) || null;
    return value.map((item) => dropOptionalNulls(item, items));
  }
  if (!value || typeof value !== 'object') return value;
  const shapes = schemaBranches(schema).filter((branch) => isSchema(branch.properties));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const owners = shapes.filter((shape) => Object.hasOwn(shape.properties, key));
    if (item === null && owners.length && owners.every((shape) => !(Array.isArray(shape.required) && shape.required.includes(key)))) continue;
    out[key] = dropOptionalNulls(item, owners[0]?.properties[key] || null);
  }
  return out;
}

/** The final message of a turn that had an output schema, as the object it is (optional nulls dropped), else null. */
function codexStructuredOutput(text, schema) {
  let value = null;
  try { value = JSON.parse(String(text || '').trim()); } catch { return null; }
  return value && typeof value === 'object' ? dropOptionalNulls(value, schema) : null;
}

/** Create one durable Codex SDK thread and reuse it for every loop iteration. */
export async function createCodexNativeLoopAdapter(options = {}) {
  const {
    runId, cwd, model, effort, codexHome, codexPath, browserSessionId,
    browserTabId, mcpProfile, onIdentity = () => {}, onEvent = () => {},
    CodexClass = Codex,
    extraEnv = {}, permissionPolicy: rawPolicy = 'auto', capability: rawCapability = 'full',
    outputSchema = null, desktopGrantProvider = null, modelContextWindow = null, contextMode = null,
    // Image creation runs (assistant dispatch): 'image' → each turn returns the images it generated.
    collectMedia = null,
    // Assistant task runs: the browser policy's hook and the run's notes (a function: never in the state file).
    runMode = 'loop', onNote = null, browserPolicyTrust = null,
  } = options;
  const permissionPolicy = normalizePermissionPolicy(rawPolicy);
  const capability = normalizeCapability(rawCapability);
  // "<id>[extended]" (the Assistant's extended-context row) runs <id> with the
  // larger window the dispatcher read from the catalog; never silently at 272k.
  const legacyExtended = /\[extended\]$/i.test(String(model || ''));
  const extended = contextMode === 'extended' || legacyExtended;
  const runModel = legacyExtended ? String(model).replace(/\[extended\]$/i, '') : model;
  if (extended && !(Number(modelContextWindow) > 0)) throw new Error(`Extended context is unavailable for ${runModel}.`);
  // The Codex SDK drives `codex exec`, which has no approval channel: an 'ask'
  // policy would hang or fail mid-turn. Refuse up front so the dispatcher can
  // offer 'restricted' instead.
  if (permissionPolicy === 'ask') throw policyUnsupportedError('Codex', permissionPolicy);
  // Assistant task runs: SynaBun's browser policy as a PreToolUse hook the
  // user's Codex trusts (the brain's route-gate mechanism), and no web search
  // of Codex's own. Without a trusted hook the policy is instructions only
  // (the task prompt), and the run's notes say so.
  const task = runMode === 'task';
  let browserPolicy = null;
  if (task) {
    try { browserPolicy = await codexBrowserPolicyHook({ codexBin: codexPath || null, ...(browserPolicyTrust ? { trust: browserPolicyTrust } : {}) }); } catch { browserPolicy = null; }
    if (!browserPolicy) { try { onNote?.(CODEX_BROWSER_POLICY_UNTRUSTED_NOTE); } catch {} }
  }
  const pins = stringEnv({
    SYNABUN_TERMINAL_SESSION: runId,
    SYNABUN_PROJECT: cwd ? memoryProject(cwd) : 'global',
    SYNABUN_BROWSER_SESSION: browserSessionId,
    SYNABUN_BROWSER_TAB: browserTabId,
    SYNABUN_PROFILE: mcpProfile,
    SYNABUN_TOOL_CATALOG_MODE: 'deferred',
    // Computer-use workers: the grant unlocks the `computer` group in the MCP child.
    SYNABUN_DESKTOP_GRANT: typeof desktopGrantProvider === 'function' ? desktopGrantProvider() || undefined : undefined,
  });
  const env = stringEnv({ ...process.env, ...pins, CODEX_HOME: codexHome, ...(browserPolicy ? { SYNABUN_BROWSER_POLICY_CWD: cwd || process.cwd() } : {}), ...stringEnv(extraEnv) });
  const config = {};
  if (Object.keys(pins).length) config.mcp_servers = { SynaBun: { env: pins } };
  if (extended) config.model_context_window = Math.floor(Number(modelContextWindow));
  if (browserPolicy) Object.assign(config, browserPolicy.config);
  // The SDK is always told which Codex to start: the user's own installation.
  // SynaBun carries none, and left to itself the SDK would look for one inside
  // its own packages and report that as a broken install.
  if (!codexPath && CodexClass === Codex) {
    const error = new Error('Codex CLI not found. Codex is installed separately from SynaBun: install it, then run this again.');
    error.code = 'CODEX_NOT_INSTALLED';
    throw error;
  }
  const codex = new CodexClass({
    ...(codexPath ? { codexPathOverride: codexPath } : {}),
    env,
    config,
  });
  // The SDK reads `codex exec --json` with readline, which also breaks lines at
  // U+2028 / U+2029: a command printing one ended the run with "Failed to parse item".
  patchCodexLineSplitting(codex);
  const parent = dirname(cwd || process.cwd());
  const thread = codex.startThread({
    workingDirectory: cwd || process.cwd(),
    model: runModel || undefined,
    modelReasoningEffort: normalizeCodexEffort(effort),
    approvalPolicy: 'never',
    sandboxMode: codexSandboxModeFor({ permissionPolicy, capability }),
    skipGitRepoCheck: true,
    networkAccessEnabled: true,
    ...(task ? { webSearchMode: 'disabled' } : {}),
    additionalDirectories: parent && parent !== cwd ? [parent] : undefined,
  });
  let alive = true;
  let activeAbort = null;
  let activeTurn = null;
  // Every runTurn is its own `codex exec`, which numbers its items from item_0
  // again: the sidepanel keys a turn's items by this sequence.
  let providerTurn = 0;
  // Generated images already returned by an earlier turn, and when the thread began (its rollout's day).
  const mediaSeen = new Set();
  let threadStartedMs = 0;

  return {
    identity: () => ({ providerThreadId: thread.id, providerSessionId: thread.id }),
    isAlive: () => alive,
    describe: () => ({
      provider: 'codex', permissionPolicy, capability, sandboxMode: codexSandboxModeFor({ permissionPolicy, capability }),
      ...(task ? { browserPolicy: browserPolicy ? 'hook' : 'instructions' } : {}),
    }),
    async runTurn(prompt, meta = {}) {
      if (!alive) throw new Error('Codex native loop is closed');
      if (activeTurn) throw new Error('Codex native loop already has an active turn');
      providerTurn += 1;
      const turn = providerTurn;
      onEvent({
        provider: 'codex',
        runId,
        iteration: meta.iteration,
        providerTurn: turn,
        event: { type: 'synabun.user_prompt', text: String(prompt || '') },
      });
      activeAbort = new AbortController();
      activeTurn = (async () => {
        const turnOptions = { signal: activeAbort.signal };
        const schema = meta.outputSchema || outputSchema;
        // Codex takes strict schemas only: it gets a strict copy, and the answer is read back
        // against the caller's own.
        if (schema && typeof schema === 'object') turnOptions.outputSchema = strictCodexSchema(schema);
        const turnStartedMs = Date.now();
        if (!threadStartedMs) threadStartedMs = turnStartedMs;
        const streamed = await thread.runStreamed(prompt, turnOptions);
        let failure = null;
        let completed = false;
        let text = '';
        let usage = null;
        const media = [];
        try {
          for await (const event of streamed.events) {
            if (event?.type === 'thread.started' && event.thread_id) {
              onIdentity({ providerThreadId: event.thread_id, providerSessionId: event.thread_id });
            }
            const agentText = codexAgentMessageText(event);
            if (agentText !== null) text = agentText;
            const saved = codexStreamMedia(event);
            if (saved) media.push(saved);
            if (event?.type === 'turn.failed') failure = codexFailureMessage(event.error);
            if (event?.type === 'turn.completed') { completed = true; if (event.usage) usage = event.usage; }
            if (event?.type === 'error') failure = codexFailureMessage(event);
            onEvent({ provider: 'codex', runId, iteration: meta.iteration, providerTurn: turn, event });
          }
        } catch (error) {
          if (failure) throw new Error(failure, { cause: error });
          throw error;
        }
        if (failure) throw new Error(failure);
        if (!completed) throw new Error('Codex stream ended before turn.completed');
        const identity = { providerThreadId: thread.id, providerSessionId: thread.id };
        onIdentity(identity);
        // Image creation runs only. The stream carries no image tool items today (the rollout, or
        // generated_images/, does); either way only this thread's own saved files count.
        let found = [];
        if (collectMedia && thread.id) {
          try {
            found = ownCodexImages({ codexHome, threadId: thread.id, items: media });
            if (!found.length) found = await collectCodexMedia({ codexHome, threadId: thread.id, sinceMs: turnStartedMs - 1000, threadStartedMs });
          } catch { found = []; }
        }
        const fresh = found.filter((item) => !mediaSeen.has(item.path));
        for (const item of fresh) mediaSeen.add(item.path);
        // With an output schema the final message is the JSON itself.
        const structured = turnOptions.outputSchema ? codexStructuredOutput(text, schema) : null;
        return { ...identity, text, usage, result: { text, usage }, ...(structured ? { structured } : {}), ...(fresh.length ? { media: fresh } : {}) };
      })();
      try { return await activeTurn; }
      finally { activeTurn = null; activeAbort = null; }
    },
    async abort(reason = 'aborted') {
      if (activeAbort) activeAbort.abort(asAbortError(reason));
      return true;
    },
    async dispose() {
      alive = false;
      if (activeAbort) activeAbort.abort(asAbortError('disposed'));
    },
  };
}

/** Create one streaming-input Claude Agent SDK query for the whole loop. */
export async function createClaudeNativeLoopAdapter(options = {}) {
  const {
    runId, cwd, model, effort, browserSessionId, browserTabId,
    mcpUrl, onIdentity = () => {}, onEvent = () => {}, queryFactory = claudeQuery,
    includePartialMessages = process.platform !== 'win32',
    // Which Claude Code runs the loop: the answer of resolveClaudeSdkExecutable()
    // (lib/claude-executable.js), as the host worked it out. A caller without
    // one names the pieces instead: the cli-config override and the installed CLI.
    claudeExecutable = null, sdkExecutable = null, claudeBin = null, logWarn = console.warn,
    // Task-mode options (assistant dispatch).
    extraEnv = {}, permissionPolicy: rawPolicy = 'auto', permissionBroker = null,
    capability: rawCapability = 'full', maxBudgetUsd = null, outputSchema = null, runMode = 'loop',
    desktopGrantProvider = null,
  } = options;
  const permissionPolicy = normalizePermissionPolicy(rawPolicy);
  const capability = normalizeCapability(rawCapability);
  const askMode = permissionPolicy === 'ask' && typeof permissionBroker?.request === 'function';
  const input = createInputQueue();
  const abortController = new AbortController();
  let alive = true;
  let sessionId = null;
  let activeTurn = null;
  const env = stringEnv({
    ...cleanClaudeEnvironment(),
    SYNABUN_TERMINAL_SESSION: runId,
    SYNABUN_PROJECT: cwd ? memoryProject(cwd) : 'global',
    SYNABUN_PROFILE: 'full',
    SYNABUN_BROWSER_SESSION: browserSessionId,
    SYNABUN_BROWSER_TAB: browserTabId,
    SYNABUN_RUN_MODE: runMode === 'task' ? 'task' : undefined,
    ...stringEnv(extraEnv),
  });
  const brokerRequest = async (request) => {
    try {
      const reply = await permissionBroker.request({
        runId, provider: 'claude-code', signal: abortController.signal, ...request,
      });
      return reply && typeof reply === 'object' ? reply : { behavior: 'deny' };
    } catch (error) {
      return { behavior: 'deny', message: providerErrorMessage(error, 'Permission request failed') };
    }
  };
  const headers = stringEnv({
    'X-Synabun-Terminal': runId,
    'X-Synabun-Project': cwd ? memoryProject(cwd) : 'global',
    'X-Synabun-Memory-Session': runId,
    'X-Synabun-Browser-Session': browserSessionId,
    'X-Synabun-Browser-Tab': browserTabId,
    // Computer-use workers: the grant unlocks the `computer` MCP group.
    'X-Synabun-Desktop-Grant': typeof desktopGrantProvider === 'function' ? desktopGrantProvider() || undefined : undefined,
  });
  // Under 'ask' the orchestrator answers permission prompts (and AskUserQuestion
  // becomes a relayed question); otherwise the run is unattended and both
  // interactive tools stay denied. ExitPlanMode is never useful for a worker.
  const denyMatcher = askMode ? 'ExitPlanMode' : 'AskUserQuestion|ExitPlanMode';
  const denyMessage = askMode
    ? 'Dispatched workers do not use plan mode.'
    : 'This unattended automation cannot wait for interactive input.';
  const queryOptions = {
    cwd: cwd || process.cwd(),
    permissionMode: askMode ? 'default' : 'bypassPermissions',
    ...(askMode ? {} : { allowDangerouslySkipPermissions: true }),
    includePartialMessages: !!includePartialMessages,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    hooks: {
      PreToolUse: [{
        matcher: denyMatcher,
        hooks: [async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: denyMessage,
          },
        })],
      },
      // Assistant task runs: SynaBun's browser policy (browser-tool-policy.js)
      // on every call, subagents' included, before the bypass and canUseTool.
      ...(runMode === 'task' ? [{
        hooks: [async (input) => {
          const reason = browserToolDenial(input?.tool_name, input?.tool_input || {}, { host: 'claude', cwd: cwd || process.cwd() });
          return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
        }],
      }] : [])],
    },
    env,
    abortController,
    canUseTool: async (toolName, toolInput) => {
      if (toolName === 'ExitPlanMode') return { behavior: 'deny', message: denyMessage };
      if (toolName === 'AskUserQuestion') {
        if (!askMode) return { behavior: 'deny', message: denyMessage };
        const reply = await brokerRequest({ kind: 'ask', toolName, input: toolInput, questions: toolInput?.questions || [] });
        if (reply.behavior === 'allow') {
          const answers = reply.answers || reply.updatedInput?.answers || {};
          return { behavior: 'allow', updatedInput: { ...(toolInput || {}), answers } };
        }
        return { behavior: 'deny', message: reply.message || 'The question was not answered.' };
      }
      // Computer use is fully autonomous: its guards live in the desktop service,
      // so the orchestrator is never asked to approve individual actions.
      if (askMode && /^mcp__SynaBun__computer(_apps|_ax|_status)?$/.test(String(toolName))) return { behavior: 'allow', updatedInput: toolInput };
      if (askMode) {
        const reply = await brokerRequest({ kind: 'tool', toolName, input: toolInput });
        if (reply.behavior === 'allow') {
          const allowed = { behavior: 'allow', updatedInput: reply.updatedInput || toolInput };
          if (reply.updatedPermissions) allowed.updatedPermissions = reply.updatedPermissions;
          return allowed;
        }
        return { behavior: 'deny', message: reply.message || 'Denied by the orchestrator.' };
      }
      return { behavior: 'allow', updatedInput: toolInput };
    },
  };
  if (mcpUrl) queryOptions.mcpServers = { SynaBun: { type: 'http', url: mcpUrl, headers } };
  if (model) queryOptions.model = model;
  if (effort && CLAUDE_EFFORT_LEVELS.includes(effort)) queryOptions.effort = effort;
  if (capability === 'read-only') queryOptions.disallowedTools = [...CLAUDE_READ_ONLY_DISALLOWED_TOOLS];
  if (Number(maxBudgetUsd) > 0) queryOptions.maxBudgetUsd = Number(maxBudgetUsd);
  if (outputSchema && typeof outputSchema === 'object') queryOptions.outputFormat = { type: 'json_schema', schema: outputSchema };
  // The loop runs the user's own Claude Code: SynaBun carries none, and the SDK
  // is never left to look for one. The SDK uses pathToClaudeCodeExecutable
  // verbatim with no validation, so the path was vetted where it was resolved
  // (a bare command name would ENOENT under shell:false).
  //
  // Pre-flight only: an unattended loop has no one to prompt, and retries are
  // owned by native-loop-runtime.js. Without a Claude Code to start, the run
  // fails here, with the reason, instead of somewhere inside the first turn.
  const executable = claudeExecutable || resolveClaudeSdkExecutable({ launcher: claudeBin, sdkExecutable });
  if (executable.ignored) logWarn(`[native-loop] ignoring sdkExecutable override — ${executable.ignored}`);
  if (executable.path) {
    queryOptions.pathToClaudeCodeExecutable = executable.path;
  } else if (queryFactory === claudeQuery) {
    const error = new Error(executable.reason || CLAUDE_NOT_INSTALLED);
    error.code = 'CLAUDE_NOT_INSTALLED';
    throw error;
  }

  const q = queryFactory({ prompt: input, options: queryOptions });
  const deltaBuffer = new Map();
  const forwardEvent = (event) => onEvent({ provider: 'claude-code', runId, event });
  const flushDelta = (key) => {
    const slot = deltaBuffer.get(key);
    if (!slot) return;
    deltaBuffer.delete(key);
    clearTimeout(slot.timer);
    const inner = slot.event.event;
    const delta = inner.delta?.type === 'thinking_delta'
      ? { ...inner.delta, thinking: slot.text }
      : { ...inner.delta, text: slot.text };
    forwardEvent({ ...slot.event, event: { ...inner, delta } });
  };
  const flushDeltas = () => {
    for (const key of [...deltaBuffer.keys()]) flushDelta(key);
  };
  const emitEvent = (event) => {
    const inner = event?.type === 'stream_event' ? event.event : null;
    const isDelta = inner?.type === 'content_block_delta'
      && (inner.delta?.type === 'text_delta' || inner.delta?.type === 'thinking_delta');
    if (!isDelta) {
      flushDeltas();
      forwardEvent(event);
      return;
    }
    const key = `${event.parent_tool_use_id || ''}:${inner.index}`;
    let slot = deltaBuffer.get(key);
    if (!slot) {
      slot = { event, text: '', timer: null };
      slot.timer = setTimeout(() => flushDelta(key), 40);
      slot.timer.unref?.();
      deltaBuffer.set(key, slot);
    }
    slot.text += inner.delta.type === 'thinking_delta'
      ? (inner.delta.thinking || '')
      : (inner.delta.text || '');
  };
  // total_cost_usd is this CLI process's running total, not the turn's charge:
  // a warm task run reported $7.87 after turn 1 and $7.99 after a $0.12 turn 2.
  // A turn resolves with its own charge (costUsd) beside the total.
  let reportedCostUsd = 0;
  const turnCost = (event) => {
    const total = Number(event?.total_cost_usd);
    if (!Number.isFinite(total) || total <= 0) return { costUsd: 0, totalCostUsd: reportedCostUsd };
    // A smaller total is a fresh counter (a restarted process): it counts in full.
    const costUsd = total >= reportedCostUsd ? total - reportedCostUsd : total;
    reportedCostUsd = total;
    return { costUsd: Number(costUsd.toFixed(8)), totalCostUsd: total };
  };
  let pumpError = null;
  const pump = (async () => {
    try {
      for await (const event of q) {
        if (!alive) break;
        const eventSessionId = event?.session_id || null;
        if (eventSessionId && eventSessionId !== sessionId) {
          sessionId = eventSessionId;
          onIdentity({ providerSessionId: sessionId });
        }
        emitEvent(event);
        if (event?.type === 'result' && activeTurn) {
          const turn = activeTurn;
          activeTurn = null;
          const cost = turnCost(event);
          if (event.subtype === 'success') {
            turn.resolve({
              providerSessionId: sessionId,
              result: event,
              text: typeof event.result === 'string' ? event.result : '',
              usage: event.usage || null,
              costUsd: cost.costUsd,
              totalCostUsd: cost.totalCostUsd,
              structured: event.structured_output ?? null,
            });
          } else {
            const error = new Error((event.errors && event.errors[0]) || event.error || event.result || 'Claude turn failed');
            error.subtype = event.subtype || null;
            if (event.subtype === 'error_max_budget_usd') error.code = 'BUDGET_CAP';
            else if (event.subtype === 'error_max_turns') error.code = 'MAX_TURNS';
            error.costUsd = cost.costUsd;
            error.totalCostUsd = cost.totalCostUsd;
            error.usage = event.usage || null;
            turn.reject(error);
          }
        }
      }
    } catch (error) {
      pumpError = error;
    } finally {
      flushDeltas();
      if (alive) {
        alive = false;
        input.close();
        if (activeTurn) {
          const turn = activeTurn; activeTurn = null;
          turn.reject(pumpError || new Error('Claude session ended before the turn completed'));
        }
      }
    }
    if (pumpError) throw pumpError;
  })();
  pump.catch((error) => onEvent({
    provider: 'claude-code',
    runId,
    event: { type: 'synabun.error', message: error?.message || String(error) },
  }));

  return {
    identity: () => ({ providerSessionId: sessionId }),
    isAlive: () => alive,
    describe: () => ({ provider: 'claude-code', permissionPolicy, capability, askMode }),
    runTurn(prompt, meta = {}) {
      if (!alive) return Promise.reject(new Error('Claude native loop is closed'));
      if (activeTurn) return Promise.reject(new Error('Claude native loop already has an active turn'));
      onEvent({
        provider: 'claude-code',
        runId,
        event: { type: 'synabun.user_prompt', text: String(prompt || ''), iteration: meta.iteration },
      });
      return new Promise((resolveTurn, rejectTurn) => {
        activeTurn = { resolve: resolveTurn, reject: rejectTurn, iteration: meta.iteration };
        const ok = input.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
          parent_tool_use_id: null,
          session_id: sessionId || '',
        });
        if (!ok) {
          activeTurn = null;
          rejectTurn(new Error('Claude input stream is closed'));
        }
      });
    },
    async abort(reason = 'aborted') {
      if (activeTurn) {
        const turn = activeTurn; activeTurn = null;
        turn.reject(asAbortError(reason));
      }
      if (!alive) return true;
      try {
        await Promise.race([
          Promise.resolve(q.interrupt?.()),
          new Promise((resolveWait) => setTimeout(resolveWait, 1000)),
        ]);
      } catch {}
      return true;
    },
    async dispose() {
      if (activeTurn) {
        const turn = activeTurn; activeTurn = null;
        turn.reject(asAbortError('disposed'));
      }
      alive = false;
      input.close();
      flushDeltas();
      try { abortController.abort(asAbortError('disposed')); } catch {}
      await Promise.race([pump, new Promise((resolveWait) => setTimeout(resolveWait, 1000))]).catch(() => {});
    },
  };
}

/** Use a loop-owned OpenCode serve while retaining one native session. */
export async function createOpenCodeNativeLoopAdapter(options = {}) {
  const {
    runId, cwd, title, model, client, release = async () => {},
    onIdentity = () => {}, onEvent = () => {},
    permissionPolicy: rawPolicy = 'auto', permissionBroker = null,
    capability: rawCapability = 'full', outputSchema = null,
    // Task mode: an explicit OpenCode agent and the effort as a model variant.
    agent = null, effort = null, runMode = 'loop',
    // Image / video creation runs: 'image' | 'video' → each turn returns the files its model generated.
    collectMedia = null,
  } = options;
  if (!client?.session?.create || (!client?.session?.promptAsync && !client?.session?.prompt)) {
    throw new Error('OpenCode native loop requires an isolated SDK client');
  }
  const permissionPolicy = normalizePermissionPolicy(rawPolicy);
  const capability = normalizeCapability(rawCapability);
  const askMode = permissionPolicy === 'ask' && typeof permissionBroker?.request === 'function';
  let alive = true;
  let activeAbort = null;
  let activeTurn = null;
  const eventSource = client.onEvent ? client : client.event;
  let sessionId = null;
  // Assistant text assembled from the SSE stream (message.updated gives roles,
  // message.part.updated gives text parts keyed by message id).
  const messageRoles = new Map();
  const messageOrder = [];
  const textParts = new Map(); // messageID → Map(partID → text)
  const rememberMessage = (info) => {
    if (!info?.id) return;
    if (!messageRoles.has(info.id)) messageOrder.push(info.id);
    if (info.role) messageRoles.set(info.id, info.role);
    else if (!messageRoles.has(info.id)) messageRoles.set(info.id, null);
  };
  // Generated images / videos (`file` parts), kept only for image / video creation runs.
  const mediaParts = new Map(); // partID → { messageID, media }
  const mediaReturned = new Set();
  const rememberPart = (part) => {
    if (!part?.messageID) return;
    if (part.type === 'file') {
      const media = collectMedia ? openCodeMediaPart(part) : null;
      if (media) mediaParts.set(part.id || `${part.messageID}:${mediaParts.size}`, { messageID: part.messageID, media });
      return;
    }
    if (part.type !== 'text' || typeof part.text !== 'string') return;
    if (!messageRoles.has(part.messageID)) rememberMessage({ id: part.messageID, role: null });
    let parts = textParts.get(part.messageID);
    if (!parts) { parts = new Map(); textParts.set(part.messageID, parts); }
    parts.set(part.id || `${parts.size}`, part.text);
  };
  /** { media } with the generated files not returned yet (none: {}). */
  const turnMedia = (extraParts = []) => {
    for (const part of extraParts) rememberPart(part);
    const media = [];
    for (const [id, { messageID, media: item }] of mediaParts) {
      if (mediaReturned.has(id) || messageRoles.get(messageID) === 'user') continue;
      mediaReturned.add(id);
      media.push(item);
    }
    return media.length ? { media } : {};
  };
  const latestAssistantText = () => {
    for (let index = messageOrder.length - 1; index >= 0; index--) {
      const id = messageOrder[index];
      if (messageRoles.get(id) === 'user') continue;
      const parts = textParts.get(id);
      const text = parts ? [...parts.values()].join('\n').trim() : '';
      if (text) return text;
    }
    return '';
  };
  const fetchAssistantText = async () => {
    const local = latestAssistantText();
    if (local || typeof client.session?.messages !== 'function') return local;
    try {
      const response = await settleWithin(client.session.messages({ sessionID: sessionId, directory: cwd || undefined }), 5000);
      const rows = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
      for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index];
        if (row?.info?.role && row.info.role !== 'assistant') continue;
        const text = extractOpenCodeText(row);
        if (text) return text;
      }
    } catch {}
    return '';
  };
  const brokerRequest = async (request) => {
    try {
      const reply = await permissionBroker.request({ runId, provider: 'opencode', signal: activeAbort?.signal, ...request });
      return reply && typeof reply === 'object' ? reply : { behavior: 'deny' };
    } catch (error) {
      return { behavior: 'deny', message: providerErrorMessage(error, 'Permission request failed') };
    }
  };
  const settleActiveTurn = (error = null, payload = null) => {
    const turn = activeTurn;
    if (!turn || turn.mode !== 'async' || turn.settled) return;
    turn.settled = true;
    if (error) turn.reject(error);
    else turn.resolve({ providerSessionId: sessionId, ...(payload || {}) });
  };
  const finishTurnWithText = () => {
    const turn = activeTurn;
    if (!turn || turn.mode !== 'async' || turn.settled || turn.finishing) return;
    turn.finishing = true;
    fetchAssistantText()
      .then((text) => settleActiveTurn(null, { text, result: { text }, ...turnMedia() }))
      .catch(() => settleActiveTurn(null, { text: '', result: { text: '' }, ...turnMedia() }));
  };
  const unsubscribe = eventSource?.onEvent?.((envelope) => {
    const event = envelope?.event || {};
    const sid = event.sessionID || event.sessionId || event.part?.sessionID || event.info?.sessionID
      || event.info?.id || event.session?.id || null;
    const eventType = envelope?.eventType || '';
    if (!sessionId) return;
    if (sid && sid !== sessionId) {
      // Another session on the run's own isolated serve is a child (a `task` sub-agent): its
      // messages are forwarded for the usage meter only. Turn control, permissions and questions
      // stay with the run's own session.
      if (/^(message[.:]updated|session[.:](created|updated))$/i.test(eventType)) {
        onEvent({ provider: 'opencode', runId, eventType, event, childSession: true });
      }
      return;
    }
    if (/^message[.:]updated$/i.test(eventType)) rememberMessage(event.info || event.message?.info || null);
    if (/^message[.:]part[.:]updated$/i.test(eventType)) rememberPart(event.part || null);
    if (/question\.asked/i.test(eventType)) {
      const requestID = event.id || event.requestID;
      if (requestID && askMode && client.question?.reply) {
        brokerRequest({ kind: 'ask', toolName: 'question', input: event, questions: event.questions || [] })
          .then((reply) => {
            if (reply.behavior === 'allow') {
              return client.question.reply({ requestID, answers: reply.answers || [], directory: cwd || undefined });
            }
            return client.question?.reject?.({ requestID, directory: cwd || undefined });
          })
          .catch(() => {});
      } else if (requestID && client.question?.reject) {
        client.question.reject({ requestID, directory: cwd || undefined }).catch(() => {});
      }
    }
    if (/permission\.asked/i.test(eventType)) {
      const requestID = event.id || event.requestID || event.permissionID;
      if (requestID && askMode && client.permission?.reply) {
        brokerRequest({ kind: 'tool', toolName: event.permission || event.type || 'permission', input: event })
          .then((reply) => {
            const decision = reply.behavior === 'allow' ? (reply.always ? 'always' : 'once') : 'reject';
            return client.permission.reply({ requestID, reply: decision, directory: cwd || undefined });
          })
          .catch(() => {});
      } else if (requestID && client.permission?.reply) {
        client.permission.reply({ requestID, reply: 'always', directory: cwd || undefined }).catch(() => {});
      }
    }
    // promptAsync acknowledges immediately, so the durable SSE stream is the
    // source of truth for turn completion. This avoids holding a five-minute
    // synchronous fetch open and misclassifying a long, healthy turn as
    // `native:iteration-error | fetch failed`.
    const ownsTurnEvent = !!sid && sid === sessionId;
    if (ownsTurnEvent && /^session[.:]idle$/i.test(eventType)) finishTurnWithText();
    if (ownsTurnEvent && /^session[.:]error$/i.test(eventType)) {
      const detail = providerErrorMessage(
        event.error || event.info?.error || event.data?.error || event,
        'OpenCode session failed',
      );
      settleActiveTurn(new Error(String(detail)));
    }
    onEvent({ provider: 'opencode', runId, eventType, event });
  }) || (() => {});
  try {
    await client.waitUntilConnected?.(10_000);
    const created = await client.session.create({ directory: cwd || undefined, title: title || 'SynaBun automation' });
    sessionId = created?.data?.id || created?.data?.sessionID || created?.id || created?.sessionID;
    if (!sessionId) throw new Error('OpenCode did not return a session id');
    onIdentity({ providerSessionId: sessionId });
  } catch (error) {
    try { unsubscribe(); } catch {}
    await release().catch(() => {});
    throw error;
  }

  // What the serve stored, for the usage meter's reconcile at a turn's end (assistant-usage.js).
  // A call that fails, times out or is missing on an older serve throws: the caller then knows
  // the turn was not reconciled.
  const storedRows = async (method, id) => {
    if (typeof client.session?.[method] !== 'function') throw new Error(`OpenCode session.${method} is not available`);
    const response = await settleWithin(client.session[method]({ sessionID: id, directory: cwd || undefined }), 5000);
    if (!response || response.error) throw new Error(providerErrorMessage(response?.error, `OpenCode session.${method} did not answer`));
    const rows = Array.isArray(response.data) ? response.data : Array.isArray(response) ? response : null;
    if (!rows) throw new Error(`OpenCode session.${method} returned no list`);
    return rows;
  };

  return {
    identity: () => ({ providerSessionId: sessionId }),
    isAlive: () => alive,
    describe: () => ({ provider: 'opencode', permissionPolicy, capability, askMode }),
    /** { children(sessionId) → sessions, messages(sessionId) → [{ info }] } on this run's own serve. */
    usageFetchers: () => ({
      children: (id) => storedRows('children', id),
      messages: (id) => storedRows('messages', id),
    }),
    async runTurn(prompt, meta = {}) {
      if (!alive) throw new Error('OpenCode native loop is closed');
      if (activeTurn) throw new Error('OpenCode native loop already has an active turn');
      await client.waitUntilConnected?.(10_000);
      activeAbort = new AbortController();
      const request = {
        sessionID: sessionId,
        parts: [{ type: 'text', text: prompt }],
        model: normalizeOpenCodeModel(model),
        agent: capability === 'read-only' ? 'plan' : (agent ? String(agent) : 'build'),
        directory: cwd || undefined,
        signal: activeAbort.signal,
      };
      // Loops predate variants and may carry Claude-style effort names; only
      // assistant task runs (routed with catalog-validated efforts) send one.
      if (effort && runMode === 'task') request.variant = String(effort);
      const schema = meta.outputSchema || outputSchema;
      if (schema && typeof schema === 'object') request.format = { type: 'json_schema', schema };
      const validateResponse = (response) => {
        const assistantError = response?.data?.info?.error;
        if (response?.error || assistantError || (Number(response?.status) >= 400)) {
          const detail = providerErrorMessage(
            response?.error || assistantError || response?.data?.error,
            `OpenCode prompt failed (${response?.status || 'unknown status'})`,
          );
          throw new Error(String(detail));
        }
      };

      // Newer OpenCode serves expose promptAsync. Prefer it so an unattended
      // browser turn can run for as long as its loop budget without sitting
      // behind the SDK's synchronous fetch timeout. Retain the synchronous path
      // for older installed OpenCode versions.
      if (client.session.promptAsync) {
        let resolveTurn;
        let rejectTurn;
        const completion = new Promise((resolve, reject) => {
          resolveTurn = resolve;
          rejectTurn = reject;
        });
        // Abort may arrive while promptAsync's acknowledgement is still in
        // flight. Attach a handler immediately so that early rejection is not
        // reported as an unhandled promise before runTurn begins awaiting it.
        completion.catch(() => {});
        const turn = {
          mode: 'async', completion,
          resolve: resolveTurn, reject: rejectTurn, settled: false,
        };
        activeTurn = turn;
        try {
          const response = await client.session.promptAsync(request);
          validateResponse(response);
          return await completion;
        } finally {
          if (activeTurn === turn) activeTurn = null;
          activeAbort = null;
        }
      }

      const turn = { mode: 'sync' };
      activeTurn = turn;
      try {
        const response = await client.session.prompt(request);
        validateResponse(response);
        const text = extractOpenCodeText(response);
        const replyParts = Array.isArray(response?.data?.parts) && response?.data?.info?.role !== 'user' ? response.data.parts : [];
        return { providerSessionId: sessionId, text, result: { text }, ...turnMedia(replyParts) };
      } finally {
        if (activeTurn === turn) activeTurn = null;
        activeAbort = null;
      }
    },
    async abort(reason = 'aborted') {
      if (activeAbort) activeAbort.abort(asAbortError(reason));
      settleActiveTurn(asAbortError(reason));
      try {
        await settleWithin(client.session.abort({ sessionID: sessionId, directory: cwd || undefined }));
      } catch {}
      return true;
    },
    async dispose() {
      alive = false;
      if (activeAbort) activeAbort.abort(asAbortError('disposed'));
      settleActiveTurn(asAbortError('disposed'));
      try { unsubscribe(); } catch {}
      await settleWithin(release());
    },
  };
}
