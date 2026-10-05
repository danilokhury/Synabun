import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ni from '../services/neural-interface.js';
import { callerRole } from '../services/identity.js';
import { text } from './response.js';

// ═══════════════════════════════════════════
// agent_* — SynaBun assistant orchestration (role-gated group `agents`)
// ═══════════════════════════════════════════
//
// Thin proxies over /api/assistant/* (neural-interface/lib/assistant-api.js).
// The group is advertised only to runtimes bound to the `assistant` role
// (profiles.ts ROLE_GATED_GROUPS), and every handler re-checks the caller's
// role per request: a worker run that somehow lists these tools still cannot
// dispatch further workers (no recursion). Handlers never throw — the brain
// receives every failure (HTTP error JSON, transport error) as data.

export const AGENT_ROLE_DENIED = 'agent_* tools are only available to the SynaBun assistant runtime.';

export const AGENT_TOOL_NAMES = [
  'agent_catalog', 'agent_list', 'agent_route', 'agent_clarify', 'agent_dispatch', 'agent_status', 'agent_read',
  'agent_send', 'agent_wait', 'agent_stop', 'agent_focus', 'agent_usage',
] as const;

const PROVIDERS = ['claude-code', 'codex', 'opencode'] as const;
export const TASK_CLASSES = ['chat', 'quick', 'code', 'complex', 'review', 'research', 'browser', 'computer', 'automation', 'design', 'image_gen', 'video_gen'] as const;
// 50, not 60: an MCP client whose request timeout is the SDK default (60 s — the
// OpenCode brain) failed a default wait with -32001 before the wait itself returned.
const DEFAULT_WAIT_SECONDS = 50;
const MAX_WAIT_SECONDS = 120;

const runIdField = (purpose: string) => z.string().min(1).max(200).describe(purpose);
const optionalId = (purpose: string) => z.string().min(1).max(200).optional().describe(purpose);

// ── Schemas ──

export const agentCatalogSchema = {
  provider: z.enum(PROVIDERS).optional().describe('Only this provider\'s models (full list for that provider).'),
  search: z.string().min(1).max(80).optional().describe('Filter models whose id/label contains this text (e.g. "deepseek", "sonnet", "vision" models by name).'),
};

export const agentRouteSchema = {
  assistant_session_id: runIdField('Your ASSISTANT_SESSION_ID.'),
  task_class: z.enum(TASK_CLASSES).describe(
    'What kind of request this is: chat (conversation; never needs routing), quick (small edit/command/lookup), code (one-repo feature or fix), complex (architecture, cross-file refactor, hard debugging), review, research, browser (web task), computer (operate desktop apps; needs vision), automation (loops/schedules), design (UI/UX research, design systems, mockups, prototypes, redesigns: always one worker whose model can see, with SynaBun\'s design rules; building UI from an agreed design is code), image_gen (create images: always a worker whose model generates them, "image-out" on the sheet), video_gen (create videos: always a worker whose model generates them, "video-out"). Seeing or reading an image is not image_gen.'
  ),
  summary: z.string().min(1).max(400).describe('One line describing the task, shown to the user on the route card.'),
  confidence: z.number().min(0).max(1).describe(
    'How sure you are (0-1) that your FIRST proposal is the right model for this task. Be honest: low confidence asks the user in "ask when unsure" mode.'
  ),
  needs_vision: z.boolean().optional().describe('true when the task needs to see images or the screen (always true for computer).'),
  proposals: z.array(z.object({
    kind: z.enum(['direct', 'dispatch']).describe('"direct" = do it here on your own model (or another model of your own provider); "dispatch" = hand it to a worker.'),
    provider: z.enum(PROVIDERS).optional().describe('Worker provider for "dispatch" (ignored for "direct").'),
    model: z.string().max(200).optional().describe('Model id from the routing sheet / agent_catalog. Omit for the provider default (or a remembered route).'),
    effort: z.string().max(40).optional().describe('Reasoning effort for that model, per agent_catalog (e.g. low…max/ultra; OpenCode uses the model\'s variant names). Unsupported values are corrected to the nearest level the model runs.'),
    reason: z.string().max(240).optional().describe('Why this model (one short clause, shown on the card).'),
  })).min(1).max(3).describe('1-3 candidate routes, best first. The first is your pick.'),
  independent: z.boolean().optional().describe(
    'true when this task does not depend on questions still waiting for the user (agent_clarify pending). Otherwise agent_route answers "clarifying" until the user answers.'
  ),
};

export const agentClarifySchema = {
  assistant_session_id: runIdField('Your ASSISTANT_SESSION_ID.'),
  summary: z.string().min(1).max(200).describe('One line: what the user wants, as you understand it (shown on the card).'),
  questions: z.array(z.object({
    id: z.string().min(1).max(40).optional().describe('Short stable id, e.g. "scope" (defaults to q1, q2, …).'),
    header: z.string().min(1).max(40).optional().describe('A 1-4 word label shown above the question, e.g. "Scope".'),
    question: z.string().min(1).max(300).describe('One concise question whose answer changes what gets built or done.'),
    options: z.array(z.object({
      label: z.string().min(1).max(80),
      description: z.string().max(200).optional().describe('What choosing it implies, in a few words.'),
    })).min(2).max(4).describe('2-4 distinct answers, recommended first. The user can always type their own.'),
    multi_select: z.boolean().optional().describe('true when several options can apply together.'),
  })).min(1).max(3).describe('1-3 questions, only those whose answer changes the result. Never what the request, memory or the project already answers.'),
  constraints: z.array(z.string().min(1).max(240)).max(8).optional().describe(
    'What the request already fixes (explicit requirements, limits, must-nots). Workers receive them as binding.'
  ),
  assumptions: z.array(z.string().min(1).max(240)).max(6).optional().describe(
    'What you will assume for everything you do not ask (shown on the card, so the user can correct them). Workers receive them as unconfirmed defaults.'
  ),
};

export const agentListSchema = {
  active_only: z.boolean().optional().describe(
    'true = only queued, running or awaiting runs. Default lists recent runs including finished ones.'
  ),
  assistant_session_id: optionalId('Restrict to runs dispatched by this assistant session (your ASSISTANT_SESSION_ID).'),
  workflow_id: optionalId('Restrict to one workflow (the workflow_id passed to agent_dispatch).'),
};

export const agentDispatchSchema = {
  provider: z.enum(PROVIDERS).optional().describe(
    'Worker runtime. "claude-code" (Claude Agent SDK; supports permission_policy "ask"), "codex" (Codex app-server; use "restricted" instead of "ask"), "opencode" (isolated OpenCode serve). Required unless route_id is given (the approved route sets it). Reviews should use a different provider than the author.'
  ),
  route_id: optionalId('The route_id agent_route returned with status "approved": the server applies the approved provider/model/effort. Dispatches without an approved route may be held for the user\'s model choice (status awaiting_route).'),
  task_class: z.enum(TASK_CLASSES).optional().describe('Task class, used when this dispatch has no route_id (with one, it must match the route\'s image_gen / video_gen / design class or neither).'),
  confidence: z.number().min(0).max(1).optional().describe('Your confidence in the model choice, used when this dispatch has no route_id.'),
  uses_computer: z.boolean().optional().describe(
    'true when the worker must operate desktop apps on this Mac (the computer tools): one computer run at a time, a vision-capable model, capability read-only or workspace. Requires the Computer toggle on.'
  ),
  agent: z.string().max(60).optional().describe('OpenCode only: the agent to run (default "build"; "plan" for read-only).'),
  task: z.string().min(1).max(16000).describe(
    'Self-contained instructions for the worker: goal, constraints, acceptance criteria, and that it must end with a ## Result block. The worker cannot see this conversation.'
  ),
  cwd: z.string().min(1).describe(
    'Absolute path of the project directory the worker runs in (must exist; pick from agent_catalog projects).'
  ),
  assistant_session_id: runIdField(
    'Your ASSISTANT_SESSION_ID. Ties the run to this assistant session for rails, agent_list filtering and agent_stop all:true.'
  ),
  model: z.string().max(200).optional().describe(
    'Provider model id from agent_catalog (Claude id or alias, a Codex model, or OpenCode "providerID/modelID"). "auto" or omitted = the approved route, a remembered route, or the provider default. Unknown ids are rejected with MODEL_UNKNOWN and suggestions.'
  ),
  effort: z.string().max(40).optional().describe(
    'Reasoning effort for the chosen model, per agent_catalog (e.g. low…max/ultra; OpenCode uses the model\'s variant names). Unsupported values are corrected to the nearest level the model runs. Omit for the default.'
  ),
  mcp_profile: z.string().max(200).optional().describe(
    'SynaBun MCP profile preset for the worker (agent_catalog mcpPresets): "core" for memory-only work, "standard" for coding, a platform preset for browser/social jobs (design runs default to "browser" unless uses_browser is false).'
  ),
  account_id: z.string().max(200).optional().describe(
    'Account profile id: a Codex account for provider "codex" or a Claude account for provider "claude-code" (ignored for opencode). Omit for the default account.'
  ),
  permission_policy: z.enum(['auto', 'ask', 'restricted']).optional().describe(
    '"auto" (default): fully autonomous. "ask": tool permissions and questions are relayed to you — collect them with agent_wait until="event" and answer with agent_send reply. "restricted": workspace-write sandbox without prompts (the Codex alternative to ask).'
  ),
  capability: z.enum(['read-only', 'workspace', 'full']).optional().describe(
    '"full" (default; "workspace" for design runs), "workspace" (edits limited to cwd) or "read-only" (reviews, research). Browser jobs with "full" require the tag "user-authorized-full".'
  ),
  max_minutes: z.number().int().min(1).max(240).optional().describe(
    'Wall-clock cap in minutes (1-240, default 45; 60 for design runs); the run is stopped when exceeded.'
  ),
  budget_usd: z.number().min(0.1).max(50).optional().describe(
    'Spend cap in USD (0.1-50; the user\'s Budget settings set the default and may lower the ceiling). Every provider is held to it: Claude between model calls, OpenCode per step, Codex after each turn (priced at list price). It is lowered to what the session hard cap (brain + all runs) has left.'
  ),
  uses_browser: z.boolean().optional().describe(
    'true when the worker drives the SynaBun browser: it gets a loop browser tab and the browser enforcement block; page content is treated as untrusted data. Design runs default to true; false keeps one off the browser (no tab, no browser profile).'
  ),
  focus: z.boolean().optional().describe(
    'true to bring the worker\'s sidepanel tab to the front on attach. Default false: runs attach without stealing focus.'
  ),
  title: z.string().max(80).optional().describe('Short label (max 80 chars) shown in the agents dock and the sidepanel tab.'),
  context: z.string().max(8000).optional().describe('Extra context appended to the task (max 8000 chars): findings, file lists, prior results.'),
  tags: z.array(z.string().min(1).max(64)).max(10).optional().describe(
    'Up to 10 tags stored on the run and its auto-saved memory (e.g. "review", "docs", "user-authorized-full").'
  ),
  workflow_id: optionalId('Group several dispatches so agent_wait, agent_stop and agent_list can address them together.'),
  parent_run_id: optionalId('Run id this task continues or reviews (lineage only).'),
  output_schema: z.record(z.unknown()).optional().describe(
    'JSON Schema object the worker must satisfy in the fenced JSON of its ## Result block.'
  ),
  idempotency_key: optionalId(
    'Retry-safe key: repeating a dispatch with the same key returns the original run (replayed:true) instead of launching twice.'
  ),
  brief_id: optionalId(
    'The brief_id agent_clarify returned: the worker also gets the user\'s original request, their answers (binding), your constraints and assumptions. Omitted: the brief of the current request applies, if there is one.'
  ),
  independent: z.boolean().optional().describe(
    'true when this work does not depend on questions still waiting for the user (agent_clarify pending): it starts now, without their brief. Otherwise such a dispatch is refused (CLARIFICATION_PENDING) until the user answers.'
  ),
};

export const agentStatusSchema = {
  run_id: runIdField('Run id returned by agent_dispatch (also listed by agent_list).'),
};

export const agentReadSchema = {
  run_id: runIdField('Run id returned by agent_dispatch (also listed by agent_list).'),
  format: z.enum(['result', 'tail', 'text', 'files']).optional().describe(
    '"result" (default): the parsed ## Result contract {status, summary, changes, follow_ups, question, json, media}. "tail": the last transcript events (see tail). "text": the worker\'s assistant text. "files": the files it reported changing.'
  ),
  tail: z.number().int().min(1).max(500).optional().describe('Number of trailing transcript events for format "tail" (1-500).'),
  max_chars: z.number().int().min(200).max(20000).optional().describe(
    'Truncate the output to this many characters (200-20000). Start small; read again if truncated.'
  ),
};

export const agentSendSchema = {
  run_id: runIdField('Run id returned by agent_dispatch (also listed by agent_list).'),
  text: z.string().min(1).max(8000).optional().describe(
    'Follow-up instruction for the worker (1-8000 chars), sent as the next turn of its single conversation.'
  ),
  reply: z.object({
    request_id: runIdField('The pending request id (from agent_status pendingRequests or an agent_wait until="event" result).'),
    decision: z.enum(['allow', 'deny', 'answer']).describe(
      '"allow" / "deny" for tool permission requests; "answer" for questions (provide answers).'
    ),
    answers: z.record(z.unknown()).optional().describe('Question answers keyed by question id (decision "answer").'),
    note: z.string().max(2000).optional().describe('Optional message delivered to the worker with the decision.'),
  }).optional().describe('Answer a pending permission or question request instead of (or before) sending text.'),
  queue: z.boolean().optional().describe(
    'true to enqueue text while the worker is still running (delivered at its next idle point). Default: send only when idle.'
  ),
};

export const agentWaitSchema = {
  run_id: optionalId('Single run to wait for.'),
  run_ids: z.array(z.string().min(1).max(200)).max(10).optional().describe('Up to 10 runs to wait for together (fan-out barrier).'),
  workflow_id: optionalId('Wait for every run of a workflow instead of listing ids.'),
  until: z.enum(['idle', 'terminal', 'event']).optional().describe(
    '"idle" (default): the current turn finished and its result is readable. "terminal": completed, failed, stopped or interrupted. "event": the next lifecycle event (result, needs_input, permission_request, failed, stalled).'
  ),
  mode: z.enum(['all', 'any']).optional().describe(
    'For run_ids / workflow_id: "all" (default) returns when every run satisfies until; "any" returns on the first one.'
  ),
  timeout_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe(
    `Max seconds to block per call (1-${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}). A timed-out wait says so; call again to keep waiting. Go above 55 only if your MCP client's tool timeout is longer than the wait (OpenCode stops a tool call at 60 s).`
  ),
};

export const agentStopSchema = {
  run_id: optionalId('Run to stop.'),
  workflow_id: optionalId('Stop every run of this workflow (kill-all scoped to the workflow).'),
  all: z.boolean().optional().describe('true to stop every run of this assistant session (kill-all). Requires assistant_session_id.'),
  assistant_session_id: optionalId('Your ASSISTANT_SESSION_ID — required with all:true so only your own runs stop.'),
  reason: z.string().max(500).optional().describe('Short reason recorded on the stopped run(s).'),
};

export const agentFocusSchema = {
  run_id: runIdField('Run whose sidepanel automation tab to focus.'),
  focus: z.boolean().optional().describe('true (default) brings the tab to the front; false releases focus.'),
};

export const agentUsageSchema = {
  assistant_session_id: runIdField('Your ASSISTANT_SESSION_ID.'),
  task: optionalId('"current" (default), a task id, or "all" for session totals.'),
  run_id: optionalId('Show only this agent row with the task header; with task "all", that run\'s tokens over every task it worked in.'),
};

// ── Descriptions (routing instructions) ──

export const agentCatalogDescription =
  'Discover what you can route to: providers (claude-code, codex, opencode) with models (tier, price per 1M tokens, vision, context, efforts), accounts, registered projects (cwd candidates), MCP profile presets, rails/limits and active runs. Without arguments it returns a compact routing view (OpenCode sampled); pass provider and/or search to list more models. Call it when the routing sheet in your instructions lacks a model, or after a MODEL_UNKNOWN rejection. Returns JSON.';

export const agentRouteDescription =
  'Route an actionable task BEFORE starting it (you are the planner). Give task_class, a one-line summary, your honest confidence (0-1) and 1-3 proposals (direct = here on your model; dispatch = a worker provider/model). The server applies the session\'s route mode (always ask / ask when unsure / never ask): it approves at once, or shows the user a route card and waits briefly. Follow the returned status and next: approved+dispatch → agent_dispatch with route_id; approved+direct → do it yourself; continuation → end your turn (SynaBun continues on the chosen model); pending → end your turn, the choice arrives as a [SynaBun Mailbox] route_decided event; declined → do not start (reason no_capable_model: no model can make the image or video, or see for design; tell the user which Model routes row needs one); clarifying → end your turn, the user has not answered your agent_clarify questions yet (independent:true for a task that does not depend on them). image_gen / video_gen always route to a worker whose model generates the medium, design to a worker whose model can see. Never use it for conversation or bookkeeping. Returns JSON.';

export const agentClarifyDescription =
  'Ask the user 1-3 targeted questions BEFORE routing a new request that is materially ambiguous: two plausible readings with different results, an unclear target (project, feature, files, audience), destructive or irreversible scope, spend, or memories that conflict with it. Not for clear requests, details a sensible default covers, anything the request, memory or the project answers, or the model (agent_route asks that). Each question gets 2-4 options (recommended first; the user can always type their own); add constraints (what the request fixes) and assumptions (what you will assume for the rest). The card waits briefly. Follow the returned status and next: answered → route, then agent_dispatch with the brief_id (SynaBun adds the user\'s original words, their answers, the constraints and assumptions to the worker\'s context); declined → proceed on your assumptions; pending → end your turn, the answers arrive as a [SynaBun Mailbox] clarify_answered event or as the user\'s next message, and dependent routes and dispatches wait until then. Returns JSON.';

export const agentListDescription =
  'List dispatched worker runs with status, provider/model, title, elapsed time and cost. Use it before dispatching more work, to recover run ids, or after a mailbox event. Filter with active_only, assistant_session_id (your own session) or workflow_id. Returns JSON.';

export const agentDispatchDescription =
  'Dispatch a task to a worker agent (Claude Code, Codex or OpenCode). Route it first with agent_route and pass the approved route_id (the server applies that provider/model/effort); without one, the dispatch may be held until the user picks a model (awaitingRoute:true — do not dispatch it again). After agent_clarify, pass its brief_id: the worker gets the user\'s own words and answers; while its questions are open a dependent dispatch is refused (CLARIFICATION_PENDING). The run attaches as a live automation tab in the matching sidepanel without stealing focus. Write a self-contained task that ends with a ## Result block, pass the absolute cwd and your assistant_session_id. Defaults: permission_policy "auto", capability "full", 45 minutes, $5. Use "ask" only for sensitive scopes (Codex cannot ask: use "restricted"). uses_computer:true for desktop work (one at a time, vision model). An image_gen / video_gen run makes the asset with its model\'s own generation tool; SynaBun collects the files into the run\'s result (media: path + url); with no model that generates the medium an un-routed dispatch is refused (NO_CAPABLE_MODEL), and a route_id approved for other work is refused for image_gen / video_gen / design (and the other way round: ROUTE_CLASS_MISMATCH; route the task again with its own class). A design run gets SynaBun\'s design rules and the project\'s style guide, defaults to capability "workspace", uses_browser true, mcp_profile "browser" and 60 minutes (explicit values win), runs only on a model confirmed to see (MODEL_CANNOT_SEE otherwise), and its screenshots land in the result\'s media. Group fan-outs with workflow_id, chain with parent_run_id, retry safely with idempotency_key. Over-limit dispatches are queued (queued:true, position). After dispatching, block with agent_wait rather than polling. Returns JSON.';

export const agentStatusDescription =
  'Get one run\'s current descriptor: status (queued, running, completed, failed, stopped, interrupted), turnState (running, idle, awaiting_permission), provider/model/account, elapsed time, cost, the last parsed result summary and any pending permission or question requests. Cheap; use it between agent_wait calls or before agent_send / agent_stop. Returns JSON.';

export const agentReadDescription =
  'Read a run\'s output. format "result" (default) returns the parsed ## Result contract (status, summary, changes, follow_ups, question, json, and media: the images / videos an image_gen or video_gen run generated or a design run captured, each { kind, path, url, mime, bytes } — show one with ![](url) plus its path); "tail" returns the last transcript events; "text" the worker\'s assistant text; "files" the files it reported. Call after agent_wait reports idle or terminal; keep max_chars small and read again if truncated. Returns JSON.';

export const agentSendDescription =
  'Continue a worker\'s conversation. text sends a follow-up turn (queue:true enqueues it while the worker is still running). reply answers a pending permission or question request: decision allow/deny for tools, answer (with answers) for questions, note as an optional message. Obtain request ids from agent_status or agent_wait until="event". Returns JSON.';

export const agentWaitDescription =
  'Blocking barrier for orchestration. Waits up to timeout_seconds (max 120) for one run (run_id), several runs (run_ids with mode all/any) or a whole workflow to reach until="idle" (turn finished; default), "terminal" (completed, failed, stopped) or "event" (next mailbox event: result, needs_input, permission_request, failed). Returns the run descriptors and whether the wait timed out; call again to keep waiting. Prefer this over polling agent_status. Returns JSON.';

export const agentStopDescription =
  'Stop work. run_id stops one run; all:true with your assistant_session_id stops every run of this assistant session, workflow_id every run of a workflow (kill-all). Use when the user cancels, a worker misbehaves, or a time/budget rail is at risk. Returns JSON.';

export const agentFocusDescription =
  'Bring a run\'s sidepanel automation tab to the front (focus:false releases it). Use when the user asks to watch a worker; dispatches never steal focus by themselves. Returns JSON.';

export const agentUsageDescription =
  'Get token usage for a task, run, or entire Assistant session. Returns compact JSON. `session` is the headline the panel shows: every task of this session added up (it only grows, and survives a restart), with a per-model breakdown (models: inputTotal, outputTotal, total, costUsd, costBasis). Below it the task asked for: tokens, USD cost, fidelity, unsynced (rows not on disk yet, normally 0), and each agent\'s key, title, provider, model, total, sub-agents total, fidelity and state (partialReason when a count is partial; calls on the Jev judgments row). Every tokens object has the five additive classes (input = uncached input, cacheWrite, cacheRead, output = visible output, reasoning), total, inputTotal (input + cacheWrite + cacheRead: everything sent to the model) and outputTotal (output + reasoning): the same meaning for every provider, nothing counted twice. costUsd is at API list prices; costBasis says how it is known: reported (the provider reported it), estimated (tokens at list price: Codex and other plan-billed work, where it is the list-price equivalent, not a charge), free, or unpriced (no list price: tokens counted, no dollars). Counts are exact provider counts when fidelity is exact; live marks provisional counts and partial marks incomplete counts. metered:false means this server keeps no usage ledger. No routing is needed.';

// ── Handlers ──

type ToolResult = ReturnType<typeof text> & { isError?: boolean };

export type AgentCatalogArgs = z.infer<z.ZodObject<typeof agentCatalogSchema>>;
export type AgentRouteArgs = z.infer<z.ZodObject<typeof agentRouteSchema>>;
export type AgentClarifyArgs = z.infer<z.ZodObject<typeof agentClarifySchema>>;
export type AgentListArgs = z.infer<z.ZodObject<typeof agentListSchema>>;
export type AgentDispatchArgs = z.infer<z.ZodObject<typeof agentDispatchSchema>>;
export type AgentStatusArgs = z.infer<z.ZodObject<typeof agentStatusSchema>>;
export type AgentReadArgs = z.infer<z.ZodObject<typeof agentReadSchema>>;
export type AgentSendArgs = z.infer<z.ZodObject<typeof agentSendSchema>>;
export type AgentWaitArgs = z.infer<z.ZodObject<typeof agentWaitSchema>>;
export type AgentStopArgs = z.infer<z.ZodObject<typeof agentStopSchema>>;
export type AgentFocusArgs = z.infer<z.ZodObject<typeof agentFocusSchema>>;
export type AgentUsageArgs = z.infer<z.ZodObject<typeof agentUsageSchema>>;

function json(result: unknown): ToolResult {
  return text(JSON.stringify(result, null, 2));
}

function invalid(message: string): ToolResult {
  return json({ error: message, code: 'INVALID_ARGS' });
}

/** Role guard + never-throw wrapper shared by every agent_* handler. */
async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  if (callerRole() !== 'assistant') return text(AGENT_ROLE_DENIED);
  try {
    return await run();
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err), code: 'AGENT_TOOL_ERROR' });
  }
}

export function handleAgentCatalog(args: AgentCatalogArgs = {}): Promise<ToolResult> {
  return guarded(async () => json(await ni.assistantCatalog({ provider: args.provider, search: args.search })));
}

export function handleAgentRoute(args: AgentRouteArgs): Promise<ToolResult> {
  return guarded(async () => json(await ni.assistantRoute({
    assistantSessionId: args.assistant_session_id,
    task_class: args.task_class,
    summary: args.summary,
    confidence: args.confidence,
    needs_vision: args.needs_vision,
    proposals: args.proposals,
    independent: args.independent,
  })));
}

export function handleAgentClarify(args: AgentClarifyArgs): Promise<ToolResult> {
  return guarded(async () => json(await ni.assistantClarify({
    assistantSessionId: args.assistant_session_id,
    summary: args.summary,
    questions: args.questions,
    constraints: args.constraints,
    assumptions: args.assumptions,
  })));
}

export function handleAgentList(args: AgentListArgs): Promise<ToolResult> {
  return guarded(async () => json(await ni.assistantListRuns({
    activeOnly: args.active_only === true,
    assistantSessionId: args.assistant_session_id,
    workflowId: args.workflow_id,
  })));
}

export function handleAgentDispatch(args: AgentDispatchArgs): Promise<ToolResult> {
  return guarded(async () => {
    if (!args.provider && !args.route_id) return invalid('Provide provider, or the route_id of an approved agent_route.');
    return json(await ni.assistantDispatch({
    provider: args.provider,
    task: args.task,
    cwd: args.cwd,
    assistantSessionId: args.assistant_session_id,
    model: args.model,
    effort: args.effort,
    mcpProfile: args.mcp_profile,
    routeId: args.route_id,
    taskClass: args.task_class,
    confidence: args.confidence,
    usesComputer: args.uses_computer,
    agent: args.agent,
    // One account_id input, provider-specific body keys server-side (with a
    // route_id the provider may be unknown here, so pass it generically too).
    accountId: args.provider ? undefined : args.account_id,
    codexAccountId: args.provider === 'codex' ? args.account_id : undefined,
    claudeAccountId: args.provider === 'claude-code' ? args.account_id : undefined,
    permissionPolicy: args.permission_policy,
    capability: args.capability,
    maxMinutes: args.max_minutes,
    budgetUsd: args.budget_usd,
    usesBrowser: args.uses_browser,
    focus: args.focus,
    title: args.title,
    context: args.context,
    tags: args.tags,
    workflowId: args.workflow_id,
    parentRunId: args.parent_run_id,
    outputSchema: args.output_schema,
    idempotencyKey: args.idempotency_key,
    briefId: args.brief_id,
    independent: args.independent,
    }));
  });
}

export function handleAgentStatus(args: AgentStatusArgs): Promise<ToolResult> {
  return guarded(async () => json(await ni.assistantRun(args.run_id)));
}

export function handleAgentRead(args: AgentReadArgs): Promise<ToolResult> {
  return guarded(async () => {
    const format = args.format || 'result';
    if (format === 'result') return json(await ni.assistantResult(args.run_id));
    return json(await ni.assistantTranscript(args.run_id, { format, tail: args.tail, maxChars: args.max_chars }));
  });
}

export function handleAgentSend(args: AgentSendArgs): Promise<ToolResult> {
  return guarded(async () => {
    if (!args.reply && !args.text) {
      return invalid('Provide "text" (follow-up turn) and/or "reply" (answer to a pending permission/question request).');
    }
    const out: { reply?: ni.NiResponse; send?: ni.NiResponse } = {};
    if (args.reply) {
      out.reply = await ni.assistantPermission(args.run_id, {
        requestId: args.reply.request_id,
        behavior: args.reply.decision === 'deny' ? 'deny' : 'allow',
        answers: args.reply.answers,
        message: args.reply.note,
      });
    }
    if (args.text) {
      out.send = await ni.assistantSend(args.run_id, { text: args.text, queue: args.queue });
    }
    return json(args.reply && args.text ? out : (out.reply ?? out.send));
  });
}

export function handleAgentWait(args: AgentWaitArgs): Promise<ToolResult> {
  return guarded(async () => {
    const until = args.until || 'idle';
    const seconds = Math.min(Math.max(args.timeout_seconds ?? DEFAULT_WAIT_SECONDS, 1), MAX_WAIT_SECONDS);
    const timeoutMs = seconds * 1000;
    const runIds = [...(args.run_ids || [])];
    const multi = runIds.length > 0 || !!args.workflow_id;
    if (!multi) {
      if (!args.run_id) return invalid('Provide run_id, run_ids or workflow_id.');
      return json(await ni.assistantWaitRun(args.run_id, { until, timeoutMs }));
    }
    if (args.run_id && !runIds.includes(args.run_id)) runIds.unshift(args.run_id);
    return json(await ni.assistantWaitMany({
      runIds: runIds.length ? runIds : undefined,
      workflowId: args.workflow_id,
      mode: args.mode || 'all',
      until,
      timeoutMs,
    }));
  });
}

export function handleAgentStop(args: AgentStopArgs): Promise<ToolResult> {
  return guarded(async () => {
    if (args.all || (args.workflow_id && !args.run_id)) {
      if (args.all && !args.assistant_session_id && !args.workflow_id) {
        return invalid('all:true needs your assistant_session_id (ASSISTANT_SESSION_ID) so only your own runs stop.');
      }
      return json(await ni.assistantKillAll({ assistantSessionId: args.assistant_session_id, workflowId: args.workflow_id, reason: args.reason }));
    }
    if (!args.run_id) return invalid('Provide run_id, workflow_id, or all:true.');
    return json(await ni.assistantStop(args.run_id, args.reason));
  });
}

export function handleAgentFocus(args: AgentFocusArgs): Promise<ToolResult> {
  return guarded(async () => json(await ni.assistantFocus(args.run_id, args.focus !== false)));
}

/** A lookup that failed, marked as a tool error so the host never reads it as usage. */
function failedUsage(result: unknown): ToolResult {
  return { ...text(JSON.stringify(result)), isError: true };
}

export function handleAgentUsage(args: AgentUsageArgs): Promise<ToolResult> {
  return guarded(async () => {
    const task = args.task || 'current';
    let answer: ni.NiResponse;
    // task "all" with a run: the server sums that run over its tasks in the same call.
    try { answer = await ni.assistantUsage(args.assistant_session_id, task, task === 'all' ? args.run_id : undefined); }
    catch (err) { return failedUsage({ error: err instanceof Error ? err.message : String(err), code: 'AGENT_TOOL_ERROR' }); }
    if (answer.ok !== true) return failedUsage(answer);
    /** One model of a breakdown: both sides, the classes behind them, and its dollars. */
    const compactModel = (row: any) => ({
      provider: row.provider ?? null, model: row.model ?? null,
      inputTotal: row.tokens?.inputTotal ?? 0, outputTotal: row.tokens?.outputTotal ?? 0, total: row.tokens?.total ?? 0,
      cacheRead: row.tokens?.cacheRead ?? 0, cacheWrite: row.tokens?.cacheWrite ?? 0, reasoning: row.tokens?.reasoning ?? 0,
      costUsd: row.costUsd ?? 0, costBasis: row.costBasis ?? null,
    });
    /** The headline: the whole session, as the panel shows it. */
    const sessionHead = (session: any) => ({
      tokens: session.tokens, costUsd: session.costUsd ?? 0, costBasis: session.costBasis ?? null, fidelity: session.fidelity ?? null,
      tasks: Array.isArray(session.tasks) ? session.tasks.length : session.tasks ?? 0,
      models: (Array.isArray(session.models) ? session.models : []).map(compactModel),
    });
    const compactAgent = (agent: any) => ({
      key: agent.key, title: agent.title ?? null, provider: agent.provider, model: agent.model,
      tokens: agent.tokens, total: agent.tokens?.total ?? 0, subagents: { total: agent.subagents?.total ?? 0 },
      fidelity: agent.fidelity, state: agent.state ?? null,
      // Why a count is partial, and how many judgments the Jev row stands for.
      ...(agent.partialReason ? { partialReason: agent.partialReason } : {}),
      ...(agent.key === 'judgments' ? { calls: agent.calls ?? 0 } : {}),
    });
    if (task === 'all') {
      const session = answer.session as any;
      // The server has no usage ledger: say so, never fail on the missing view.
      if (!session) return text(JSON.stringify({ sessionId: args.assistant_session_id, metered: false, tokens: null, costUsd: 0, tasks: [] }));
      const { tasks: _taskCount, ...totals } = sessionHead(session);
      const head = { sessionId: session.sessionId, ...totals, unsynced: session.unsynced ?? 0 };
      if (args.run_id) {
        const run = answer.run as any;
        const worked = new Set<string>(Array.isArray(run?.taskIds) ? run.taskIds : []);
        return text(JSON.stringify({
          ...head,
          run: run ? { key: args.run_id, tokens: run.tokens, total: run.tokens?.total ?? 0, subagents: { total: run.subagents?.total ?? 0 }, fidelity: run.fidelity } : null,
          tasks: (session.tasks || []).filter((item: any) => worked.has(item.id))
            .map((item: any) => ({ id: item.id, n: item.n, title: item.title, costUsd: item.costUsd, fidelity: item.fidelity })),
        }));
      }
      return text(JSON.stringify({ ...head, tasks: session.tasks }));
    }
    const view = answer.usage as any;
    if (!view) return text(JSON.stringify({ sessionId: args.assistant_session_id, metered: false, task: null, tokens: null, costUsd: 0, fidelity: null, agents: [] }));
    const detail = view.task;
    return text(JSON.stringify({
      sessionId: view.sessionId,
      // The whole session (the panel's headline); `tokens` / `costUsd` below are the task's.
      session: view.session ? sessionHead(view.session) : null,
      task: detail ? { id: detail.id, n: detail.n, title: detail.title, startedAt: detail.startedAt, live: detail.live } : null,
      tokens: detail?.tokens ?? null, costUsd: detail?.costUsd ?? 0, costBasis: detail?.costBasis ?? null, fidelity: detail?.fidelity ?? null,
      // Rows the ledger has not written to disk yet (normally 0).
      unsynced: view.session?.unsynced ?? 0,
      agents: (detail?.agents || []).filter((agent: any) => !args.run_id || agent.key === args.run_id || agent.runId === args.run_id).map(compactAgent),
    }));
  });
}

// ── Registration ──

/**
 * Register the agent_* tools on a server. Returned handles are stored as the
 * `agents` tool group so ProfileRuntime can gate them on the caller role.
 */
export function registerAgentTools(server: McpServer) {
  return [
    server.tool('agent_catalog',  agentCatalogDescription,  agentCatalogSchema,  (args) => handleAgentCatalog(args)),
    server.tool('agent_list',     agentListDescription,     agentListSchema,     (args) => handleAgentList(args)),
    server.tool('agent_route',    agentRouteDescription,    agentRouteSchema,    (args) => handleAgentRoute(args)),
    server.tool('agent_clarify',  agentClarifyDescription,  agentClarifySchema,  (args) => handleAgentClarify(args)),
    server.tool('agent_dispatch', agentDispatchDescription, agentDispatchSchema, (args) => handleAgentDispatch(args)),
    server.tool('agent_status',   agentStatusDescription,   agentStatusSchema,   (args) => handleAgentStatus(args)),
    server.tool('agent_read',     agentReadDescription,     agentReadSchema,     (args) => handleAgentRead(args)),
    server.tool('agent_send',     agentSendDescription,     agentSendSchema,     (args) => handleAgentSend(args)),
    server.tool('agent_wait',     agentWaitDescription,     agentWaitSchema,     (args) => handleAgentWait(args)),
    server.tool('agent_stop',     agentStopDescription,     agentStopSchema,     (args) => handleAgentStop(args)),
    server.tool('agent_focus',    agentFocusDescription,    agentFocusSchema,    (args) => handleAgentFocus(args)),
    server.tool('agent_usage',    agentUsageDescription,    agentUsageSchema,    (args) => handleAgentUsage(args)),
  ];
}
