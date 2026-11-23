import { resolveToolList } from '../services/tool-list.js';
import { z } from 'zod/v3';
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
// (tool-runtime.ts ROLE_GATED_GROUPS), and every handler re-checks the caller's
// role per request: a worker run that somehow lists these tools still cannot
// dispatch further workers (no recursion). Handlers never throw — the brain
// receives every failure (HTTP error JSON, transport error) as data.

export const AGENT_ROLE_DENIED = 'agent_* tools are only available to the SynaBun assistant runtime.';

export const AGENT_TOOL_NAMES = [
  'agent_catalog', 'agent_list', 'agent_route', 'agent_clarify', 'agent_dispatch', 'agent_status', 'agent_read',
  'agent_send', 'agent_wait', 'agent_stop', 'agent_focus', 'agent_usage',
  'agent_team', // agents-p4
] as const;

// Worker providers. Every one can also be the Assistant's brain; Antigravity (Google's agy CLI) runs both over ACP.
const PROVIDERS = ['claude-code', 'codex', 'opencode', 'antigravity'] as const;
export const TASK_CLASSES = ['chat', 'quick', 'code', 'complex', 'review', 'research', 'browser', 'computer', 'automation', 'design', 'image_gen', 'video_gen'] as const;
// 50, not 60: an MCP client whose request timeout is the SDK default (60 s — the
// OpenCode brain) failed a default wait with -32001 before the wait itself returned.
const DEFAULT_WAIT_SECONDS = 50;
const MAX_WAIT_SECONDS = 120;
// The kinds a run's events are logged as (agent_wait until "event"). A copy of RUN_EVENT_KINDS in
// neural-interface/lib/coordination/service.js; neural-interface/tests/coordination-service.test.mjs fails when one drifts.
export const RUN_EVENT_KINDS = [
  'run.result', 'run.needs_input', 'run.permission', 'run.failed', 'run.stalled', 'run.stopped', 'run.interrupted',
  'run.completed', 'run.budget', 'run.notice', 'run.message', 'run.progress',
] as const;

/** One title limit for agent_route planned_split.slices and agent_team slices[].title (= TEAM_LIMITS.title in neural-interface/lib/teams/schema.js). */
export const SLICE_TITLE_MAX = 80;

const runIdField = (purpose: string) => z.string().min(1).max(200).describe(purpose);
const optionalId = (purpose: string) => z.string().min(1).max(200).optional().describe(purpose);

// ── Schemas ──

export const agentCatalogSchema = {
  provider: z.enum(PROVIDERS).optional().describe('Only this provider\'s models (full list for that provider).'),
  search: z.string().min(1).max(80).optional().describe('Filter models whose id/label contains this text (e.g. "deepseek", "sonnet", "vision" models by name).'),
};

export const agentRouteSchema = {
  agent_ref: z.string().min(1).max(140).optional().describe('Worker agent for the route. A proposal can override it. Omit to inherit the task class agent, or pass "none" for a plain worker.'),
  assistant_session_id: runIdField('Your ASSISTANT_SESSION_ID.'),
  task_class: z.enum(TASK_CLASSES).describe(
    'What kind of request this is: chat (conversation; never needs routing), quick (small edit/command/lookup), code (one-repo feature or fix), complex (architecture, cross-file refactor, hard debugging), review, research, browser (web task), computer (operate desktop apps; needs vision), automation (loops/schedules), design (UI/UX research, design systems, mockups, prototypes, redesigns: always one worker whose model can see, with SynaBun\'s design rules; building UI from an agreed design is code), image_gen (create images: always a worker whose model generates them, "image-out" on the sheet), video_gen (create videos: always a worker whose model generates them, "video-out"). Seeing or reading an image is not image_gen.'
  ),
  summary: z.string().min(1).max(400).describe('One line describing the task, shown to the user on the route card.'),
  task_key: z.string().min(1).max(100).optional().describe('Only for a genuinely separate subtask of this user request. Omit for the current task. Keep the same key on retries; rewording or changing proposals never needs a new card.'),
  confidence: z.number().min(0).max(1).describe(
    'How sure you are (0-1) that your FIRST proposal is the right model for this task. Be honest: low confidence asks the user in "ask when unsure" mode.'
  ),
  planned_split: z.object({
    workers: z.number().int().min(1).max(6),
    slices: z.array(z.string().min(1).max(SLICE_TITLE_MAX).describe(`Slice title, at most ${SLICE_TITLE_MAX} characters: agent_team start must give exactly these titles.`)).min(1).max(6),
    reason: z.string().min(1).max(400).optional(),
  }).optional().describe('At Pair/Team/Swarm, plan code/complex/research/review before routing. Give the target 2/4/6 workers and distinct slice titles; fewer requires a reason why it cannot sensibly split further. One approval covers the whole plan.'),
  needs_host: z.boolean().optional().describe('Set true when this task requires host access unavailable to workers, such as writing outside the workspace. Computer use alone does not require it. The worker-only classes design, image_gen, and video_gen refuse needs_host:true.'),
  needs_vision: z.boolean().optional().describe('true when the task needs to see images or the screen (always true for computer).'),
  proposals: z.array(z.object({
    kind: z.enum(['direct', 'dispatch']).describe('"direct" = do it here on your own model (or another model of your own provider); "dispatch" = hand it to a worker.'),
    provider: z.enum(PROVIDERS).optional().describe('Worker provider for "dispatch" (ignored for "direct").'),
    model: z.string().max(200).optional().describe('Model id from the routing sheet / agent_catalog. Omit for the provider default (or a remembered route).'),
    effort: z.string().max(40).optional().describe('Reasoning effort for that model, per agent_catalog (e.g. low…max/ultra; OpenCode uses the model\'s variant names). "none" turns thinking off: kept on Claude Code models that think and on Codex / OpenCode models that list none. Unsupported values are corrected to the nearest level the model runs (never to none).'),
    account_id: z.string().max(64).optional().describe('Claude Code or Codex account id, or "auto" to choose the signed-in subscription with most usage left. API-key accounts are excluded from Auto. A limited pinned/default account falls back within the provider; corrections explain the selection. Another account runs on a worker when the proposal was direct.'),
    agent_ref: z.string().min(1).max(140).optional().describe('A SynaBun agent to hand the task to (an id from agent_catalog agents, as for agent_dispatch): the proposal is then a dispatch, and the provider, model, effort and account you leave out are the agent\'s. The approved route carries this agent. Use "none" for a plain worker.'),
    reason: z.string().max(240).optional().describe('Why this model (one short clause, shown on the card).'),
  })).min(1).max(3).describe('1-3 candidate routes, best first. The first is your pick.'),
  cwd: z.string().min(1).max(4096).optional().describe('Absolute project directory. Required for code/complex/research/review density planning (git worktree check); also resolves project agent_ref proposals.'),
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
    'Worker runtime. "claude-code" (Claude Agent SDK; supports permission_policy "ask"), "codex" (Codex app-server; supports questions and permission_policy "ask"), "opencode" (isolated OpenCode serve), "antigravity" (Google Antigravity\'s agy CLI over ACP; supports "ask"; no accounts; reports tokens, not prices, so it runs only when the session budget is No limit). Optional with route_id (the approved route sets it), task_class (the router selects it), or a named agent_ref. Reviews should use a different provider than the author.'
  ),
  worker_index: z.number().int().min(1).max(6).optional().describe('Legacy slot field. New code/complex/research/review splits must use agent_team; do not dispatch individual slices.'),
  route_id: optionalId('The route_id agent_route returned with status "approved": the server applies the approved provider/model/effort. Dispatches without an approved route may be held for the user\'s model choice (status awaiting_route).'),
  task_class: z.enum(TASK_CLASSES).optional().describe('Task class, used when this dispatch has no route_id (with one, it must match the route\'s image_gen / video_gen / design class or neither).'),
  confidence: z.number().min(0).max(1).optional().describe('Your confidence in the model choice, used when this dispatch has no route_id.'),
  uses_computer: z.boolean().optional().describe(
    'true when the worker must operate desktop apps on this Mac (the computer tools): one computer run at a time, a vision-capable model, capability read-only or workspace. Requires the Computer toggle on.'
  ),
  agent: z.string().max(60).optional().describe('OpenCode only: the agent to run (default "build" at every capability, including read-only). Use "plan" only for an explicitly requested planning workflow; capability enforces read-only.'),
  agent_ref: z.string().min(1).max(140).optional().describe(
    'Routed workers inherit their task class agent. Pass "none" to opt out for this dispatch, or select an id from agent_catalog agents ("release-notes"), optionally one revision ("release-notes@3") or one library ("global:release-notes", "project:release-notes"); without a library the project\'s own agent of that id wins over the global one. The agent\'s approved definition fills what you leave out (provider, model, effort, account, tools and MCP servers, capability, permission policy, browser / computer use, MoreLogin profile) and its instructions go to the worker as its role; what you pass yourself wins, and an approved route\'s provider, model, effort and account stay binding. A definition never widens the run: what it asks for beyond the session or this dispatch is taken down and listed in corrections. AGENT_UNKNOWN: no such agent; AGENT_NOT_APPROVED: only the owner approves one (tell the user to review it in Agents). Not the same as `agent` (OpenCode\'s own agent).'
  ),
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
    'Reasoning effort for the chosen model, per agent_catalog (e.g. low…max/ultra; OpenCode uses the model\'s variant names). "none" turns thinking off: kept on Claude Code models that think and on Codex / OpenCode models that list none. Unsupported values are corrected to the nearest level the model runs (never to none). Omit for the default.'
  ),
  tools: z.array(z.string().min(1).max(72)).max(32).optional().describe(
    'SynaBun group ids plus mcp:<exact server name> or mcp:* from agent_catalog.tools.servers. Omitted = core with no external servers; [] = always-on only. Unnamed external servers are off on Codex, OpenCode, Claude and Antigravity. Browser use adds browser; design adds browser, styleguide and image. OpenCode loads the list strictly; Claude Code and Codex keep every SynaBun tool on demand and group choices set focus only; external-server selection is strict.'
  ),
  account_id: z.string().max(200).optional().describe(
    'Account profile id, or "auto" for the signed-in subscription with most usage left (API keys excluded; limited pinned/default accounts fall back within the provider, with corrections). An approved route binds its resolved account unless it becomes limited before dispatch. A Codex account for provider "codex" or a Claude account for provider "claude-code" (ignored for opencode and antigravity), an id from agent_catalog accounts["codex"] / accounts["claude-code"]. The worker uses that account\'s own mode (its ChatGPT or Claude subscription, or its API key). Omit to use the user\'s worker account for that provider (agent_catalog codexWorkerAccount / claudeWorkerAccount; Default when null). A signed-out account is refused with ACCOUNT_SIGNED_OUT.'
  ),
  permission_policy: z.enum(['auto', 'ask', 'restricted']).optional().describe(
    'Questions in every policy appear in the worker’s live sidepanel and pause the same turn; agent_send reply can also answer (first answer wins). "auto" (default): autonomous tool permissions. "ask": tool permissions are relayed to you — collect them with agent_wait until="event" and answer with agent_send reply. "restricted": workspace-write sandbox; user questions remain available.'
  ),
  capability: z.enum(['read-only', 'workspace', 'full']).optional().describe(
    '"full" (default; "workspace" for design runs), "workspace" (edits limited to cwd) or "read-only" (reviews, research). Browser jobs with "full" require the tag "user-authorized-full".'
  ),
  max_minutes: z.number().int().min(1).max(240).optional().describe(
    'Work-time cap in minutes (at most 240, default 45; 60 for design runs; values under 20 are raised to 20, never refused): only the time the worker is working a turn counts, not time queued, idle between turns or waiting on a permission or question, and a turn still working when it is used up is stopped. The run view shows workMs (used) and workLeftMs (left).'
  ),
  budget_usd: z.number().min(0.01).max(1000).optional().describe(
    'Optional ceiling in USD for this one run (0.01-1000), inside its provider\'s share of the session budget. Omit it: the run may use what its provider\'s share has left (nothing is reserved; idle runs hold no money). Every provider is held to it: Claude between model calls, OpenCode per step, Codex per rollout record or turn (at list price). Ignored, with a correction, when the user chose No limit.'
  ),
  uses_browser: z.boolean().optional().describe(
    'true when the worker drives the SynaBun browser: it gets a loop browser tab and the browser enforcement block; page content is treated as untrusted data. Design runs default to true; false keeps one off the browser (no tab, no automatic browser group).'
  ),
  morelogin_profile: z.string().max(200).optional().describe(
    'With uses_browser: the MoreLogin profile (its id or its name, as the morelogin tool\'s "list" shows it) the worker\'s browser tab opens in, for this run only. Omit it for the default AI browser (Settings → Connected tools → MoreLogin). Workers on different profiles run side by side; two on the same profile share its browser, each in its own tab. Only a profile the owner allowed agents to choose (the morelogin tool\'s "list" and "status" say which; none until the owner switches one on in SynaBun\'s Settings → Connected tools → MoreLogin): any other is refused with MORELOGIN_PROFILE_NOT_ALLOWED and nothing starts; tell the user which profile to switch on and where, and never dispatch into another profile instead. Only a Chrome-type profile; one that is unknown, Firefox-type or cannot start fails the dispatch by name (never another profile or browser). Use it when the user names a profile or an account for the task: never change the default AI browser for one run.'
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
  offset: z.number().int().min(0).optional().describe(
    'For format "text" / "tail": the character the page starts at. Omit it to get the END of the text (the answer says totalChars and the offset that page starts at). To read a long report whole, start at offset 0 and pass each answer\'s nextOffset until it is null.'
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
    answers: z.record(z.unknown()).optional().describe('Question answers: Claude keys are the exact question text; Codex/choice/form keys are field ids (values may be {answers:[...]}); OpenCode keys are question text/header or index, with string-array values for multiple choices (decision "answer").'),
    note: z.string().max(2000).optional().describe('Optional message delivered to the worker with the decision.'),
  }).optional().describe('Answer a pending permission or question request instead of (or before) sending text.'),
  queue: z.boolean().optional().describe(
    'true to enqueue text while the worker is still running (delivered at its next idle point, in the order sent; it survives a server restart). At most 20 may wait for one run: more is refused with FOLLOW_UP_QUEUE_FULL. Default: send only when idle.'
  ),
};

export const agentWaitSchema = {
  run_id: optionalId('Single run to wait for.'),
  run_ids: z.array(z.string().min(1).max(200)).max(50).optional().describe('Up to 50 runs to wait for together (fan-out barrier). For more, give them one workflow_id.'),
  workflow_id: optionalId('Wait for every run of a workflow instead of listing ids. Runs dispatched into the workflow while the wait is open are waited for too.'),
  until: z.enum(['idle', 'terminal', 'event']).optional().describe(
    '"idle" (default): the current turn finished and its result is readable. "terminal": completed, failed, stopped or interrupted. "event": the next typed events of the runs (see kinds); the answer lists them with their seq and a cursor.'
  ),
  after_seq: z.number().int().min(0).optional().describe(
    'With until "event": only events after this seq. Pass the cursor of the previous agent_wait answer to continue exactly where it ended (nothing is missed or repeated; the same cursor returns the same events again if an answer was lost). Omit it on the first call: you get what you have not been told yet, then what comes.'
  ),
  kinds: z.array(z.enum(RUN_EVENT_KINDS)).max(RUN_EVENT_KINDS.length).optional().describe(
    'With until "event": only these kinds. Default: every kind except run.progress — run.result (a turn ended with its result), run.needs_input (a question), run.permission (a permission request), run.failed, run.stalled, run.stopped, run.interrupted, run.completed, run.budget, run.notice, run.message. Add run.progress to also see turns starting, queued follow-ups and the like.'
  ),
  mode: z.enum(['all', 'any']).optional().describe(
    'For run_ids / workflow_id: "all" returns when every run satisfies until (the default for "idle" and "terminal": a barrier); "any" returns on the first one (the default for "event": the next event of any of the runs).'
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
  'Discover what you can route to: providers (claude-code, codex, opencode, antigravity) with models (tier, price per 1M tokens, vision, context, efforts), plus `chat` (chat-only providers such as maritaca: a side panel the user talks to, prices in BRL, never a dispatch target), accounts with subscription usage remaining (or usage unknown; API keys are n/a), registered projects (cwd candidates), SynaBun tool groups and each host\'s effect, rails/limits, active runs, and `agents`: the SynaBun agents the owner approved, which a dispatch names with agent_ref (ref, name, description, provider/model, task classes, scope global or project, revision; provider and search filter them too). Without arguments it returns a compact routing view (OpenCode sampled); pass provider and/or search to list more models. Call it when the routing sheet in your instructions lacks a model, or after a MODEL_UNKNOWN rejection. Returns JSON.';

export const agentRouteDescription =
  'The runtime taskId owns one card: retries return it even with different wording or proposals. Only a genuinely separate subtask uses its own stable task_key. Plan the whole task before routing it once. At Pair/Team/Swarm, code/complex/research/review target 2/4/6 workers: pass planned_split with that many distinct titles or fewer with a reason. All four require cwd; a non-git project falls back to one worker with a reason. The card shows this split and one approval covers all workers. Follow next: agent_team plan → start for all splits. Research/review pass task_class and empty owned_paths: separate worktrees, no integration or landing; wait and synthesize. Never route individual slices. Other classes and Solo stay single. For work that requires access outside the worker sandbox, set needs_host:true. Only Here is available. The worker-only classes design, image_gen, and video_gen refuse needs_host:true with ROUTE_INVALID. Route an actionable task BEFORE starting it (you are the planner). Give task_class, a one-line summary, your honest confidence (0-1) and 1-3 proposals (direct = here on your model; dispatch = a worker provider/model). proposals.account_id accepts an account id or "auto" (most subscription usage left); limited pinned/default accounts fall back within the provider. The returned target.account includes usage and corrections explain the choice. The server applies the session\'s route mode (always ask / ask when unsure / never ask): it approves at once, or shows the user a route card and waits briefly. A planned split uses workers; on a single-task route card the user can pick here or a worker: follow the returned target.kind and next, never your proposal. Follow the returned status and next: approved+dispatch → follow next with the approved route_id; approved+direct → do it yourself (a route the user kept here is never dispatched: agent_dispatch refuses it with ROUTE_IS_DIRECT); continuation → end your turn (SynaBun continues on the chosen model); pending → end your turn, the choice arrives as a [SynaBun Mailbox] route_decided event; declined → do not start (reason no_capable_model: no model can make the image or video, or see for design; tell the user which Model routes row needs one); clarifying → end your turn, the user has not answered your agent_clarify questions yet (independent:true for a task that does not depend on them). image_gen / video_gen always route to a worker whose model generates the medium, design to a worker whose model can see. With a session budget, a provider whose share is used up cannot take the task: SynaBun first divides the unspent budget again, then moves the task to the next capable provider with money left (your next proposal, the same tier on another provider, then a free model) and says so in corrections (reason budget_share, "budget: codex share used up -> claude-code/sonnet"); the saved routes yield to this. When no provider can pay it declines with reason budget_exhausted and names the dry providers (dry). A host-only route on an unpriced provider declines with reason budget_unpriced (BUDGET_UNPRICED). The result carries budget: each provider\'s share, spent and left. Routed workers inherit the approved agent for their task class; agent_ref "none" opts out. A proposal may name an agent (agent_ref, with cwd for a project\'s own): it is a dispatch on what the agent runs on, unless the proposal names its own. Never use it for conversation or bookkeeping. Returns JSON.';

export const agentClarifyDescription =
  'Ask the user 1-3 targeted questions BEFORE routing a new request that is materially ambiguous: two plausible readings with different results, an unclear target (project, feature, files, audience), destructive or irreversible scope, spend, or memories that conflict with it. Not for clear requests, details a sensible default covers, anything the request, memory or the project answers, or the model (agent_route asks that). Each question gets 2-4 options (recommended first; the user can always type their own); add constraints (what the request fixes) and assumptions (what you will assume for the rest). The card waits briefly. Follow the returned status and next: answered → route, then agent_dispatch with the brief_id (SynaBun adds the user\'s original words, their answers, the constraints and assumptions to the worker\'s context); declined → proceed on your assumptions; pending → end your turn, the answers arrive as a [SynaBun Mailbox] clarify_answered event or as the user\'s next message, and dependent routes and dispatches wait until then. Returns JSON.';

export const agentListDescription =
  'List dispatched worker runs with status, state, provider/model, the agent a run runs as (agentRef, agentRevision; absent for a plain worker), title, elapsed time, work time left (workLeftMs), cost and resumes (how often a server restart cut the run off and it was resumed). Use it before dispatching more work, to recover run ids, or after a mailbox event. Filter with active_only, assistant_session_id (your own session) or workflow_id. Returns JSON.';

export const agentDispatchDescription =
  'Dispatch a task to a worker agent (Claude Code, Codex or OpenCode). Route it first with agent_route and pass the approved route_id (the server applies that provider/model/effort); without one, the dispatch may be held until the user picks a model (awaitingRoute:true — do not dispatch it again; if the user picks "here" instead, the run never starts and a route_decided mailbox event asks you to do the task yourself). A route_id the user decided to keep here is refused (ROUTE_IS_DIRECT): do that task yourself. After agent_clarify, pass its brief_id: the worker gets the user\'s own words and answers; while its questions are open a dependent dispatch is refused (CLARIFICATION_PENDING). The run attaches as a live automation tab in the matching sidepanel without stealing focus. Write a self-contained task that ends with a ## Result block, pass the absolute cwd and your assistant_session_id. Defaults: permission_policy "auto", capability "full", 45 minutes of work time (max_minutes, at least 20), no per-run dollar ceiling (with a budget the run draws from its provider\'s share; a provider whose share is used up and cannot get more is refused with BUDGET_SHARE_EXHAUSTED: route again). Use "ask" only for sensitive scopes (Codex cannot ask: use "restricted"). uses_computer:true for desktop work (one at a time, vision model). uses_browser:true with morelogin_profile (a profile id or name) opens the worker\'s browser tab in that MoreLogin profile for this run only, next to runs in the default or other profiles (only a profile the owner allowed agents to choose; MORELOGIN_PROFILE_NOT_ALLOWED otherwise: tell the user to switch it on in Settings). An image_gen / video_gen run makes the asset with its model\'s own generation tool; SynaBun collects the files into the run\'s result (media: path + url); with no model that generates the medium an un-routed dispatch is refused (NO_CAPABLE_MODEL), and a route_id approved for other work is refused for image_gen / video_gen / design (and the other way round: ROUTE_CLASS_MISMATCH; route the task again with its own class). A design run gets SynaBun\'s design rules and the project\'s style guide, defaults to capability "workspace", uses_browser true, browser, styleguide and image groups, and 60 minutes of work time (explicit values win), runs only on a model confirmed to see (MODEL_CANNOT_SEE otherwise), and its screenshots land in the result\'s media. The class agent applies automatically; agent_ref "none" opts out. An explicit agent_ref runs the worker as one of the owner\'s approved agents (agent_catalog agents): its definition fills what you leave out and its instructions become the worker\'s role, the run carries agentRef and agentRevision, and corrections list what the definition was held to. Group fan-outs with workflow_id, chain with parent_run_id, retry safely with idempotency_key. Over-limit dispatches are queued (queued:true, position). After dispatching, block with agent_wait rather than polling. Returns JSON.';

export const agentStatusDescription =
  'Get one run\'s current descriptor: status (queued, starting, running, completed, failed, stopped, interrupted), state (the detail: also idle, awaiting_permission, and suspended / resuming while a SynaBun server restart cuts a Claude Code worker off and the next start resumes it as the same run, its Claude session and its tab; resumes counts that, at most 3; a run that could not be resumed ends interrupted, with why in notes), turnState (running, idle, awaiting_permission), provider/model/account, the agent it runs as (agentRef, agentRevision, agentPin with what its definition was held to; absent for a plain worker), elapsed time (elapsedMs, wall clock), work time used and left of max_minutes (workMs, workLeftMs), cost, the last parsed result summary and any pending permission or question requests. Cheap; use it between agent_wait calls or before agent_send / agent_stop. Returns JSON.';

export const agentReadDescription =
  'Read a run\'s output. format "result" (default) returns the parsed ## Result contract (status, summary, changes, follow_ups, question, json, and media: the images / videos an image_gen or video_gen run generated or a design run captured, each { kind, path, url, mime, bytes } — show one with ![](url) plus its path); "tail" returns the last transcript events (also after the run ended or the server restarted); "text" the worker\'s assistant text; "files" the files it reported. Call after agent_wait reports idle or terminal; keep max_chars small. A text longer than max_chars is read in pages: the answer carries totalChars, offset and nextOffset; pass offset (0 for the start, then each nextOffset) to read the rest. Returns JSON.';

export const agentSendDescription =
  'Continue a worker\'s conversation. text sends a follow-up turn (queue:true enqueues it while the worker is still running, or while it is suspended / resuming after a server restart: it goes to the worker once resumed; queued follow-ups keep their order, survive a restart, and at most 20 wait per run). reply answers a pending permission or question request: decision allow/deny for tools, answer (with answers) for questions, note as an optional message. Obtain request ids from agent_status or agent_wait until="event". A follow-up to a run whose work time (max_minutes) is used up is refused with TIME_CAP: dispatch a new run with its result as context. Returns JSON.';

export const agentWaitDescription =
  'Blocking barrier for orchestration. Waits up to timeout_seconds (max 120) for one run (run_id), several runs (run_ids with mode all/any) or a whole workflow to reach until="idle" (turn finished; default), "terminal" (completed, failed, stopped, interrupted) or "event" (typed events: by default a result, a question, a permission request, a failure, a stall, a stop; narrow with kinds). An "event" answer lists the events with their seq and a cursor: pass it back as after_seq to go on from there. A workflow wait follows runs added to the workflow while it waits. A run suspended or resuming after a SynaBun server restart is still working: keep waiting (a wait cut off by the restart is simply called again, with the same after_seq). Returns the run descriptors and whether the wait timed out; call again to keep waiting. Prefer this over polling agent_status. Returns JSON.';

export const agentStopDescription =
  'Stop work. run_id stops one run; all:true with your assistant_session_id stops every run of this assistant session, workflow_id every run of a workflow (kill-all). Use when the user cancels, a worker misbehaves, or a time/budget rail is at risk. Returns JSON.';

export const agentFocusDescription =
  'Bring a run\'s sidepanel automation tab to the front (focus:false releases it). Use when the user asks to watch a worker; dispatches never steal focus by themselves. Returns JSON.';

export const agentUsageDescription =
  'Get token usage for a task, run, or entire Assistant session. Returns compact JSON. `session` is the headline the panel shows: every task of this session added up (it only grows, and survives a restart), with a per-model breakdown (models: inputTotal, outputTotal, total, costUsd, costBasis). Below it the task asked for: tokens, USD cost, fidelity, unsynced (rows not on disk yet, normally 0), and each agent\'s key, title, provider, model, total, sub-agents total, fidelity and state (partialReason when a count is partial; calls on the Jev judgments row). `budget` is the session budget: mode (limited / unlimited: the user chose No limit), the amount, spent and left, warned / exceeded, how the split was made (source jev | fallback, updatedAt) and each provider\'s share, spent and left (brain marks your own provider; leftUsd is what its workers may still spend), and dry: the providers whose share is used up. Every tokens object has the five additive classes (input = uncached input, cacheWrite, cacheRead, output = visible output, reasoning), total, inputTotal (input + cacheWrite + cacheRead: everything sent to the model) and outputTotal (output + reasoning): the same meaning for every provider, nothing counted twice. costUsd is at API list prices; costBasis says how it is known: reported (the provider reported it), estimated (tokens at list price: Codex and other plan-billed work, where it is the list-price equivalent, not a charge), free, or unpriced (no list price: tokens counted, no dollars). Counts are exact provider counts when fidelity is exact; live marks provisional counts and partial marks incomplete counts. metered:false means this server keeps no usage ledger. No routing is needed.';

// ════ agents-p4 BEGIN: agent_team ════
// One task given to several workers (neural-interface/lib/teams/scheduler.js). The same role gate as every agent_*
// tool; the Neural Interface enforces the session's Agent density, the plan's rules and the landing rule.
export const AGENT_TEAM_ACTIONS = ['plan', 'start', 'status', 'assign', 'set_test_command', 'integrate', 'land', 'cleanup', 'discard', 'list'] as const;
/** The most slices any Agent density allows (Swarm). */
export const AGENT_TEAM_MAX_SLICES = 6;

const teamSliceSchema = z.object({
  id: z.string().min(1).max(40).describe('Short lower-case name of the slice, e.g. "api" ("integration" is reserved).'),
  title: z.string().min(1).max(SLICE_TITLE_MAX).describe(`What this part is, in a few words; exactly the approved route's planned_split title (an older route's longer title: its first ${SLICE_TITLE_MAX} characters).`),
  task: z.string().min(1).max(16000).describe('Self-contained instructions for this slice\'s worker: goal, constraints, acceptance. It sees only its own slice, plus which files the other slices own.'),
  owned_paths: z.array(z.string().min(1).max(300)).max(64).optional().describe('The files this slice may write, as patterns relative to the project ("src/api/**", "docs/guide.md"). No file may be owned by two slices. Research/review omit this or pass [] (read-only).'),
  depends_on: z.array(z.string().min(1).max(40)).max(5).optional().describe('Slices that must be joined before this one starts (it then starts from their finished work).'),
  lockfile_owner: z.boolean().optional().describe('true for the one slice that may change dependency lockfiles and manifests (at most one slice).'),
  agent_ref: z.string().min(1).max(140).optional().describe('Run this slice\'s worker as one of the owner\'s agents (an id from agent_catalog agents).'),
});

export const agentTeamSchema = {
  action: z.enum(AGENT_TEAM_ACTIONS).describe(
    'plan: check a plan (density, overlapping files, dependency cycles) and return it normalized; creates nothing. start: create the worktrees and dispatch the workers. status: slices, runs, claims, the integration branch, the last events. assign: give unowned paths to a slice. set_test_command: correct the test command before the first join attempt. integrate: try again after a needs_attention. land: the integration branch into the user\'s branch. cleanup: after successful land and the user\'s yes, delete finished team worktrees/branches. discard: give the team up. list: this session\'s teams.'
  ),
  assistant_session_id: optionalId('Your ASSISTANT_SESSION_ID (plan, start, list).'),
  team_id: z.string().min(1).max(40).optional().describe('Required for status, assign, set_test_command, integrate, land, cleanup and discard. For start, use the team_id from plan or let the server generate one.'),
  title: z.string().min(1).max(80).optional().describe('plan / start: the team\'s task in a few words.'),
  project_path: z.string().min(1).max(1024).optional().describe('plan / start: absolute path of the project (a git repository with at least one commit; pick from agent_catalog projects).'),
  base_commit: z.string().min(40).max(64).optional().describe('start: the full commit id the plan action pinned (omitted: the project\'s current commit).'),
  fewer_reason: z.string().min(1).max(400).optional().describe('Required when slices are fewer than density. Must match planned_split.reason on the approved route.'),
  slices: z.array(teamSliceSchema).min(1).max(AGENT_TEAM_MAX_SLICES).optional().describe('plan / start: the parts of the task, one worker each. At most what the session\'s Agent density allows (Pair 2, Team 4, Swarm 6; Solo: no team).'),
  test_command: z.string().min(1).max(600).optional().describe('start / set_test_command: what proves the joined work, run on the integration branch after every join (e.g. "npm test"). The first join attempt locks this command. Without one nothing is tested and you cannot land.'),
  route_id: optionalId('start: the route_id agent_route returned with status "approved" for this task. One route covers every slice.'),
  task_class: z.enum(TASK_CLASSES).optional().describe('plan/start: code (default), complex, research or review. Research/review have read-only worktrees, no integration branch, tests or landing; the approved route must match.'),
  provider: z.enum(PROVIDERS).optional().describe('start: the worker runtime, when there is no route_id and a slice names no agent_ref.'),
  model: z.string().max(200).optional().describe('start: model id for the workers (the approved route wins).'),
  effort: z.string().max(40).optional().describe('start: reasoning effort for the workers.'),
  account_id: z.string().max(200).optional().describe('start: account profile id, or "auto".'),
  tools: z.array(z.string().min(1).max(72)).max(32).optional().describe('start: SynaBun tool groups for the workers, as for agent_dispatch. The team tool is added by itself.'),
  max_minutes: z.number().int().min(1).max(1440).optional().describe('start: work time per worker, in minutes.'),
  permission_policy: z.enum(['auto', 'ask', 'restricted']).optional().describe('start: as for agent_dispatch (default auto).'),
  context: z.string().max(8000).optional().describe('start: background every worker of the team gets (decisions already taken, conventions).'),
  tags: z.array(z.string().min(1).max(40)).max(6).optional().describe('start: tags for the runs.'),
  brief_id: optionalId('start: the brief_id of a clarification, so every worker gets the user\'s own words and answers.'),
  slice_id: z.string().min(1).max(40).optional().describe('assign: the slice receiving the paths. integrate: retry only this slice (omitted: every slice that is not joined).'),
  paths: z.array(z.string().min(1).max(300)).min(1).max(64).optional().describe('assign: unowned project-relative paths or patterns to add to this slice, using the plan’s ownership rules.'),
  target_branch: z.string().min(1).max(200).optional().describe('land: the branch that receives the work (default: the branch checked out in the project).'),
  mode: z.enum(['ff', 'merge']).optional().describe('land: "ff" (default) moves the branch forward to the integration branch; "merge" makes a merge commit.'),
  user_confirmed: z.boolean().optional().describe('cleanup: true only after the user says yes to deleting the landed team worktrees and branches; otherwise refused locally.'),
  reason: z.string().max(240).optional().describe('discard: why.'),
};

export const agentTeamDescription =
  'Code/complex/research/review: plan the task first, then target the session density (Pair 2, Team 4, Swarm 6). Fewer slices require fewer_reason matching the approved route. agent_route planned_split must match the project, count and titles. One approved route covers all slices, including replacements; never route a slice. Research/review use task_class and empty owned_paths: every worker gets its own worktree from one pinned commit, removed when it ends. Changes or commits are kept and reported. No integration branch, test_command or landing; wait and synthesize their results. Give ONE task to several workers at once, each in its own git worktree and branch (never the user\'s checkout or branch). Code/complex tasks need file-disjoint parts; research/review need distinct read-only scopes, within the user\'s Agent density (Solo 1: no team; Pair 2; Team 4; Swarm 6): SynaBun refuses a team at Solo (TEAM_DENSITY_SOLO) and a plan with more slices than the level allows (TEAM_TOO_MANY_SLICES), with overlapping files or a dependency cycle. ' +
  'Flow: agent_route the task once → action "plan" (returns the normalized plan with its team_id and base_commit, the density check and any errors; creates nothing) → action "start" with that plan and the approved route_id (returns workflow_id) → agent_wait on the workflow_id → a team_ready mailbox event → action "status" → action "land", or ask the user. ' +
  'For a request_change on an unowned path, use "assign" with team_id, slice_id and paths. The worker receives the new scope. Use "set_test_command" to correct the verification command before the first join attempt. ' +
  'SynaBun commits each finished slice\'s own files, joins them on synabun/<team>/integration in dependency order and runs test_command on that exact commit; a conflict or failed tests go back to the slice\'s worker with the report (twice), then a needs_attention event reaches you: read "status", help with agent_send, then "integrate", or "discard". ' +
  'Landing rule: land yourself only when you judge the work ready, the integration tests passed, the user\'s branch has not moved and no file with local changes is touched; land returns SynaBun\'s refusal report unchanged (TESTS_NOT_PASSED, NOT_FAST_FORWARD, OWNER_BRANCH_MOVED, DIRTY_FILES_AFFECTED, TEAM_NOT_READY…). On a refusal do not retry or work around it: ask the user. ' +
  'Cleanup: successful land returns cleanup (worktrees, branches). When the task is fully finished, suggest deleting them with a synabun-followups confirm card. Only after the user says yes call cleanup with team_id and user_confirmed:true. The server requires a landed team, every run ended done, every branch merged into the target and every worktree clean. Refusals CLEANUP_NOT_CONFIRMED, TEAM_NOT_LANDED, TEAM_RUNS_ACTIVE, BRANCH_NOT_MERGED, BRANCH_MOVED (a branch moved after the check), WORKTREE_DIRTY remove nothing: keep them and tell the user which check failed. Never delete team worktrees or branches with git directly. Returns JSON.';

export type AgentTeamArgs = z.infer<z.ZodObject<typeof agentTeamSchema>>;
// ════ agents-p4 END ════

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
    agent_ref: args.agent_ref,
    assistantSessionId: args.assistant_session_id,
    task_class: args.task_class,
    task_key: args.task_key,
    summary: args.summary,
    confidence: args.confidence,
    needs_host: args.needs_host,
    needs_vision: args.needs_vision,
    planned_split: args.planned_split,
    proposals: args.proposals,
    independent: args.independent,
    cwd: args.cwd,
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
    if (Object.hasOwn(args, 'mcp_profile') || Object.hasOwn(args, 'mcpProfile')) {
      return { ...json({ ok: false, code: 'MCP_PROFILE_REMOVED', message: 'MCP profiles were removed; pass tools: [group ids].' }), isError: true };
    }
    if (!args.provider && !args.route_id && !args.task_class && (!args.agent_ref || args.agent_ref === 'none')) return invalid('Provide provider, task_class, the route_id of an approved agent_route, or a named agent_ref.');
    const selection = resolveToolList(args.tools, { source: 'dispatch', provider: args.provider, usesBrowser: args.uses_browser, taskClass: args.task_class });
    if (!selection.ok) return { ...json(selection), isError: true };
    return json(await ni.assistantDispatch({
    provider: args.provider,
    task: args.task,
    cwd: args.cwd,
    assistantSessionId: args.assistant_session_id,
    model: args.model,
    effort: args.effort,
    tools: args.tools,
    routeId: args.route_id,
    workerIndex: args.worker_index,
    taskClass: args.task_class,
    confidence: args.confidence,
    usesComputer: args.uses_computer,
    agent: args.agent,
    // A SynaBun agent (lib/agents/resolve.js resolves it at the dispatcher's intake); `agent` above is OpenCode's own.
    agentRef: args.agent_ref,
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
    moreloginProfile: args.morelogin_profile,
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
    return json(await ni.assistantTranscript(args.run_id, { format, tail: args.tail, maxChars: args.max_chars, offset: args.offset }));
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
      return json(await ni.assistantWaitRun(args.run_id, { until, timeoutMs, afterSeq: args.after_seq, kinds: args.kinds }));
    }
    if (args.run_id && !runIds.includes(args.run_id)) runIds.unshift(args.run_id);
    return json(await ni.assistantWaitMany({
      runIds: runIds.length ? runIds : undefined,
      workflowId: args.workflow_id,
      mode: args.mode || (until === 'event' ? 'any' : 'all'),
      until,
      timeoutMs,
      afterSeq: args.after_seq,
      kinds: args.kinds,
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
    /** The session budget: the mode, the total, and each provider's share / spent / left. */
    const compactBudget = (b: any) => {
      if (!b || typeof b !== 'object') return null;
      if (b.unlimited) return { mode: 'unlimited', spentUsd: b.spentUsd ?? 0 };
      return {
        mode: 'limited', amountUsd: b.amountUsd ?? null, spentUsd: b.spentUsd ?? 0, leftUsd: b.leftUsd ?? null,
        warnAtUsd: b.warnAtUsd ?? null, warned: !!b.warned, exceeded: !!b.exceeded,
        split: b.split ? { source: b.split.source ?? null, reason: b.split.reason ?? null, updatedAt: b.split.updatedAt ?? null } : null,
        providers: (Array.isArray(b.providers) ? b.providers : []).map((row: any) => ({
          provider: row.provider, ...(row.isBrain ? { brain: true } : {}), eligible: row.eligible !== false,
          shareUsd: row.shareUsd ?? null, spentUsd: row.spentUsd ?? 0, leftUsd: row.workerLeftUsd ?? row.leftUsd ?? null,
          ...(row.isBrain ? { brainLeftUsd: row.leftUsd ?? null } : {}),
        })),
        dry: Array.isArray(b.dry) ? b.dry : [],
      };
    };
    const budget = compactBudget((answer as any).budget);
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
      if (!session) return text(JSON.stringify({ sessionId: args.assistant_session_id, metered: false, tokens: null, costUsd: 0, tasks: [], budget }));
      const { tasks: _taskCount, ...totals } = sessionHead(session);
      const head = { sessionId: session.sessionId, ...totals, unsynced: session.unsynced ?? 0, budget };
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
    if (!view) return text(JSON.stringify({ sessionId: args.assistant_session_id, metered: false, task: null, tokens: null, costUsd: 0, fidelity: null, agents: [], budget }));
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
      budget,
    }));
  });
}

// ════ agents-p4 BEGIN: agent_team ════
/** A plan in the Neural Interface's spelling (lib/teams/schema.js), from the tool's arguments. */
function teamPlanBody(args: AgentTeamArgs): Record<string, unknown> {
  return {
    title: args.title,
    taskClass: args.task_class,
    assistantSessionId: args.assistant_session_id,
    plan: {
      teamId: args.team_id,
      projectPath: args.project_path,
      baseCommit: args.base_commit,
      fewerReason: args.fewer_reason,
      slices: (args.slices || []).map((slice) => ({
        id: slice.id, title: slice.title, task: slice.task, ownedPaths: slice.owned_paths || [],
        dependsOn: slice.depends_on || [], lockfileOwner: slice.lockfile_owner === true,
        ...(slice.agent_ref ? { agentRef: slice.agent_ref } : {}),
      })),
    },
  };
}

export function handleAgentTeam(args: AgentTeamArgs): Promise<ToolResult> {
  return guarded(async () => {
    const needTeam = () => (args.team_id ? null : invalid(`${args.action} needs team_id.`));
    switch (args.action) {
      case 'list':
        return json(await ni.assistantTeamList({ assistantSessionId: args.assistant_session_id }));
      case 'plan':
      case 'start': {
        if (!args.project_path) return invalid(`${args.action} needs project_path: the project's absolute path.`);
        if (!args.slices?.length) return invalid(`${args.action} needs slices: the parts of the task, each with the files it owns.`);
        if (args.action === 'plan') return json(await ni.assistantTeamPlan(teamPlanBody(args)));
        if (args.tools) {
          const selection = resolveToolList(args.tools, { source: 'dispatch', provider: args.provider, taskClass: args.task_class });
          if (!selection.ok) return { ...json(selection), isError: true };
        }
        return json(await ni.assistantTeamStart({
          ...teamPlanBody(args),
          testCommand: args.test_command, routeId: args.route_id, taskClass: args.task_class,
          provider: args.provider, model: args.model, effort: args.effort, accountId: args.account_id, tools: args.tools,
          maxMinutes: args.max_minutes, permissionPolicy: args.permission_policy, context: args.context, tags: args.tags, briefId: args.brief_id,
        }));
      }
      case 'status':
        return needTeam() ?? json(await ni.assistantTeamStatus(args.team_id as string));
      case 'assign':
        if (!args.team_id || !args.slice_id || !args.paths?.length) return invalid('assign needs team_id, slice_id and paths.');
        return json(await ni.assistantTeamAssign(args.team_id, args.slice_id, args.paths));
      case 'set_test_command':
        if (!args.team_id || !args.test_command?.trim()) return invalid('set_test_command needs team_id and test_command.');
        return json(await ni.assistantTeamSetTestCommand(args.team_id, args.test_command));
      case 'integrate':
        return needTeam() ?? json(await ni.assistantTeamIntegrate(args.team_id as string, { sliceId: args.slice_id }));
      case 'land':
        return needTeam() ?? json(await ni.assistantTeamLand(args.team_id as string, { targetBranch: args.target_branch, mode: args.mode }));
      case 'cleanup':
        if (args.user_confirmed !== true) return json({ ok: false, code: 'CLEANUP_NOT_CONFIRMED', message: 'Cleanup requires the user to confirm deleting the team worktrees and branches.' });
        return needTeam() ?? json(await ni.assistantTeamCleanup(args.team_id as string, { targetBranch: args.target_branch, mode: args.mode, user_confirmed: true }));
      case 'discard':
        return needTeam() ?? json(await ni.assistantTeamDiscard(args.team_id as string, { reason: args.reason }));
      default:
        return invalid(`Unknown action. Use one of ${AGENT_TEAM_ACTIONS.join(', ')}.`);
    }
  });
}
// ════ agents-p4 END ════

// ── Registration ──

/**
 * Register the agent_* tools on a server. Returned handles are stored as the
 * `agents` tool group so ToolRuntime can gate them on the caller role.
 */
export function registerAgentTools(server: McpServer) {
  return [
    server.tool('agent_catalog',  agentCatalogDescription,  agentCatalogSchema,  (args) => handleAgentCatalog(args)),
    server.tool('agent_list',     agentListDescription,     agentListSchema,     (args) => handleAgentList(args)),
    // Claude resumes conversations with their deferred tools. Keep this first-step tool in the
    // current prompt so routing uses the schema advertised by the live MCP connection.
    server.registerTool('agent_route', {
      description: agentRouteDescription, inputSchema: agentRouteSchema, _meta: { 'anthropic/alwaysLoad': true },
    }, (args) => handleAgentRoute(args)),
    server.tool('agent_clarify',  agentClarifyDescription,  agentClarifySchema,  (args) => handleAgentClarify(args)),
    // Preserve unknown input until the handler can reject retired fields from cached client schemas.
    // Neither retired spelling is advertised or accepted as a working dispatch field.
    server.registerTool('agent_dispatch', { description: agentDispatchDescription, inputSchema: z.object(agentDispatchSchema).passthrough() }, (args) => handleAgentDispatch(args)),
    server.tool('agent_status',   agentStatusDescription,   agentStatusSchema,   (args) => handleAgentStatus(args)),
    server.tool('agent_read',     agentReadDescription,     agentReadSchema,     (args) => handleAgentRead(args)),
    server.tool('agent_send',     agentSendDescription,     agentSendSchema,     (args) => handleAgentSend(args)),
    server.tool('agent_wait',     agentWaitDescription,     agentWaitSchema,     (args) => handleAgentWait(args)),
    server.tool('agent_stop',     agentStopDescription,     agentStopSchema,     (args) => handleAgentStop(args)),
    server.tool('agent_focus',    agentFocusDescription,    agentFocusSchema,    (args) => handleAgentFocus(args)),
    server.tool('agent_usage',    agentUsageDescription,    agentUsageSchema,    (args) => handleAgentUsage(args)),
    server.tool('agent_team',     agentTeamDescription,     agentTeamSchema,     (args) => handleAgentTeam(args)), // agents-p4
  ];
}
