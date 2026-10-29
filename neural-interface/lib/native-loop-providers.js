import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { externalServerInventory, selectExternalServers, codexMcpEnabledOverride, referenceClaudeMap, waitForClaudeMcpScope, redactMcpValues, writePrivateMcpConfig, mcpDefinitionValues } from './mcp-external-servers.js';
import { resolveStoredTools, runtimeToolsValue, readDefaultTools } from './tool-lists.js';
import { waitForSynabunTools, synabunToolsTimeoutText } from './opencode-mcp-ready.js';
import { config as memoryConfig, detectProject as memoryProject } from '../../mcp-server/dist/config.js';
import { Codex } from '@openai/codex-sdk';
import { CodexWorkerAppServer } from './codex-worker-app-server.js';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EFFORT_LEVELS } from './claude-model-catalog.js';
import { CLAUDE_NOT_INSTALLED, resolveClaudeSdkExecutable } from './claude-executable.js';
import { extractOpenCodeText } from './session-title-generator.js';
import { withServeEnv } from './opencode-protocol.js';
import { patchCodexLineSplitting } from './jsonl-lines.js';
import { dirname, join } from 'node:path';
import { codexReasoningEffort } from './effort-levels.js';
import { spawn as spawnProcess } from 'node:child_process';
import { codexStreamMedia, collectCodexMedia, openCodeMediaPart, ownCodexImages } from './assistant-media.js';
import { browserToolDenial } from './browser-tool-policy.js';
import { CODEX_BROWSER_POLICY_UNTRUSTED_NOTE, codexBrowserPolicyHook } from './assistant-route-gate-codex.js';
import { codexWindowsSandbox, codexWindowsSandboxConfig } from './agent-sandbox-elevation.js';
import { DRAFT_DISALLOWED_TOOLS, DRAFT_TOOLS, codexDraftOptions, draftOpenCodeDecision, draftPreToolUseHook, draftToolDecision, openCodeDraftConfig, resolveDraftConfinement } from './skills/draft-confinement.js';
import { EVAL_CONFINEMENT, codexEvalOptions, evalClaudeOptions, evalGitSafetyEnv, evalOpenCodeDecision, evalPreToolUseHook, evalToolDecision, openCodeEvalConfig, openCodeEvalEnv, placeOpenCodeEvalSkill, resolveEvalConfinement } from './skills/eval-confinement.js';
import { WORKER_GUARD_DEFAULT, codexSandboxFor, confinementEvent, openCodeCodeModeDecision, openCodeCodeModeNote, openCodePermissionDecision, openCodePermissionsFor, resolveWorkerConfinement, workerShellDecision, workerToolDecision } from './worker-confinement.js';

function nativeToolSelection(options, provider) { return resolveStoredTools(options, { source: options.runMode === 'task' ? 'dispatch' : 'launch', provider, defaultTools: options.runMode === 'task' ? undefined : readDefaultTools(memoryConfig.dataHome) }); }

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
// The owner's live data home (its real memory DB). A worker's shell must never inherit these: a temp server or a
// test suite started from the worker would otherwise open the owner's real store (a reviewer's temp boot did,
// briefly). The worker's own SynaBun MCP child gets the DB through its own env block / DOTENV_PATH (server.js
// buildCodexMcpEnv, the OpenCode serve config), not from the shell; the Claude worker's MCP is in-process HTTP and
// needs nothing here. Stripped for every worker (guarded and full alike): a worker never opens the live DB directly.
export const LIVE_DATA_ENV = Object.freeze(['SQLITE_DB_PATH', 'MEMORY_DATA_DIR']);

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

/** A confined run (lib/skills/draft-confinement.js) that cannot be set up on its provider: it never starts unconfined. */
function confinementUnsupportedError(provider, reason, what = 'a drafting folder') {
  const error = new Error(`${provider} cannot run confined to ${what}${reason ? ` (${reason})` : ''}: the run did not start.`);
  error.code = 'CONFINEMENT_UNSUPPORTED';
  return error;
}

/** Claude's built-in writers, kept off the tool list of an enforced read-only run (the hook refuses them too; Bash is the hook's). */
export const CLAUDE_READ_ONLY_WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * The worker confinement of a run (lib/worker-confinement.js), or null: capability full, the Protect workers
 * setting off, or a skill-drafting run (which has its own, stricter confinement). Throws when the working
 * directory cannot be resolved: the run must not start on a guess.
 */
function workerGuardFor({ capability, cwd, guardMode, scratchDir, confinement, serverPort = null, localPorts = null, localPortRange = null }) {
  if (confinement) return null;
  // Never rooted where the server runs: a run without a cwd is rooted at its scratch folder, or does not start.
  return resolveWorkerConfinement({ capability, cwd: cwd || null, mode: guardMode, scratchDir: scratchDir || null, serverPort, localPorts, localPortRange });
}
/** The port of SynaBun's own server, from a run's MCP address (a guarded worker's shell may not call it). */
function serverPortOf(mcpUrl, fallback = null) {
  try { const port = Number(new URL(String(mcpUrl)).port); if (port > 0) return port; } catch { /* no address */ }
  return Number(fallback) > 0 ? Number(fallback) : null;
}

/**
 * What an OpenCode run's own config carries for its confinement (server.js setupOpencodeLoopConfig): null for an
 * unguarded run (today's rules), else { permissions (OpenCode 2's rules), mcp: 'off'?, directMcp: true? }. A
 * skill-drafting run has no shell, web, subagent or skill tool and no MCP server; a guarded worker has the rules its
 * adapter answers by policy, and under Enforce no Code Mode: `directMcp` sets `codemode: false` on every MCP server of
 * the run's config, which OpenCode 2.1.4 otherwise reaches only through Code Mode's `execute` (denied by the rules).
 */
export function openCodeRunConfigFor(state = {}) {
  if (state.confinement?.kind === EVAL_CONFINEMENT) return openCodeEvalConfig({ role: state.confinement.role, shell: state.confinement.shell === true });
  if (state.confinement) return openCodeDraftConfig();
  const guard = workerGuardFor({ capability: normalizeCapability(state.capability), cwd: state.cwd, guardMode: state.guardMode ?? WORKER_GUARD_DEFAULT, scratchDir: state.scratchDir, confinement: null, serverPort: state.serverPort || null });
  if (!guard) return null;
  return { permissions: openCodePermissionsFor(guard), ...(guard.enforced ? { directMcp: true } : {}) };
}

/**
 * Whether an OpenCode run is a protected worker: an Assistant task worker with capability read-only or workspace
 * under Protect workers = Enforce (never a drafting or evaluation run, which have confinements of their own; never
 * Warn, Off or full). Its serve reads no project configuration (openCodeRunEnvFor) and keeps its password out of every
 * environment (server.js ensureIsolatedServe `hidePassword`: lib/opencode-protocol.js serveSpecFor passwordFrom
 * 'stdout'). Throws like resolveWorkerConfinement when a guarded run has no folder.
 */
export function openCodeProtectedWorker(state = {}) {
  if (state.confinement) return false;
  const guard = workerGuardFor({ capability: normalizeCapability(state.capability), cwd: state.cwd, guardMode: state.guardMode ?? WORKER_GUARD_DEFAULT, scratchDir: state.scratchDir, confinement: null, serverPort: state.serverPort || null });
  return !!guard?.enforced;
}

/**
 * What a protected worker's serve environment holds (openCodeProtectedWorker): no project configuration at all, so
 * nothing the worker writes in its folder runs in the serve (no opencode.json with plugins or MCP servers, no
 * .opencode plugin, agent, command or tool, no project AGENTS.md: OPENCODE_DISABLE_PROJECT_CONFIG, and
 * OPENCODE_CONFIG_PROJECT_DISABLE too, which OpenCode 2 reads first), and no inherited OPENCODE_CONFIG_DIR (OpenCode
 * reads that folder in place of the run's own configuration, whose rules, `codemode: false` and SynaBun MCP pin would
 * then be gone). Every inherited GIT_* variable is removed too: repository, index and object paths could point git
 * outside the folder, and GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT/KEY_n/VALUE_n could run an fsmonitor or pager.
 * `GIT_*: null` clears the prefix before deliberate settings are applied (lib/opencode-protocol.js withServeEnv).
 */
export const OPENCODE_PROTECTED_WORKER_ENV = Object.freeze({
  OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_CONFIG_DIR: null,
  'GIT_*': null,
});

/**
 * What an OpenCode run's serve environment carries for its confinement (server.js ensureIsolatedServe): an evaluation
 * run's (no project configuration, no file watcher, git's safety settings: lib/skills/eval-confinement.js
 * openCodeEvalEnv), a protected worker's (OPENCODE_PROTECTED_WORKER_ENV), else null. A value of null removes that
 * variable from the serve's environment. Throws when the evaluation folder cannot be resolved: the serve must not start
 * unconfined.
 */
export function openCodeRunEnvFor(state = {}) {
  if (state.confinement?.kind === EVAL_CONFINEMENT) return openCodeEvalEnv(resolveEvalConfinement(state.confinement, state.cwd));
  if (openCodeProtectedWorker(state)) return { ...OPENCODE_PROTECTED_WORKER_ENV };
  return null;
}

/**
 * An evaluation trial with the skill: its copy placed in the run's own OpenCode configuration folder (`configDir`,
 * server.js setupOpencodeLoopConfig's, removed with the run's serve), where OpenCode reads it as a global skill
 * (lib/skills/eval-confinement.js placeOpenCodeEvalSkill). → the folder, or null (not an evaluation, a baseline, a
 * grader). Throws when it cannot be placed: the run must not start without the skill it tests.
 */
export function openCodeEvalSkillFor(state = {}, configDir) {
  if (state.confinement?.kind !== EVAL_CONFINEMENT) return null;
  return placeOpenCodeEvalSkill(resolveEvalConfinement(state.confinement, state.cwd), configDir);
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
    browserTabId, onIdentity = () => {}, onEvent = () => {},
    CodexClass = Codex,
    extraEnv = {}, permissionPolicy: rawPolicy = 'auto', capability: rawCapability = 'full',
    outputSchema = null, desktopGrantProvider = null, modelContextWindow = null, contextMode = null,
    // Image creation runs (assistant dispatch): 'image' → each turn returns the images it generated.
    collectMedia = null,
    // Assistant task runs: the browser policy's hook and the run's notes (a function: never in the state file), and
    // the registered code projects its test runners may also run in (lib/browser-policy-roots.js, read as the run starts).
    runMode = 'loop', onNote = null, browserPolicyTrust = null, policyRoots = [],
    // Inherited variables to remove before extraEnv applies (the Codex account's launch:
    // lib/codex-accounts.js launchFor() — inherited OpenAI/Codex credentials never reach the run).
    unsetEnv = [],
    // The Admin sandbox setting when the run started (lib/agent-sandbox-elevation.js): the Windows
    // sandbox every `codex exec` of the thread may use. The run keeps it while it lives.
    adminSandbox = false,
    // A skill-drafting run's confinement (lib/skills/draft-confinement.js codexDraftOptions): the sandbox around the
    // workspace, no network, no MCP server.
    confinement = null,
    // The Protect workers setting as the run starts (lib/worker-confinement.js), the run's own scratch folder and
    // SynaBun's own port (a guarded worker's shell may not call it).
    guardMode = WORKER_GUARD_DEFAULT, scratchDir = null, serverPort = null, localPortRange = null,
  } = options;
  const permissionPolicy = normalizePermissionPolicy(rawPolicy);
  const capability = normalizeCapability(rawCapability);
  // Resolved before anything starts: a confinement that cannot be set up stops the run (never an unconfined start).
  let drafted = null;
  let evaluated = null;
  if (confinement?.kind === EVAL_CONFINEMENT) {
    // A skill-evaluation run (lib/skills/eval-confinement.js): the sandbox around its job folder (read-only for a
    // grader, a judge or a proposer), no network, no web search, every MCP server disabled.
    let held;
    try { held = resolveEvalConfinement(confinement, cwd); } catch (error) { throw confinementUnsupportedError('Codex', error?.message || error, 'an evaluation folder'); }
    evaluated = { held, ...codexEvalOptions(held, { codexHome, projectDir: cwd }) };
  } else if (confinement) {
    let confined;
    try { confined = resolveDraftConfinement(confinement, cwd); } catch (error) { throw confinementUnsupportedError('Codex', error?.message || error); }
    drafted = codexDraftOptions(confined, { codexHome, projectDir: cwd });
  }
  // Either confinement's options (the thread's sandbox and the config's MCP switches): one shape.
  const boxed = drafted || evaluated;
  const guard = boxed ? null : workerGuardFor({ capability, cwd, guardMode, scratchDir, confinement: null, serverPort, localPortRange });
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
    SYNABUN_TOOLS: runtimeToolsValue((() => { const list = nativeToolSelection(options, 'codex'); return list.items.includes('all') ? list.items : [...list.groups, ...list.servers]; })()),
    SYNABUN_TOOL_CATALOG_MODE: 'deferred',
    // Computer-use workers: the grant unlocks the `computer` group in the MCP child.
    SYNABUN_DESKTOP_GRANT: typeof desktopGrantProvider === 'function' ? desktopGrantProvider() || undefined : undefined,
  });
  const inherited = { ...process.env };
  for (const key of ['SYNABUN_PROFILE', 'SYNABUN_RUNTIME_PROFILE_PATH', 'SYNABUN_TOOLS', 'SYNABUN_TOOLS_PATH']) delete inherited[key];
  for (const key of Array.isArray(unsetEnv) ? unsetEnv : []) delete inherited[key];
  // A worker never holds a brain's launch credential (the Assistant's own identity) or an owner's page secret.
  delete inherited.SYNABUN_BRAIN_TOKEN;
  // The worker's shell must not inherit the owner's live-data paths (its MCP child gets them through its own
  // config: server.js buildCodexMcpEnv). A worker that boots a temp server or runs the suite stays off the live DB.
  for (const key of LIVE_DATA_ENV) delete inherited[key];
  // The hook reads the run's project and the other projects its test runners may run in (a JSON list) from its env.
  const policyEnv = browserPolicy ? { SYNABUN_BROWSER_POLICY_CWD: cwd || process.cwd(), SYNABUN_BROWSER_POLICY_ROOTS: JSON.stringify(Array.isArray(policyRoots) ? policyRoots : []) } : {};
  const env = withServeEnv(stringEnv({ ...inherited, ...pins, CODEX_HOME: codexHome, ...policyEnv, ...stringEnv(extraEnv) }), evaluated ? evalGitSafetyEnv(evaluated.held.root) : null);
  const config = { ...codexWindowsSandboxConfig(adminSandbox) };
  if (Object.keys(pins).length) config.mcp_servers = { SynaBun: { env: pins } };
  if (!boxed) {
    const inventory = externalServerInventory({ provider: 'codex', cwd, codexHome, env, home: env.HOME, dataHome: memoryConfig.dataHome, ...options.externalMcpContext });
    const list = nativeToolSelection(options, 'codex');
    const scope = selectExternalServers(list.servers, inventory);
    // Leaf overrides preserve native transports/env. Codex treats quotes in a
    // path literally; reject unaddressable names rather than launch a wider scope.
    for (const name of scope.disabled) {
      if (inventory.servers.find(row => row.name === name)?.reason === 'disabled-in-provider') continue;
      config[codexMcpEnabledOverride(name)] = false;
    }
  }
  // A drafting or evaluation run: every MCP server disabled (SynaBun's keeps its pins beside the switch; they never start).
  if (boxed) config.mcp_servers = { ...(config.mcp_servers || {}), ...Object.fromEntries(Object.entries(boxed.config.mcp_servers).map(([name, value]) => [name, { ...(config.mcp_servers?.[name] || {}), ...value }])) };
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
  const WorkerCodex = task && !boxed && CodexClass === Codex ? CodexWorkerAppServer : CodexClass;
  const codex = new WorkerCodex({
    onProcess: options.onProcess, signal: options.signal, apiKey: options.apiKey, configArgs: options.configArgs,
    ...(codexPath ? { codexPathOverride: codexPath } : {}),
    env,
    config,
  });
  // The SDK reads `codex exec --json` with readline, which also breaks lines at
  // U+2028 / U+2029: a command printing one ended the run with "Failed to parse item".
  patchCodexLineSplitting(codex);
  const parent = dirname(cwd || process.cwd());
  // The sandbox: a drafting run's (the workspace, no network); an enforced guard's (lib/worker-confinement.js
  // codexSandboxFor: read-only, or workspace-write with the working directory and the scratch folder, never the
  // parent folder); else today's (the capability's mode, the parent folder writable too).
  const sandboxed = guard?.enforced ? codexSandboxFor(guard, { parentDir: parent && parent !== cwd ? parent : null, scratchDir }) : null;
  // A guarded Codex worker (Protect workers = Enforce) runs with network OFF in Codex's own sandbox. Codex's
  // sandbox network is all-or-nothing (no per-host/loopback denial on this CLI), so SynaBun cannot wrap it in an
  // outer Seatbelt (nested sandbox-exec is refused): turning the network off is the only way its shell commands
  // (node -e, curl, a script) cannot reach SynaBun's own control port or any other local endpoint. The owner has
  // accepted that read-only / workspace Codex workers lose internet (HTTPS, npm, git fetch) for their shell. The
  // worker's SynaBun MCP child runs outside this command sandbox, so remember / recall / browser tools still work.
  const codexNetworkOff = !!(boxed || guard?.enforced);
  const threadOptions = {
    workingDirectory: cwd || process.cwd(),
    model: runModel || undefined,
    modelReasoningEffort: normalizeCodexEffort(effort),
    approvalPolicy: 'never',
    sandboxMode: boxed ? boxed.thread.sandboxMode : sandboxed ? sandboxed.sandboxMode : codexSandboxModeFor({ permissionPolicy, capability }),
    skipGitRepoCheck: true,
    networkAccessEnabled: !codexNetworkOff,
    ...(task || boxed ? { webSearchMode: 'disabled' } : {}),
    additionalDirectories: boxed ? undefined : sandboxed ? sandboxed.additionalDirectories : parent && parent !== cwd ? [parent] : undefined,
  };
  const thread = options.resumeThreadId ? codex.resumeThread(options.resumeThreadId, threadOptions) : codex.startThread(threadOptions);
  try { await thread.ready?.(); } catch (error) { await codex.dispose?.(); throw error; }
  if (thread.id) onIdentity({ providerThreadId: thread.id, providerSessionId: thread.id });
  let alive = true;
  let activeAbort = null;
  let activeTurn = null;
  // A guarded run says at its start what holds it: Codex's sandbox never reports to SynaBun by itself, so this is
  // the one place the note is written before any command (the run's notes, then its events).
  if (guard) {
    try { onNote?.(`worker confinement (${guard.mode}, capability ${guard.capability}): Codex sandbox ${sandboxed ? sandboxed.sandboxMode : codexSandboxModeFor({ permissionPolicy, capability })}${guard.enforced ? `, writable: ${guard.writable.join(', ')}` : ' as before (warn: what Enforce would refuse is noted)'}`); } catch {}
    // Network-off is the one way a Codex worker's shell cannot reach SynaBun's control port (Codex runs its own
    // sandbox, which SynaBun cannot wrap, and its network is all-or-nothing). Say it plainly, once, at the start.
    if (guard.enforced) { try { onNote?.('This protected Codex worker has NO internet for its shell commands: Codex\'s sandbox network is all-or-nothing, so to keep its commands off SynaBun\'s control port (and every local port) the network is off. HTTPS, npm install and git fetch will fail in the shell; your SynaBun MCP tools (remember, recall, browser) still work. A run that needs internet in its shell must use capability "full".'); } catch {} }
    else { try { onNote?.('warn mode: Enforce would also turn this Codex worker\'s shell network off (no internet), so its commands could not reach SynaBun\'s control port.'); } catch {} }
  }
  if (drafted) { try { onNote?.('skill-draft confinement: Codex sandbox workspace-write around the drafting folder, no network, no web search, every MCP server disabled; the shell stays, inside the sandbox'); } catch {} }
  if (evaluated) { try { onNote?.(`skill-eval confinement (${evaluated.held.role}): Codex sandbox ${evaluated.thread.sandboxMode} around the evaluation folder, no network, no web search, every MCP server disabled; the shell stays, inside the sandbox`); } catch {} }
  /**
   * A command Codex ran (item.completed command_execution): under warn, what Enforce would have refused is noted;
   * under enforce, a sandbox denial in its output is explained in SynaBun's words (Codex's sandbox refuses by itself
   * and says nothing to SynaBun).
   */
  const noteCommand = (item, meta) => {
    if (!guard || item?.type !== 'command_execution') return;
    const command = typeof item.command === 'string' ? item.command : Array.isArray(item.command) ? item.command.join(' ') : '';
    if (!command) return;
    const decision = workerShellDecision(command, guard);
    const output = String(item.aggregated_output || item.output || '');
    const denied = Number(item.exit_code) !== 0 && /operation not permitted|permission denied|read-only file system|sandbox|EPERM|EACCES|EROFS/i.test(output);
    if (!decision && !denied) return;
    const event = decision
      ? confinementEvent(decision, { tool: 'shell', confinement: guard, provider: 'codex' })
      : { type: 'synabun.confinement', action: 'refused', capability: guard.capability, tool: 'shell', rule: 'sandbox', reason: `Codex's sandbox refused "${command.slice(0, 160)}": this run (capability ${guard.capability}) writes inside ${guard.writable.join(', ')} only${guard.capability === 'read-only' ? ' (read-only: nothing at all, the temp folder included)' : ''}.`, provider: 'codex' };
    if (decision && guard.enforced && !denied) event.action = 'noted'; // the sandbox decides; the heuristic's view is a note
    onEvent({ provider: 'codex', runId, iteration: meta?.iteration, event });
  };
  // The sidepanel keys a turn's items by this sequence, including across a restart.
  // Scheduled SDK turns restart their item IDs; app-server workers keep their thread IDs.
  let providerTurn = Number(options.providerTurnBase) || 0;
  // Generated images already returned by an earlier turn, and when the thread began (its rollout's day).
  const mediaSeen = new Set();
  let threadStartedMs = 0;

  return {
    identity: () => ({ providerThreadId: thread.id, providerSessionId: thread.id }),
    isAlive: () => alive,
    describe: () => ({
      provider: 'codex', permissionPolicy, capability, sandboxMode: boxed ? boxed.thread.sandboxMode : sandboxed ? sandboxed.sandboxMode : codexSandboxModeFor({ permissionPolicy, capability }),
      networkOff: codexNetworkOff,
      windowsSandbox: codexWindowsSandbox(adminSandbox),
      ...(task ? { browserPolicy: browserPolicy ? 'hook' : 'instructions' } : {}),
      ...(drafted ? { confinement: 'skill-draft', root: cwd } : {}),
      ...(evaluated ? { confinement: EVAL_CONFINEMENT, role: evaluated.held.role, root: cwd } : {}),
      ...(guard ? { guard: { mode: guard.mode, capability: guard.capability, writable: [...guard.writable] } } : {}),
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
            if (event?.type === 'item.completed') { try { noteCommand(event.item, meta); } catch { /* a note, never the turn */ } }
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
      await codex.dispose?.();
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
    // Inherited variables to remove before extraEnv applies (the Claude account's launch:
    // credentials the server was started with never reach a worker).
    unsetEnv = [],
    // The host's last word on the environment: on Windows the Git Bash it names (lib/git-bash/).
    childEnv = null,
    // A skill-drafting run (lib/skills/draft-confinement.js): file tools in its folder only, nothing else.
    confinement = null,
    // The Protect workers setting as the run starts (lib/worker-confinement.js), the run's own scratch folder and
    // SynaBun's own port (a guarded worker's shell may not call it; read from mcpUrl when not given).
    guardMode = WORKER_GUARD_DEFAULT, scratchDir = null, serverPort = null, localPortRange = null,
    // Assistant task runs: the registered code projects the browser policy lets test runners run in besides the
    // run's own (lib/browser-policy-roots.js, read as the run starts).
    policyRoots = [],
    // A run resumed after a server restart (assistant-dispatch.js resumeRun): the Claude session to continue, and the
    // cost counter the resumed CLI starts from (it restores its total from the transcript's last `cost-state` line,
    // lib/worker-resume.js readCostState), so the first turn after it is charged only for itself.
    resumeSessionId = null, costBaseUsd = 0,
    // Told the CLI's process once it is spawned ({ pid, startedAt, command }): a run that outlives this server is
    // found by it (the next start ends an orphan before it resumes the session).
    onProcess = null,
  } = options;
  const permissionPolicy = normalizePermissionPolicy(rawPolicy);
  const capability = normalizeCapability(rawCapability);
  // Resolved before anything starts: a confinement that cannot be set up stops the run (never an unconfined start).
  let evaluated = null;
  if (confinement?.kind === EVAL_CONFINEMENT) {
    try { evaluated = resolveEvalConfinement(confinement, cwd); } catch (error) { throw confinementUnsupportedError('Claude Code', error?.message || error, 'an evaluation folder'); }
  }
  const confined = confinement && !evaluated ? resolveDraftConfinement(confinement, cwd) : null;
  // Either confinement (drafting, evaluation): no worker guard, nothing asked, never bypassPermissions.
  const held = confined || evaluated;
  const evalOptions = evaluated ? evalClaudeOptions(evaluated) : null;
  // The worker confinement of a read-only / workspace run: a PreToolUse hook on every call (subagents' included),
  // which Claude Code runs before any permission mode, so the run keeps bypassPermissions and nothing waits.
  const guard = workerGuardFor({ capability, cwd, guardMode, scratchDir, confinement: held, serverPort: serverPortOf(mcpUrl, serverPort), localPortRange });
  const askMode = !held && permissionPolicy === 'ask' && typeof permissionBroker?.request === 'function';
  const input = createInputQueue();
  const abortController = new AbortController();
  let alive = true;
  let sessionId = null;
  let activeTurn = null;
  const inherited = cleanClaudeEnvironment();
  for (const key of ['SYNABUN_PROFILE', 'SYNABUN_RUNTIME_PROFILE_PATH', 'SYNABUN_TOOLS', 'SYNABUN_TOOLS_PATH']) delete inherited[key];
  for (const key of Array.isArray(unsetEnv) ? unsetEnv : []) delete inherited[key];
  // A worker never holds a brain's launch credential (the Assistant's own identity) or an owner's page secret.
  delete inherited.SYNABUN_BRAIN_TOKEN;
  // The worker's shell must not inherit the owner's live-data paths: a Claude worker's MCP is in-process HTTP (it
  // reaches the DB through the Neural Interface, never from this env), so nothing here needs them.
  for (const key of LIVE_DATA_ENV) delete inherited[key];
  const ownEnv = stringEnv({
    ...inherited,
    SYNABUN_TERMINAL_SESSION: runId,
    SYNABUN_PROJECT: cwd ? memoryProject(cwd) : 'global',
    SYNABUN_BROWSER_SESSION: browserSessionId,
    SYNABUN_BROWSER_TAB: browserTabId,
    SYNABUN_RUN_MODE: runMode === 'task' ? 'task' : undefined,
    ...stringEnv(extraEnv),
  });
  // Apply after every inherited/child environment overlay: drop ALL GIT_* first, then SynaBun's own safety entries.
  const env = withServeEnv(typeof childEnv === 'function' ? stringEnv(childEnv(ownEnv)) : ownEnv, evalOptions?.env);
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
    'X-Synabun-Tools': runtimeToolsValue(resolveStoredTools(options, { source: options.runMode === 'task' ? 'dispatch' : 'launch', provider: 'claude-code' }).groups),
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
  // A confined run asks canUseTool for every write (permission mode 'default') on top of its PreToolUse hook, and
  // loads no settings file: no user hooks (they would ask it for memories it has no tool to write), no allow rules.
  const bypass = !askMode && !held;
  // The guard's decision on a tool call: refused (enforce) or noted (warn), always written into the run's events.
  const guardHook = guard ? async (input) => {
    const decision = workerToolDecision(input?.tool_name, input?.tool_input || {}, guard);
    if (!decision) return {};
    onEvent({ provider: 'claude-code', runId, event: confinementEvent(decision, { tool: input?.tool_name, confinement: guard, provider: 'claude-code' }) });
    if (!guard.enforced) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } };
  } : null;
  const queryOptions = {
    cwd: cwd || process.cwd(),
    permissionMode: bypass ? 'bypassPermissions' : 'default',
    ...(bypass ? { allowDangerouslySkipPermissions: true } : {}),
    includePartialMessages: !!includePartialMessages,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    // A drafting run and every evaluation run read no settings file at all (an evaluation's skill under test comes as
    // its one plugin, below); everything else the user's, the project's and the local ones.
    settingSources: evalOptions ? evalOptions.settingSources : confined ? [] : ['user', 'project', 'local'],
    hooks: {
      PreToolUse: [
      // A skill-drafting run: every call, before any permission mode (lib/skills/draft-confinement.js).
      ...(confined ? [{ hooks: [draftPreToolUseHook(confined)] }] : []),
      // A skill-evaluation run: every call, the same way (lib/skills/eval-confinement.js).
      ...(evaluated ? [{ hooks: [evalPreToolUseHook(evaluated)] }] : []),
      // A guarded worker (capability read-only / workspace): every call, subagents' included (lib/worker-confinement.js).
      ...(guardHook ? [{ hooks: [guardHook] }] : []),
      {
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
          const reason = browserToolDenial(input?.tool_name, input?.tool_input || {}, { host: 'claude', cwd: cwd || process.cwd(), roots: policyRoots });
          return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
        }],
      }] : [])],
    },
    env,
    abortController,
    canUseTool: async (toolName, toolInput) => {
      if (confined) {
        const reason = draftToolDecision(toolName, toolInput, confined);
        return reason ? { behavior: 'deny', message: reason } : { behavior: 'allow', updatedInput: toolInput };
      }
      if (evaluated) {
        const reason = evalToolDecision(toolName, toolInput, evaluated);
        return reason ? { behavior: 'deny', message: reason } : { behavior: 'allow', updatedInput: toolInput };
      }
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
  if (confined) {
    // No MCP server at all (SynaBun's or the user's: strict), and only the file tools.
    queryOptions.mcpServers = {};
    queryOptions.strictMcpConfig = true;
    queryOptions.tools = [...DRAFT_TOOLS];
    queryOptions.disallowedTools = [...DRAFT_DISALLOWED_TOOLS];
  } else if (evalOptions) {
    // No MCP server at all, the role's tools only, and the skills it may use: the one under test (a baseline: none),
    // loaded as the run's one local plugin; no hook of any settings file, plugin or skill and no inline shell.
    queryOptions.mcpServers = {};
    queryOptions.strictMcpConfig = true;
    queryOptions.tools = [...evalOptions.tools];
    queryOptions.disallowedTools = [...evalOptions.disallowedTools];
    queryOptions.skills = [...evalOptions.skills];
    queryOptions.settings = { ...evalOptions.settings };
    if (evalOptions.plugins.length) queryOptions.plugins = evalOptions.plugins.map((plugin) => ({ ...plugin }));
  } else if (mcpUrl) queryOptions.mcpServers = { SynaBun: { type: 'http', url: mcpUrl, headers } };
  let externalScopeNames = [];
  let externalValues = [];
  let privateMcpServers = null;
  let privateMcpDir = null;
  if (!held) {
    const inventory = externalServerInventory({ provider: 'claude-code', cwd, env, home: env.HOME, dataHome: memoryConfig.dataHome, ...options.externalMcpContext });
    const list = nativeToolSelection(options, 'claude-code');
    const scope = selectExternalServers(list.servers, inventory);
    const definitions = Object.fromEntries(scope.names.map(name => [name, inventory.definitionFor(name)]));
    if (mcpUrl) definitions.SynaBun = { type: 'http', url: mcpUrl, headers };
    const referenced = referenceClaudeMap(definitions, env);
    queryOptions.mcpServers = referenced.mcpServers;
    queryOptions.strictMcpConfig = true;
    Object.assign(env, referenced.env);
    // OAuth and dynamic header helpers are not expanded by the CLI's generic ${VAR} pass.
    // Keep them intact in a private file; the SDK's JSON is replaced before the OS spawn boundary.
    privateMcpServers = structuredClone(referenced.mcpServers);
    for (const [name, definition] of Object.entries(definitions)) {
      if (definition.oauth) privateMcpServers[name].oauth = structuredClone(definition.oauth);
      if (definition.headersHelper) privateMcpServers[name].headersHelper = definition.headersHelper;
    }
    externalValues = [...Object.values(referenced.env), ...mcpDefinitionValues(definitions)];
    externalScopeNames = Object.keys(definitions);
  }
  if (model) queryOptions.model = model;
  if (effort && CLAUDE_EFFORT_LEVELS.includes(effort)) queryOptions.effort = effort;
  // Read-only: with the guard enforced the shell stays, limited to read-only commands by the hook, and only the
  // built-in writers are off the list; otherwise (warn, off) today's list, Bash included.
  if (capability === 'read-only' && !held) queryOptions.disallowedTools = guard?.enforced ? [...CLAUDE_READ_ONLY_WRITE_TOOLS] : [...CLAUDE_READ_ONLY_DISALLOWED_TOOLS];
  if (Number(maxBudgetUsd) > 0) queryOptions.maxBudgetUsd = Number(maxBudgetUsd);
  if (outputSchema && typeof outputSchema === 'object') queryOptions.outputFormat = { type: 'json_schema', schema: outputSchema };
  // A run resumed after a server restart continues its own Claude session. A tool call the restart cut off is in its
  // transcript without a result: the CLI records it as interrupted (outcome unknown) and the next call goes through.
  if (resumeSessionId) queryOptions.resume = String(resumeSessionId);
  // The CLI's process is spawned here, not inside the SDK, so its pid is known: a server shutdown ends it at once
  // (endProcess), and the next start can tell an orphan from another program. Left to the SDK, a CLI whose server
  // went down only gets its stdin closed: it finishes the tool call in progress (a minute of `sleep` measured) and
  // keeps writing to its transcript, because the SDK's SIGTERM waits 2 s on a timer that dies with the server. The
  // SDK reads no stderr from a process it did not spawn: it is drained here, its tail kept for a failure's message.
  let child = null;
  let stderrTail = '';
  let terminating = false;
  queryOptions.spawnClaudeCodeProcess = (spawnOptions) => {
    if (!alive || abortController.signal.aborted) throw Object.assign(new Error('Claude MCP launch was stopped'), { code: 'MCP_SCOPE_UNENFORCED' });
    const args = [...spawnOptions.args];
    if (privateMcpServers) for (let index = 0; index < args.length - 1; index++) if (args[index] === '--mcp-config') {
      privateMcpDir ||= mkdtempSync(join(tmpdir(), 'synabun-claude-mcp-'));
      args[index + 1] = writePrivateMcpConfig(join(privateMcpDir, 'mcp.json'), privateMcpServers);
    }
    const proc = (options.spawnFactory || spawnProcess)(spawnOptions.command, args, {
      cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child = proc;
    proc.stderr?.setEncoding?.('utf8');
    proc.stderr?.on('data', (chunk) => { stderrTail = redactMcpValues(`${stderrTail}${chunk}`, externalValues).slice(-2048); });
    proc.stderr?.on('error', () => {});
    if (proc.pid) { try { onProcess?.({ pid: proc.pid, startedAt: new Date().toISOString(), command: String(spawnOptions.command || '') }); } catch { /* a note, never the run */ } }
    return proc;
  };
  const processEnded = () => !child || child.exitCode !== null || (child.signalCode !== null && child.signalCode !== undefined);
  /**
   * End the CLI now (a server shutdown): SIGTERM, which makes it stop the tool call in progress (its process tree
   * included), record that call's result and its cost state, and exit within a second; SIGKILL when it has not exited
   * by `graceMs` (a killed CLI leaves its tool's processes behind, so it is the fallback only). Windows has no SIGTERM
   * (a signal stops the CLI alone, and a dev server its tool started keeps its port): the tree is ended with taskkill.
   * The CLI writes no cost state then; the resume reads what the CLI restores either way (lib/worker-resume.js).
   */
  async function endProcess(graceMs = 1500) {
    const proc = child;
    if (!proc || processEnded()) return;
    const exited = new Promise((resolveExit) => { proc.once('exit', () => resolveExit()); });
    if (process.platform === 'win32') {
      try { spawnProcess('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on?.('error', () => {}); } catch { /* gone */ }
    } else {
      try { proc.kill('SIGTERM'); } catch { /* gone */ }
    }
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, Math.max(100, graceMs)))]);
    if (processEnded()) return;
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 500))]);
  }
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

  let q;
  try { q = queryFactory({ prompt: input, options: queryOptions }); }
  catch (error) { if (privateMcpDir) rmSync(privateMcpDir, { recursive: true, force: true }); throw error; }
  const deltaBuffer = new Map();
  const forwardEvent = (event) => onEvent({ provider: 'claude-code', runId, event: redactMcpValues(event, externalValues) });
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
  // A turn resolves with its own charge (costUsd) beside the total. A resumed
  // session's CLI starts from the total its transcript recorded (costBaseUsd).
  let reportedCostUsd = Math.max(0, Number(costBaseUsd) || 0);
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
      for await (const rawEvent of q) {
        const event = redactMcpValues(rawEvent, externalValues);
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
      // A process that exited is reported without what it said on stderr (the SDK keeps that only for a process it
      // spawned itself): its tail goes with the message.
      const message = String(error?.message || '');
      if (stderrTail.trim() && /Claude Code process (exited|terminated)/.test(message) && !/stderr:/.test(message)) {
        try { error.message = `${message}. stderr: ${stderrTail.trim().slice(-1000)}`; } catch { /* read-only message */ }
      }
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
  pump.catch((error) => {
    // dispose() aborts the query when the run ends, however it ended, and the
    // SDK throws "Claude Code process aborted by user" for it: not a failure.
    // Neither is the exit of a CLI a server shutdown ended (dispose with terminate).
    if (abortController.signal.aborted || terminating) return;
    onEvent({
      provider: 'claude-code',
      runId,
      event: { type: 'synabun.error', message: error?.message || String(error) },
    });
  });

  return {
    identity: () => ({ providerSessionId: sessionId }),
    isAlive: () => alive,
    // The CLI's process while it runs ({ pid }), else null.
    processInfo: () => (child?.pid && !processEnded() ? { pid: child.pid } : null),
    describe: () => ({ provider: 'claude-code', permissionPolicy, capability, askMode, ...(held ? { confinement: held.kind, root: held.root, ...(evaluated ? { role: evaluated.role, skills: [...evalOptions.skills], plugins: evalOptions.plugins.map((plugin) => plugin.path) } : {}) } : {}), ...(guard ? { guard: { mode: guard.mode, capability: guard.capability, writable: [...guard.writable] } } : {}) }),
    async runTurn(prompt, meta = {}) {
      if (!held) {
        try { await waitForClaudeMcpScope(q, externalScopeNames); }
        catch { input.close(); q.close?.(); await endProcess(); throw Object.assign(new Error('Claude MCP scope could not be enforced before the first turn'), { code: 'MCP_SCOPE_UNENFORCED' }); }
      }
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
    // `terminate` (a server shutdown, lib/native-loop-runtime.js): the CLI is ended before the query is closed
    // (endProcess), so nothing of it outlives the server. The events it sends while it stops (the cut-off tool call's
    // result) still reach the run; its exit is not reported as a failure.
    async dispose(options = {}) {
      if (activeTurn) {
        const turn = activeTurn; activeTurn = null;
        turn.reject(asAbortError('disposed'));
      }
      if (options?.terminate === true) {
        terminating = true;
        await endProcess(Number(options.graceMs) > 0 ? Number(options.graceMs) : 1500);
      }
      alive = false;
      input.close();
      flushDeltas();
      try { abortController.abort(asAbortError('disposed')); } catch {}
      await Promise.race([pump, new Promise((resolveWait) => setTimeout(resolveWait, 1000))]).catch(() => {});
      if (privateMcpDir) { rmSync(privateMcpDir, { recursive: true, force: true }); privateMcpDir = null; }
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
    // A skill-drafting run's confinement (lib/skills/draft-confinement.js openCodeDraftConfig): the serve's config has
    // no shell, web, subagent or skill tool and no MCP server; every edit is asked and answered inside the folder.
    confinement = null,
    // The Protect workers setting as the run starts (lib/worker-confinement.js), the run's own scratch folder,
    // SynaBun's own port, the run's own serve port and the band SynaBun keeps for its serves (a guarded worker's shell
    // may call none of them).
    guardMode = WORKER_GUARD_DEFAULT, scratchDir = null, serverPort = null, localPortRange = null, servePort = null,
    onNote = null,
  } = options;
  if (!client?.session?.create || (!client?.session?.promptAsync && !client?.session?.prompt)) {
    throw new Error('OpenCode native loop requires an isolated SDK client');
  }
  const permissionPolicy = normalizePermissionPolicy(rawPolicy);
  const capability = normalizeCapability(rawCapability);
  // Resolved before anything starts: a confinement that cannot be set up stops the run (never an unconfined start).
  let confined = null;
  let evaluated = null;
  if (confinement?.kind === EVAL_CONFINEMENT) {
    try { evaluated = resolveEvalConfinement(confinement, cwd); } catch (error) { throw confinementUnsupportedError('OpenCode', error?.message || error, 'an evaluation folder'); }
  } else if (confinement) {
    try { confined = resolveDraftConfinement(confinement, cwd); } catch (error) { throw confinementUnsupportedError('OpenCode', error?.message || error); }
  }
  const held = confined || evaluated;
  const guard = workerGuardFor({ capability, cwd, guardMode, scratchDir, confinement: held, serverPort, localPorts: servePort ? [servePort] : null, localPortRange });
  const askMode = !held && permissionPolicy === 'ask' && typeof permissionBroker?.request === 'function';
  // Code Mode (lib/worker-confinement.js OPENCODE_CODE_MODE_TOOL): off under Enforce, noted call by call under Warn.
  if (guard) { try { onNote?.(openCodeCodeModeNote(guard)); } catch {} }
  const codeModeCalls = new Set();
  const noteCodeModeCall = (part) => {
    if (!guard || part?.type !== 'tool') return;
    const decision = openCodeCodeModeDecision(part.tool, guard);
    const callID = part.callID || part.id || '';
    if (!decision || codeModeCalls.has(callID)) return;
    codeModeCalls.add(callID);
    onEvent({ provider: 'opencode', runId, eventType: 'synabun.confinement', event: confinementEvent(decision, { tool: part.tool, confinement: guard, provider: 'opencode' }) });
  };
  // An external_directory ask identifies its originating call, not whether it reads or writes. Resolve that exact
  // message/call pair from SSE or the message API; never infer a read from the requested path or arbitrary metadata.
  const permissionTools = new Map();
  const rememberPermissionTool = (part) => {
    if (part?.type === 'tool' && part.messageID && part.callID && part.tool) permissionTools.set(`${part.messageID}:${part.callID}`, part.tool);
  };
  const permissionToolName = async (event) => {
    const { messageID, callID } = event?.tool || {};
    if (!messageID || !callID) return null;
    const key = `${messageID}:${callID}`;
    if (!permissionTools.has(key) && typeof client.session?.message === 'function') {
      try {
        const row = await settleWithin(client.session.message({ sessionID: sessionId, messageID, directory: cwd || undefined }), 5000);
        for (const part of row?.data?.parts || []) if (part.messageID === messageID) rememberPermissionTool(part);
      } catch { /* unknown calls fail closed */ }
    }
    return permissionTools.get(key) || null;
  };
  /**
   * A permission ask under the run's confinement: { reply: 'once' | 'reject', message }, the decision written into
   * the run's events. A refusal carries its reason as the reply's message: OpenCode hands it to the model as the
   * tool's error (a reject without a message is what OpenCode's own client follows with an interrupt).
   */
  const policyReply = async (event) => {
    if (evaluated) {
      const reason = evalOpenCodeDecision(event, evaluated);
      if (!reason) return { reply: 'once' };
      onEvent({ provider: 'opencode', runId, eventType: 'synabun.confinement', event: { type: 'synabun.confinement', action: 'refused', capability: 'workspace', tool: event.permission || event.type || 'permission', rule: 'skill-eval', reason, provider: 'opencode' } });
      return { reply: 'reject', message: reason };
    }
    if (confined) {
      const reason = draftOpenCodeDecision(event, confined);
      if (!reason) return { reply: 'once' };
      onEvent({ provider: 'opencode', runId, eventType: 'synabun.confinement', event: { type: 'synabun.confinement', action: 'refused', capability: 'workspace', tool: event.permission || event.type || 'permission', rule: 'skill-draft', reason, provider: 'opencode' } });
      return { reply: 'reject', message: reason };
    }
    if (guard) {
      const toolName = String(event?.permission || event?.type || '').toLowerCase() === 'external_directory' ? await permissionToolName(event) : null;
      const decision = openCodePermissionDecision(event, guard, { toolName });
      if (!decision) return { reply: 'once' };
      onEvent({ provider: 'opencode', runId, eventType: 'synabun.confinement', event: confinementEvent(decision, { tool: event.permission || event.type || 'permission', confinement: guard, provider: 'opencode' }) });
      return guard.enforced ? { reply: 'reject', message: decision.reason } : { reply: 'once' };
    }
    // Unattended and unguarded: allowed, one call at a time. Never "always": OpenCode 2 saves an "always" answer for
    // the whole project (GET /api/permission/saved), where it would stop the user's own sessions there from asking.
    return { reply: 'once' };
  };
  let alive = true;
  let activeAbort = null;
  let activeTurn = null;
  const eventSource = client.onEvent ? client : client.event;
  let sessionId = null;
  // Assistant text assembled from the SSE stream (message.updated gives roles,
  // message.part.updated gives text parts keyed by message id, message.part.delta
  // the text a part grows by between them).
  const messageRoles = new Map();
  const messageOrder = [];
  const textParts = new Map(); // messageID → Map(partID → text)
  const textPartMessages = new Map(); // partID of a text part → its messageID (where a delta goes)
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
    if (part.id) textPartMessages.set(part.id, part.messageID);
    parts.set(part.id || `${parts.size}`, part.text);
  };
  // A delta of an announced text part extends it (OpenCode 2 streams text only this way until the part ends).
  const rememberDelta = (event) => {
    if (!event?.partID || (event.field && event.field !== 'text') || typeof event.delta !== 'string' || !event.delta) return;
    const messageID = textPartMessages.get(event.partID);
    if (!messageID || (event.messageID && event.messageID !== messageID)) return;
    rememberPart({ id: event.partID, messageID, type: 'text', text: `${textParts.get(messageID)?.get(event.partID) || ''}${event.delta}` });
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
    if (!turn || turn.mode !== 'async' || turn.sent === false || turn.settled || turn.finishing) return;
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
    if (/^message[.:]part[.:]updated$/i.test(eventType)) { rememberPart(event.part || null); rememberPermissionTool(event.part); noteCodeModeCall(event.part); }
    if (/^message[.:]part[.:]delta$/i.test(eventType)) rememberDelta(event);
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
        // Unattended: by the run's confinement (a drafting run, a guarded worker), else allowed once.
        policyReply(event).then((answer) => {
          if (!alive) return;
          return client.permission.reply({ requestID, reply: answer.reply, ...(answer.message ? { message: answer.message } : {}), directory: cwd || undefined });
        }).catch(() => {});
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
  // The rules of a confined run ride the session too (lib/opencode2-client.js session.create sends them as the
  // session's own `permissions`), on top of the serve's config.
  const sessionRules = confined ? openCodeDraftConfig().permissions : evaluated ? openCodeEvalConfig(evaluated).permissions : guard ? openCodePermissionsFor(guard) : null;
  try {
    await client.waitUntilConnected?.(10_000);
    const created = options.resumeSessionId
      ? await client.session.get({ sessionID: options.resumeSessionId })
      : await client.session.create({ directory: cwd || undefined, title: title || 'SynaBun automation', ...(sessionRules ? { permission: sessionRules } : {}) });
    if (created?.error) throw new Error(`OpenCode session unavailable: ${providerErrorMessage(created.error)}`);
    sessionId = created?.data?.id || created?.data?.sessionID || created?.id || created?.sessionID;
    if (!sessionId) throw new Error('OpenCode did not return a session id');
    if (options.resumeSessionId && sessionId !== options.resumeSessionId) throw new Error('OpenCode returned a different session on resume');
    if (options.resumeSessionId && sessionRules) {
      if (!client.session.update) throw new Error('OpenCode cannot restore the worker permission rules');
      const updated = await client.session.update({ sessionID: sessionId, permission: sessionRules });
      if (!updated || updated.error) throw new Error('OpenCode could not restore the worker permission rules');
    }
    onIdentity({ providerSessionId: sessionId });
  } catch (error) {
    try { unsubscribe(); } catch {}
    await release().catch(() => {});
    throw error;
  }

  // What the serve stored, for the usage meter's reconcile at a turn's end (assistant-usage.js).
  // A call that fails, times out or is missing on an older serve throws: the caller then knows
  // the turn was not reconciled.
  // The clients SynaBun builds (lib/opencode-v2-client.js, either major) keep `session` as it was and carry
  // `children` under `extra.session`.
  const storedRows = async (method, id) => {
    const group = typeof client.session?.[method] === 'function' ? client.session
      : typeof client.extra?.session?.[method] === 'function' ? client.extra.session : null;
    if (!group) throw new Error(`OpenCode session.${method} is not available`);
    const response = await settleWithin(group[method]({ sessionID: id, directory: cwd || undefined }), 5000);
    if (!response || response.error) throw new Error(providerErrorMessage(response?.error, `OpenCode session.${method} did not answer`));
    const rows = Array.isArray(response.data) ? response.data : Array.isArray(response) ? response : null;
    if (!rows) throw new Error(`OpenCode session.${method} returned no list`);
    return rows;
  };

  return {
    identity: () => ({ providerSessionId: sessionId }),
    isAlive: () => alive,
    describe: () => ({ provider: 'opencode', permissionPolicy, capability, askMode, ...(held ? { confinement: held.kind, root: held.root, ...(evaluated ? { role: evaluated.role } : {}) } : {}), ...(guard ? { guard: { mode: guard.mode, capability: guard.capability, writable: [...guard.writable] } } : {}) }),
    /** { children(sessionId) → sessions, messages(sessionId) → [{ info }] } on this run's own serve. */
    usageFetchers: () => ({
      children: (id) => storedRows('children', id),
      messages: (id) => storedRows('messages', id),
    }),
    async runTurn(prompt, meta = {}) {
      if (!alive) throw new Error('OpenCode native loop is closed');
      if (activeTurn) throw new Error('OpenCode native loop already has an active turn');
      const controller = new AbortController();
      activeAbort = controller;
      const checkReady = async () => {
        await client.waitUntilConnected?.(10_000);
        if (!alive || controller.signal.aborted) throw asAbortError('aborted');
        const ready = await waitForSynabunTools(client, {
          ...(options.mcpWait || {}), directory: cwd || undefined,
          expected: options.synabunExpected !== false && !held, signal: controller.signal,
          stopped: () => !alive,
          onTimeout: (ms) => {
            const text = synabunToolsTimeoutText(ms, 'worker');
            onNote?.(text);
            onEvent({ provider: 'opencode', runId, eventType: 'synabun.mcp.status', event: { sessionID: sessionId, text } });
          },
        });
        if (!ready || controller.signal.aborted || !alive) throw asAbortError('aborted');
      };
      const request = {
        sessionID: sessionId,
        parts: [{ type: 'text', text: prompt }],
        model: normalizeOpenCodeModel(model),
        // Capability is enforced by session rules, the adapter and sandbox, not OpenCode's planning workflow.
        agent: agent ? String(agent) : 'build',
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
          mode: 'async', completion, sent: false,
          resolve: resolveTurn, reject: rejectTurn, settled: false,
        };
        activeTurn = turn;
        try {
          await checkReady();
          turn.sent = true;
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
        await checkReady();
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
