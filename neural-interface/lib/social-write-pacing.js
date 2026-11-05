// ── Spacing the social writes a scheduled automation makes (DOM-free) ──
//
// Automations were told by their task to "space every write 60 to 180 seconds apart", and did it themselves:
// Claude Code refuses a foreground `sleep 90`, so the agent started a background sleep or a Monitor and ended its
// turn to wait for it, and the run stopped there (lib/claude-background-hold.js is the other half of that fix).
// The wait belongs to SynaBun: a loop's Bluesky write (post, reply, like, repost, follow and their undos, a DM)
// waits out the gap inside the tool call that makes it.
//
// One queue per platform and signed-in account (socialPaceAccountKey: the browser profile, never the session id, so
// a session that is closed and opened again keeps its gap): concurrent runs on the same account take turns, and
// the gap is measured from the last write that went out. A write whose tab is gone before it starts takes no slot. A tool call has a time limit (Codex and
// OpenCode stop an MCP call at about 60 s), so a call waits at most `maxWaitMs`: when more of the gap is left, it
// writes nothing and answers how much is left (`paced`), and the next call waits the rest. The agent never sleeps.
//
// Only loop-owned requests are paced (server.js isLoopPaced): an interactive session writes at once.

/** The gap between two writes of one account, by platform: randomized per write, so the rhythm is not robotic. */
export const SOCIAL_WRITE_GAPS = Object.freeze({
  bluesky: Object.freeze({ minMs: 60_000, maxMs: 120_000 }),
});

/** What a call may wait at most, and what it keeps for the write itself after the wait. */
export const SOCIAL_PACE_LIMITS = Object.freeze({ maxWaitMs: 90_000, writeReserveMs: 15_000 });

/** The pace request of a browser call body ({ platform, maxWaitMs }), or null when it names nothing paced. */
export function socialPaceRequest(body) {
  const pace = body?.pace;
  if (!pace || typeof pace !== 'object') return null;
  const platform = String(pace.platform || '');
  if (!Object.prototype.hasOwnProperty.call(SOCIAL_WRITE_GAPS, platform)) return null;
  const wait = Number(pace.maxWaitMs);
  const maxWaitMs = Number.isFinite(wait) ? Math.max(0, Math.min(SOCIAL_PACE_LIMITS.maxWaitMs, Math.floor(wait))) : 0;
  return { platform, maxWaitMs };
}

/**
 * The queue a write waits in: one per platform and signed-in account, which is the browser profile the session runs
 * (MoreLogin env, Chrome profile folder, or the saved storage of a clean browser), never the session id. A session
 * that is closed and opened again (another automation's close, a retired wedged session, a run's recovery) is the
 * same account, and its next write still waits out the gap of the last one. Only a session that names no profile
 * at all falls back to its own id.
 */
export function socialPaceAccountKey(platform, profile = {}, sessionId = '') {
  const p = profile || {};
  if (p.profileMode === 'morelogin' && p.moreloginEnvId) return `${platform}:morelogin:${p.moreloginEnvId}`;
  if (p.profileDir) return `${platform}:profile:${p.profileDir}`;
  if (p.storageStatePath) return `${platform}:storage:${p.storageStatePath}`;
  return `${platform}:session:${sessionId}`;
}

/**
 * Whether an executed write script reached the account. A Bluesky script that stopped on an expired token before
 * any write is the one case its tool retries at once (mcp-server/src/tools/bluesky.ts runPrepared): that attempt
 * takes no slot. Anything else, failures included, counts: a write that may have landed must be spaced too.
 */
export function socialAttemptWrote(platform, result) {
  if (platform === 'bluesky' && result && typeof result === 'object' && result.__bskyExpired === true && result.__bskyWrote !== true) return false;
  return true;
}

const defaultDelay = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

export function createSocialWritePacer({ now = Date.now, random = Math.random, delay = defaultDelay, gaps = SOCIAL_WRITE_GAPS } = {}) {
  const states = new Map(); // key → { tail, nextAt, gapMs }
  const stateOf = (key) => {
    if (!states.has(key)) states.set(key, { tail: Promise.resolve(), nextAt: 0, gapMs: 0 });
    return states.get(key);
  };
  const gapFor = (platform) => {
    const gap = gaps[platform] || gaps.bluesky;
    return gap.minMs + Math.floor(random() * (gap.maxMs - gap.minMs + 1));
  };
  return {
    /** How long the next write of `key` would wait now (ms). */
    remaining(key) {
      const state = states.get(key);
      return state ? Math.max(0, state.nextAt - now()) : 0;
    },
    clear(key) { states.delete(key); },
    /**
     * Run one write of `key` when its gap allows it. `delay(ms, signal)` waits (the host's is cancellable: a call
     * that is cut off never writes). Resolves { status: 'written', result, waitedMs } or, when more than
     * `maxWaitMs` of the gap is left, { status: 'paced', retryAfterMs, waitedMs } without writing.
     */
    async run(key, { platform = 'bluesky', maxWaitMs = 0, signal = null } = {}, execute, { wrote = (result) => socialAttemptWrote(platform, result) } = {}) {
      const state = stateOf(key);
      const predecessor = state.tail;
      let release;
      state.tail = new Promise((resolve) => { release = resolve; });
      const startedAt = now();
      try {
        await predecessor;
        const left = Math.max(0, state.nextAt - now());
        const budget = Math.max(0, Number(maxWaitMs) || 0);
        if (left > budget) {
          if (budget > 0) await delay(budget, signal);
          return { status: 'paced', retryAfterMs: Math.max(1, state.nextAt - now()), waitedMs: now() - startedAt, gapMs: state.gapMs };
        }
        if (left > 0) await delay(left, signal);
        const waitedMs = now() - startedAt;
        let counted = true;
        try {
          const result = await execute();
          counted = wrote(result) !== false;
          return { status: 'written', result, waitedMs, gapMs: state.gapMs };
        } catch (error) {
          // The write never started (its tab was closed while it waited for the gap): it takes no slot, and the
          // retry on the run's new tab goes out as soon as the gap allows, not a whole gap later.
          if (error && error.writeStarted === false) counted = false;
          throw error;
        } finally {
          // A write that threw may still have landed: it is spaced like one that answered.
          if (counted) {
            state.gapMs = gapFor(platform);
            state.nextAt = now() + state.gapMs;
          }
        }
      } finally {
        release();
      }
    },
  };
}

// A task that writes to a social account (its tools, or what it says) gets the PACING block in its loop prompt.
const SOCIAL_TASK_RE = /\b(?:bluesky|bsky|tweet|twitter|x\.com|linkedin|facebook|instagram|threads|tiktok|reddit|mastodon)\b|\b(?:space|spacing|paced?|pacing)\b[^.\n]{0,80}\b(?:writes?|actions?|posts?|replies|likes?|follows?|seconds|minutes)\b|\b\d+\s*(?:to|-)\s*\d+\s*(?:s|sec|secs|seconds|min|minutes)\s+apart\b/i;

/** Whether a loop's task writes to a social account (and so may be told to pace itself). */
export function isSocialLoopTask(loopState) {
  const tools = Array.isArray(loopState?.tools) ? loopState.tools.map(String) : [];
  if (tools.includes('browser_bluesky')) return true;
  return SOCIAL_TASK_RE.test(String(loopState?.task || ''));
}

/**
 * The loop prompt's PACING block: the wait between writes is SynaBun's, so the agent never sleeps, starts a
 * background wait or ends its turn to pace (that is what stalled the Bluesky schedules). '' for other tasks.
 */
export function socialPacingBlock(loopState) {
  if (!isSocialLoopTask(loopState)) return '';
  const gap = SOCIAL_WRITE_GAPS.bluesky;
  return [
    '',
    '=== PACING (SynaBun spaces your writes) ===',
    `- Any instruction in the task to space writes apart is enforced by SynaBun, not by you. bluesky_post, bluesky_action and bluesky_dm wait out the gap between this automation's Bluesky writes inside the call (${Math.round(gap.minMs / 1000)}-${Math.round(gap.maxMs / 1000)} s); the browser tools do the same for engagement clicks on X.`,
    '- So call the next write directly. Never use sleep, a background shell, a Monitor or any timer to pace writes, and never end your turn to wait for a gap.',
    '- When a write answers "Not written yet" because of the gap, call the same tool again at once with the same arguments: that call waits the rest and writes.',
    '=== END PACING ===',
    '',
  ].join('\n');
}
