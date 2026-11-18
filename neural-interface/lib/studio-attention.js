// Source-scoped reads let run events update their labels without rereading unrelated Studios.
import { reviewCountOf } from '../public/shared/agents/studio/ax-library.js';
import { needsAttention, OVERDUE_AFTER } from '../public/shared/schedules-view.js';
import { runAwaitsAnswer } from '../public/shared/sidepanel-session-status.js';
import { scheduleMarked, templateMarked } from './automation-approval.js';

// The scheduler stamps scheduleId even for Run now and quick timers. Older descriptors can
// still identify a scheduler launch by its source (resolveScheduleRunPresentation).
const SCHEDULE_SOURCES = new Set(['schedule', 'schedule-manual', 'quick-timer', 'quick-timer-manual']);

function loopAttention(runs) {
  const waiting = { automations: false, schedules: false };
  for (const run of runs) {
    // The dispatcher owns task runs, including their route/permission cards and removal.
    if (!runAwaitsAnswer(run) || run.runMode === 'task' || run.source === 'assistant') continue;
    if (run.scheduleId || SCHEDULE_SOURCES.has(run.source)) waiting.schedules = true;
    else if (run.source === 'manual') waiting.automations = true;
  }
  return waiting;
}

function scheduleAttention(rows, now) {
  let recheckInMs = null;
  for (const schedule of rows) {
    if (scheduleMarked(schedule) || needsAttention(schedule, now)) return { waiting: true, recheckInMs: null };
    // A missed fire can become actionable without any record changing. The view uses a strict inequality.
    const delay = Date.parse(schedule.nextRun) + OVERDUE_AFTER + 1 - now;
    if (schedule.enabled && delay > 0 && (recheckInMs === null || delay < recheckInMs)) recheckInMs = delay;
  }
  return { waiting: false, recheckInMs };
}

export function registerStudioAttention(app, { ownerPage, agents, teams, reviews, templates, schedules, workers, nativeRuns }) {
  const readers = {
    drafts: () => reviewCountOf({ agents: agents() }),
    teams: () => teams().some(team => team.status === 'needs_attention' || team.status === 'ready'),
    skills: () => reviews().some(review => review.state === 'pending' && !review.supersededBy),
    automations: () => templates().some(templateMarked),
    schedules: () => scheduleAttention(schedules(), Date.now()),
    workers,
    runs: () => loopAttention(nativeRuns()),
  };
  app.get('/api/studio-attention', ownerPage, (req, res) => {
    const sources = req.query.sources === undefined ? Object.keys(readers) : String(req.query.sources).split(',');
    if (!sources.every(key => Object.hasOwn(readers, key))) return res.sendStatus(400);
    const answer = {};
    for (const key of new Set(sources)) {
      try { answer[key] = readers[key](); }
      catch (error) {
        console.warn(`[studio-attention] ${key} unavailable:`, error.message);
        answer[key] = null;
      }
    }
    res.set('Cache-Control', 'no-store').json(answer);
  });
}
