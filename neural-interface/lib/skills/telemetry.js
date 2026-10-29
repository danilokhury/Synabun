// Minimal local evidence, from trusted runtime events only. No prompts, commands, paths, or outputs are stored.
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { readManifest } from './digest.js';
import { toolCallsOf, initOf } from './eval-trace.js';
import { localRecord } from './local-store.js';

export const USAGE_COVERAGE = Object.freeze({
  claude: { native: true, method: 'Skill tool request + successful tool result', limit: 'SynaBun dispatched runs only. Discovery is not invocation; task outcome is not skill quality.' },
  codex: { native: false, method: 'Successful exact cat of an installed SKILL.md', limit: 'No native invocation event. File reads are inferred loads, never invocation counts. Complex shell commands are not classified.' },
  opencode: { native: true, method: 'Completed skill tool part', limit: 'SynaBun dispatched runs only. Other terminals and historical transcripts are not mined.' },
});
const hash = (s) => createHash('sha256').update(s).digest('hex');
// Native item IDs can restart on a follow-up turn; the dispatcher retains this turn across restarts.
const turnOf = (run) => Number(run.usageState?.turn?.n || run.resumeInfo?.inFlight?.turn || 1);

export function createSkillTelemetry({ dataDir, deployer, settings, now = Date.now }) {
  const store = localRecord(dataDir, 'usage', { events: [] });
  const pending = new Map();
  const trim = (events) => events.filter((e) => e.at >= now() - settings().retentionDays * 86400000).slice(-10000);
  function read() {
    const previous = store.read().events || [];
    const events = trim(previous);
    if (events.length !== previous.length) store.write({ events });
    return events;
  }
  function add(run, inst, kind, method, eventId, strength = 'measured') {
    if (!eventId) return;
    const runtime = run.provider === 'claude-code' ? 'claude' : run.provider;
    const key = hash(`${run.runId}\0${turnOf(run)}\0${eventId}\0${inst.installationId}\0${kind}`);
    const events = read();
    if (events.some((e) => e.key === key)) return;
    // Only attribute bytes that still match the installed export. Drift is health evidence, not approved usage.
    if (readManifest(inst.destination.path).digest !== inst.export.artifactDigest) return;
    events.push({ key, at: now(), turn: turnOf(run), runRef: hash(String(run.runId)), installationId: inst.installationId,
      skillId: inst.skillId, revisionId: inst.sourceRevisionId, exportDigest: inst.export.artifactDigest,
      runtime, kind, method, strength, outcome: null, costUsd: null });
    store.write({ events: trim(events) });
  }
  function eligible(run) {
    const runtime = run.provider === 'claude-code' ? 'claude' : run.provider;
    return deployer.listInstallations({ active: true }).filter((i) => i.destination.affectedRuntimes.includes(runtime)
      && (i.target.accountId || 'default') === (run.accountId || 'default')
      && (!i.target.projectPath || (run.cwd && (resolve(run.cwd) === resolve(i.target.projectPath) || resolve(run.cwd).startsWith(`${resolve(i.target.projectPath)}${sep}`)))));
  }
  function observe(run, payload) {
    if (!settings().telemetryEnabled || !run?.runId || run.skillEval || run.skillCreation || !USAGE_COVERAGE[run.provider === 'claude-code' ? 'claude' : run.provider]) return;
    const calls = toolCallsOf(payload);
    const init = initOf(payload);
    const results = run.provider === 'claude-code' && payload?.event?.type === 'user' && Array.isArray(payload.event.message?.content) ? payload.event.message.content.filter((b) => b?.type === 'tool_result') : [];
    if (!calls.length && !init?.skills?.length && !results.length) return;
    const installs = eligible(run);
    const unique = (name) => { const found = installs.filter((i) => i.destination.relativePath === name); return found.length === 1 ? found[0] : null; };
    for (const name of init?.skills || []) { const i = unique(name); if (i) add(run, i, 'discovered', 'runtime_catalog', `init:${name}`); }
    for (const c of calls) {
      if (!c.id || c.sub) continue;
      if ((run.provider === 'claude-code' && c.tool === 'Skill') || (run.provider === 'opencode' && c.tool === 'skill')) {
        const name = c.input.skill ?? c.input.id ?? c.input.name;
        const i = typeof name === 'string' ? unique(name) : null;
        if (!i) continue;
        if (run.provider === 'claude-code') {
          add(run, i, 'requested', 'native_skill_tool', c.id);
          pending.set(`${run.runId}:${turnOf(run)}:${c.id}`, i);
          if (pending.size > 2000) pending.delete(pending.keys().next().value);
        } else if (c.ok === true) add(run, i, 'invoked', 'native_skill_tool', c.id);
        else if (c.ok === false) add(run, i, 'failed', 'native_skill_tool', c.id);
      }
      if (run.provider === 'codex' && c.tool === 'shell' && c.phase === 'done' && c.ok === true) {
        // A conservative grammar: no pipes, substitutions, multiple commands, or merely mentioning a path.
        let command = c.input.command || '';
        const wrapper = /^\/bin\/(?:bash|zsh|sh) -lc (['"])([\s\S]*)\1$/.exec(command);
        if (wrapper) command = wrapper[2];
        const m = /^(?:\/bin\/)?cat\s+(?:--\s+)?(?:"([^"$`\n]+)"|'([^'\n]+)'|(\/[^\s;&|<>$`]+))\s*$/.exec(command);
        if (!m) continue;
        const path = m[1] || m[2] || m[3];
        const matches = installs.filter((i) => path === join(i.destination.path, 'SKILL.md'));
        if (matches.length === 1) add(run, matches[0], 'loaded', 'successful_skill_file_read', c.id, 'inferred');
      }
    }
    if (run.provider === 'claude-code' && payload?.event?.type === 'user') {
      for (const block of results) {
        if (block?.type !== 'tool_result') continue;
        const key = `${run.runId}:${turnOf(run)}:${block.tool_use_id}`;
        const inst = pending.get(key);
        if (!inst) continue;
        pending.delete(key);
        add(run, inst, block.is_error ? 'failed' : 'invoked', 'native_skill_tool', block.tool_use_id);
      }
    }
  }
  function complete(run) {
    const ref = hash(String(run.runId));
    for (const key of pending.keys()) if (key.startsWith(`${run.runId}:${turnOf(run)}:`)) pending.delete(key);
    const events = read();
    let changed = false;
    for (const e of events) if (e.runRef === ref && (e.turn || 1) === turnOf(run) && e.outcome === null) {
      e.outcome = ['done', 'blocked', 'needs_input'].includes(run.lastResult?.status) ? run.lastResult.status : null;
      e.outcomeStrength = 'declared-run-result'; changed = true;
    }
    if (changed) store.write({ events });
  }
  function summary({ skillId = null } = {}) {
    const events = read().filter((e) => !skillId || e.skillId === skillId);
    const groups = new Map();
    for (const e of events) {
      const key = `${e.revisionId}:${e.runtime}`;
      if (!groups.has(key)) groups.set(key, { skillId: e.skillId, revisionId: e.revisionId, runtime: e.runtime, discovered: 0, requested: 0, invoked: 0, loaded: 0, failed: 0, lastAt: e.at, costUsd: null });
      const g = groups.get(key); g[e.kind]++; g.lastAt = Math.max(g.lastAt, e.at);
    }
    return { localOnly: true, enabled: settings().telemetryEnabled, retentionDays: settings().retentionDays, maxEvents: 10000, coverage: USAGE_COVERAGE, rows: [...groups.values()], events: events.slice(-100) };
  }
  return { observe, complete, summary, prune: read, clear() { pending.clear(); store.write({ events: [] }); } };
}
