// ═══════════════════════════════════════════
// SynaBun — Teams: a team's record, read from and written to the store's journal
// ═══════════════════════════════════════════
//
// The coordination store's journal (lib/coordination/store.js `journal`) is append-only: an entry says "this team
// (or this slice) is in this state now", with a little data. This module is the one reading of it the teams
// modules share:
//
//   - a team's record is its own entries folded together, oldest first: the newest entry's state is the team's
//     state, and each entry's data is laid over what came before (a key written later replaces the earlier value);
//   - a slice's record is the same fold over that slice's entries.
//
// So a step writes only what it changes, and recovery reads where a team stood from the same entries.
//
// What is written when (the full list is lib/teams/README.md → The journal):
//   team   creating → planned → running ⇄ integrating → ready → landing → merged, or failed / cancelled
//   slice  planned (its task) → pending → running → done | rejected → integrating → integrated | conflict |
//          tests-failed, or failed / cancelled
//
// The plan is stored in pieces, because one entry holds at most 64 KB: the team's `creating` entry has the plan
// without the slices' task texts and owned paths, each slice's `planned` entry has its task and its `pending`
// entry its owned paths (`planPieces` cuts a plan that way, `record` puts it together again).
//
// Every entry is also announced on the store's event log (kind `team.state` / `slice.state`, addressed to nobody,
// id `team:<team>:journal:<entry id>`), so a scheduler can wake on `store.subscribe({ teamId })` instead of polling.

import { EVENT_KINDS } from '../coordination/store.js';
import { INTEGRATION_SLICE_ID, normalizeTeamPlan } from './schema.js';

/** Team states a team does not leave by itself. `merged` and `cancelled` may still have worktrees to remove. */
export const TERMINAL_TEAM_STATES = Object.freeze(['merged', 'failed', 'cancelled', 'completed']);
/** Slice states in which the slice's work is not under way and not waiting to be joined. */
export const SETTLED_SLICE_STATES = Object.freeze(['integrated', 'cancelled', 'failed', 'completed']);

export class TeamError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** A refusal every teams function answers with instead of throwing: `{ ok: false, code, message, ... }`. */
export const refuse = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

const PAGE = 500;

/**
 * @param {object} deps
 * @param {object} deps.store  a coordination store (lib/coordination/store.js)
 * @param {(tag: string, detail: any) => void} [deps.log]
 */
export function createTeamState({ store, log = () => {} } = {}) {
  if (!store || typeof store.journal?.write !== 'function') throw new TeamError('STORE_REQUIRED', 'The teams modules need a coordination store (lib/coordination/store.js).');

  function entriesOf(teamId) {
    const out = [];
    let afterId = 0;
    for (;;) {
      const page = store.journal.read({ teamId, afterId, limit: PAGE });
      out.push(...page);
      if (page.length < PAGE) return out;
      afterId = page[page.length - 1].id;
    }
  }

  function announce(entry) {
    try {
      store.append({
        id: `team:${entry.teamId}:journal:${entry.id}`,
        teamId: entry.teamId,
        runId: entry.runId || null,
        kind: entry.sliceId ? EVENT_KINDS.SLICE_STATE : EVENT_KINDS.TEAM_STATE,
        payload: { teamId: entry.teamId, sliceId: entry.sliceId || null, state: entry.state, journalId: entry.id },
      });
    } catch (error) {
      log('teams:announce-failed', { teamId: entry.teamId, error: error?.message || String(error) });
    }
  }

  /**
   * A team as the journal has it, or null for a team it does not know.
   * @returns {null | { teamId: string, state: string, createdAt: string, updatedAt: string, plan: object,
   *   projectPath: string, baseCommit: string, baseBranch: string|null, testCommand: any, integration: object,
   *   removed: boolean, slices: Record<string, object>, [key: string]: any }}
   */
  function record(teamId) {
    const entries = entriesOf(teamId);
    if (!entries.length) return null;
    const team = {};
    const slices = {};
    let first = null;
    let last = null;
    for (const entry of entries) {
      if (!entry.sliceId) {
        Object.assign(team, entry.data || {});
        team.state = entry.state;
        first = first || entry;
        last = entry;
        continue;
      }
      const slice = slices[entry.sliceId] || (slices[entry.sliceId] = { id: entry.sliceId });
      Object.assign(slice, entry.data || {});
      slice.id = entry.sliceId;
      slice.state = entry.state;
      slice.runId = entry.runId || slice.runId || null;
      slice.updatedAt = entry.createdAt;
    }
    if (!first) return null;
    // The plan whole again: the team's entry has it without the tasks, each slice's own entries have its task.
    const stored = team.plan && typeof team.plan === 'object' ? team.plan : { teamId, slices: [] };
    const plan = normalizeTeamPlan({
      ...stored,
      slices: (stored.slices || []).map((slice) => ({
        ...slice,
        task: slices[slice.id]?.task || slice.task || '',
        ownedPaths: slices[slice.id]?.ownedPaths || slice.ownedPaths || [],
      })),
    });
    return {
      ...team,
      teamId,
      plan,
      projectPath: plan.projectPath,
      baseCommit: plan.baseCommit,
      baseBranch: team.baseBranch ?? null,
      testCommand: team.testCommand ?? null,
      integration: team.integration && typeof team.integration === 'object' ? team.integration : { head: plan.baseCommit, lastGood: plan.baseCommit, tests: null },
      removed: team.removed === true,
      slices,
      createdAt: first.createdAt,
      updatedAt: last.createdAt,
    };
  }

  /** Record that a team is in a state now, with what this step changes. */
  function writeTeam(teamId, state, data = {}) {
    const entry = store.journal.write({ teamId, state, data });
    announce(entry);
    return entry;
  }

  /** Record that a slice is in a state now, with what this step changes. */
  function writeSlice(teamId, sliceId, state, data = {}, runId = null) {
    if (sliceId === INTEGRATION_SLICE_ID) throw new TeamError('RESERVED_SLICE', '"integration" is the team\'s integration worktree, not a slice.');
    const entry = store.journal.write({ teamId, sliceId, state, runId, data });
    announce(entry);
    return entry;
  }

  /** Every team the journal knows (its own newest entry), oldest team first; `states` narrows it. */
  function teams({ states = null } = {}) {
    return store.journal.teams(states ? { states } : {});
  }

  return { record, writeTeam, writeSlice, teams, entriesOf };
}

/**
 * A plan cut into the pieces the journal stores: `team` (the plan without tasks and owned paths) and, per slice,
 * `task` and `ownedPaths`. Each piece fits one journal entry whatever the plan's size.
 */
export function planPieces(plan) {
  const value = normalizeTeamPlan(plan);
  return {
    team: { ...value, slices: value.slices.map(({ task: _task, ownedPaths: _owned, ...rest }) => rest) },
    slices: value.slices.map((slice) => ({ id: slice.id, task: slice.task, ownedPaths: slice.ownedPaths })),
  };
}

/** The slice of a record's plan, or null. */
export function planSlice(record, sliceId) {
  return record?.plan?.slices?.find((slice) => slice.id === sliceId) || null;
}

/** The state of a slice in a record: `pending` until it has an entry of its own that says otherwise. */
export function sliceState(record, sliceId) {
  return record?.slices?.[sliceId]?.state || 'pending';
}
