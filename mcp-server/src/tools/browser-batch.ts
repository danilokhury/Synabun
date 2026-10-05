import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import * as navigate from './browser-navigate.js';
import * as interact from './browser-interact.js';
import * as observe from './browser-observe.js';
import * as advanced from './browser-advanced.js';
import { text } from './response.js';
import * as assist from '../services/browser-assist.js';

type ToolResponse = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolEntry = { schema: z.AnyZodObject; run: (args: Record<string, unknown>) => Promise<ToolResponse> };
function entry<S extends z.ZodRawShape>(schema: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResponse>): ToolEntry {
  return { schema: z.object(schema).strict(), run: run as ToolEntry['run'] };
}

// Fixed allowlist: never dispatch arbitrary tool names or browser JavaScript.
const registry = {
  browser_navigate: entry(navigate.browserNavigateSchema, navigate.handleBrowserNavigate),
  browser_go_back: entry(navigate.browserGoBackSchema, navigate.handleBrowserGoBack),
  browser_go_forward: entry(navigate.browserGoForwardSchema, navigate.handleBrowserGoForward),
  browser_reload: entry(navigate.browserReloadSchema, navigate.handleBrowserReload),
  browser_click: entry(interact.browserClickSchema, interact.handleBrowserClick),
  browser_fill: entry(interact.browserFillSchema, interact.handleBrowserFill),
  browser_type: entry(interact.browserTypeSchema, interact.handleBrowserType),
  browser_hover: entry(interact.browserHoverSchema, interact.handleBrowserHover),
  browser_select: entry(interact.browserSelectSchema, interact.handleBrowserSelect),
  browser_press: entry(interact.browserPressSchema, interact.handleBrowserPress),
  browser_scroll: entry(interact.browserScrollSchema, interact.handleBrowserScroll),
  browser_upload: entry(interact.browserUploadSchema, interact.handleBrowserUpload),
  browser_snapshot: entry(observe.browserSnapshotSchema, observe.handleBrowserSnapshot),
  browser_content: entry(observe.browserContentSchema, observe.handleBrowserContent),
  browser_wait: entry(advanced.browserWaitSchema, advanced.handleBrowserWait),
  browser_extract_tweets: entry(observe.browserExtractTweetsSchema, observe.handleBrowserExtractTweets),
  browser_x_compose_state: entry(observe.browserXComposeStateSchema, observe.handleBrowserXComposeState),
  browser_extract_fb_posts: entry(observe.browserExtractFbPostsSchema, observe.handleBrowserExtractFbPosts),
  browser_fb_composer_state: entry(observe.browserFbComposerStateSchema, observe.handleBrowserFbComposerState),
  browser_extract_fb_groups: entry(observe.browserExtractFbGroupsSchema, observe.handleBrowserExtractFbGroups),
  browser_extract_tiktok_videos: entry(observe.browserExtractTiktokVideosSchema, observe.handleBrowserExtractTiktokVideos),
  browser_extract_tiktok_search: entry(observe.browserExtractTiktokSearchSchema, observe.handleBrowserExtractTiktokSearch),
  browser_extract_tiktok_studio: entry(observe.browserExtractTiktokStudioSchema, observe.handleBrowserExtractTiktokStudio),
  browser_extract_tiktok_profile: entry(observe.browserExtractTiktokProfileSchema, observe.handleBrowserExtractTiktokProfile),
  browser_extract_wa_chats: entry(observe.browserExtractWaChatsSchema, observe.handleBrowserExtractWaChats),
  browser_extract_wa_messages: entry(observe.browserExtractWaMessagesSchema, observe.handleBrowserExtractWaMessages),
  browser_extract_ig_feed: entry(observe.browserExtractIgFeedSchema, observe.handleBrowserExtractIgFeed),
  browser_extract_ig_profile: entry(observe.browserExtractIgProfileSchema, observe.handleBrowserExtractIgProfile),
  browser_extract_ig_post: entry(observe.browserExtractIgPostSchema, observe.handleBrowserExtractIgPost),
  browser_extract_ig_reels: entry(observe.browserExtractIgReelsSchema, observe.handleBrowserExtractIgReels),
  browser_extract_ig_search: entry(observe.browserExtractIgSearchSchema, observe.handleBrowserExtractIgSearch),
  browser_extract_li_feed: entry(observe.browserExtractLiFeedSchema, observe.handleBrowserExtractLiFeed),
  browser_extract_li_profile: entry(observe.browserExtractLiProfileSchema, observe.handleBrowserExtractLiProfile),
  browser_extract_li_post: entry(observe.browserExtractLiPostSchema, observe.handleBrowserExtractLiPost),
  browser_extract_li_notifications: entry(observe.browserExtractLiNotificationsSchema, observe.handleBrowserExtractLiNotifications),
  browser_extract_li_messages: entry(observe.browserExtractLiMessagesSchema, observe.handleBrowserExtractLiMessages),
  browser_extract_li_search_people: entry(observe.browserExtractLiSearchPeopleSchema, observe.handleBrowserExtractLiSearchPeople),
  browser_extract_li_network: entry(observe.browserExtractLiNetworkSchema, observe.handleBrowserExtractLiNetwork),
  browser_extract_li_jobs: entry(observe.browserExtractLiJobsSchema, observe.handleBrowserExtractLiJobs),
} as const;

type BatchToolName = keyof typeof registry;
const toolNames = Object.keys(registry) as [BatchToolName, ...BatchToolName[]];
const stepSchema = z.object({
  tool: z.enum(toolNames).describe('Existing browser tool to execute.'),
  args: z.record(z.unknown()).default({}).describe('Arguments for that tool; omit sessionId, tabId and snapshot controls.'),
  observe: z.boolean().optional().describe('Include an intermediate snapshot after this step.'),
}).strict();
export const browserBatchSchema = {
  steps: z.array(stepSchema).min(1).max(10),
  sessionId: z.string().optional(),
  tabId: z.string().optional(),
  snapshot: z.enum(['full', 'diff', 'none']).default('full').describe('Final observation; default full.'),
};
export const browserBatchDescription = 'Run up to 10 known browser steps sequentially on one owned tab. Uses existing guarded tools, stops on the first failure, and returns one final snapshot by default. Never retry the whole batch after a partial failure. Steps run exactly as written: no Jev assistance inside a batch. A batch that navigated may end with one advisory "assessment" of the final page.';

const targetedTools = new Set(['browser_click', 'browser_fill', 'browser_hover', 'browser_select', 'browser_upload']);
const inlineSnapshotTools = new Set(['browser_navigate', 'browser_click', 'browser_scroll']);
const forbiddenArgs = ['sessionId', 'tabId', 'snapshot', 'returnSnapshot'];

interface BrowserBatchInput {
  steps: Array<{ tool: BatchToolName; args?: Record<string, unknown>; observe?: boolean }>;
  sessionId?: string;
  tabId?: string;
  snapshot?: 'full' | 'diff' | 'none';
}

export async function handleBrowserBatch(input: BrowserBatchInput, extra?: { signal?: AbortSignal }) {
  return ni.runWithBrowserCancellation(extra?.signal, () => executeBrowserBatch(input, extra?.signal), 'batch');
}

async function executeBrowserBatch(input: BrowserBatchInput, signal?: AbortSignal) {
  const cancelled = () => signal?.aborted;
  const cancellation = { error: 'Browser batch cancelled before the next operation.', code: 'BATCH_CANCELLED', actionStarted: false };
  if (cancelled()) return { ...text(JSON.stringify({ completedSteps: 0, results: [], failure: cancellation })), isError: true };
  if (!ni.isBrowserV2Enabled()) return { ...text('browser_batch is disabled by SYNABUN_BROWSER_V2=0. Remove the override on the MCP and browser servers to restore the default browser engine.'), isError: true };
  const parsed = z.object(browserBatchSchema).strict().safeParse(input);
  if (!parsed.success) return { ...text(`Invalid batch: ${parsed.error.message}`), isError: true };

  // Validate every step before performing any side effect.
  const steps: Array<{ tool: BatchToolName; args: Record<string, unknown>; observe?: boolean }> = [];
  for (const [index, step] of parsed.data.steps.entries()) {
    const forbidden = forbiddenArgs.find(key => key in step.args);
    const validated = registry[step.tool].schema.safeParse(step.args);
    let error = forbidden ? `Set ${forbidden} only on the batch, not a step.` : validated.success ? undefined : validated.error.message;
    if (targetedTools.has(step.tool) && !step.args.ref && !step.args.selector) error = 'Provide ref or selector.';
    if (step.tool === 'browser_content' && step.args.url) error = 'Batch content must read the owned tab; omit url.';
    if (step.tool === 'browser_extract_fb_groups' && step.args.seedQueueId) error = 'Queue seeding is not a batch operation; omit seedQueueId.';
    if (step.tool === 'browser_wait' && step.args.timeout !== undefined
      && (!Number.isFinite(Number(step.args.timeout)) || Number(step.args.timeout) < 0 || Number(step.args.timeout) > 30000)) error = 'Wait timeout must be between 0 and 30000ms.';
    if (error || !validated.success) return { ...text(JSON.stringify({ completedSteps: 0, failedStep: index + 1, error })), isError: true };
    steps.push({ tool: step.tool, args: validated.data, observe: step.observe });
  }

  const route = await ni.resolveBatchRoute(parsed.data.sessionId, parsed.data.tabId);
  if (cancelled()) return { ...text(JSON.stringify({ completedSteps: 0, results: [], failure: cancellation })), isError: true };
  if ('error' in route) return { ...text(route.error), isError: true };
  const context: ni.BrowserBatchContext = { route, errors: [] };
  const outcome = await ni.runBrowserBatchContext(context, async () => {
    const results: Array<Record<string, unknown>> = [];
    for (const [index, step] of steps.entries()) {
      if (cancelled()) return { ...text(JSON.stringify({ completedSteps: results.length, results, stoppedBeforeStep: index + 1, failure: cancellation })), isError: true };
      try {
        const args = { ...step.args, ...route, ...(inlineSnapshotTools.has(step.tool) && { snapshot: 'none' }) };
        const result = await registry[step.tool].run(args);
        if (context.errors.length || result.isError) {
          return { ...text(JSON.stringify({ completedSteps: results.length, results, failedStep: index + 1,
            failure: context.errors[0] || { error: 'Tool failed' }, stepResult: result.content })), isError: true };
        }
        const completed: Record<string, unknown> = { step: index + 1, tool: step.tool, content: result.content };
        results.push(completed);
        if (step.observe && step.tool !== 'browser_snapshot') {
          if (cancelled()) return { ...text(JSON.stringify({ completedSteps: results.length, results, failure: cancellation })), isError: true };
          const observation = await observe.handleBrowserSnapshot({ ...route, maxChars: 12000 });
          if (context.errors.length || (observation as ToolResponse).isError) {
            return { ...text(JSON.stringify({ completedSteps: results.length, results, failedStep: index + 1,
              failure: context.errors[0] || { error: 'Intermediate observation failed' } })), isError: true };
          }
          completed.observation = observation.content;
        }
      } catch (error) {
        return { ...text(JSON.stringify({ completedSteps: results.length, results, failedStep: index + 1,
          failure: { error: error instanceof Error ? error.message : String(error), outcome: 'uncertain' } })), isError: true };
      }
    }
    const last = steps[steps.length - 1];
    if (parsed.data.snapshot !== 'none' && !last.observe && last.tool !== 'browser_snapshot') {
      if (cancelled()) return { ...text(JSON.stringify({ completedSteps: results.length, results, failure: cancellation })), isError: true };
      const finalObservation = await observe.handleBrowserSnapshot({ ...route, diff: parsed.data.snapshot === 'diff', maxChars: 12000 });
      if (context.errors.length || (finalObservation as ToolResponse).isError) {
        return { ...text(JSON.stringify({ completedSteps: results.length, results, failure: context.errors[0] || { error: 'Final observation failed' } })), isError: true };
      }
      return text(JSON.stringify({ completedSteps: results.length, results, observation: finalObservation.content }));
    }
    return text(JSON.stringify({ completedSteps: results.length, results }));
  });
  return annotateBatch(outcome, steps.some(step => step.tool === 'browser_navigate'), route, signal);
}

/**
 * One page-state assessment of where a batch that navigated ended up. It runs after the batch
 * context has closed, so an advisory failure cannot be recorded as a step error, and it only
 * ever adds a key: steps are never added, replaced or replayed. Skipped when the batch was
 * cancelled or its outcome is uncertain — inspecting the page is the caller's next move then.
 */
async function annotateBatch<T extends { content?: Array<{ type: string; text?: string }> }>(outcome: T, navigated: boolean, route: { sessionId: string; tabId?: string }, signal?: AbortSignal): Promise<T> {
  if (!navigated || signal?.aborted) return outcome;
  const raw = outcome.content?.[0]?.text;
  if (typeof raw !== 'string') return outcome;
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return outcome; }
  const failure = body.failure as { code?: string; outcome?: string; actionStarted?: boolean } | undefined;
  if (failure && (failure.outcome === 'uncertain' || failure.actionStarted === true || /CANCELLED/.test(String(failure.code ?? '')))) return outcome;
  if (!Number(body.completedSteps)) return outcome;
  try {
    const { advice } = await assist.assessCurrentPage(route.sessionId, route.tabId, { operation: 'batch', purpose: 'batch' });
    const assessment = assist.formatAssessment(advice, false);
    if (!assessment) return outcome;
    return { ...outcome, ...text(JSON.stringify({ ...body, assessment })) };
  } catch { return outcome; }
}
