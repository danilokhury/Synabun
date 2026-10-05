// ── Tool calls and their typed results → view models (DOM-free) ──
// The SDK delivers every tool's typed output next to its result text
// (`tool_use_result` on the user message, `toolUseResult` in a transcript).
// This module reads a call's input and that output into what a card shows:
// header detail, chips, labelled sections. cp-tool-cards.js renders it; live
// events and session replay go through the same two functions.
// Types: node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts.

import { fmtTokens, fmtDuration } from './cp-events.js';

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const base = (p) => String(p || '').split(/[/\\]/).pop() || '';
const firstLine = (s) => String(s || '').split('\n')[0].trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : (/(?:ch|s|x)$/.test(word) ? 'es' : 's')}`;
const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');
const chip = (text, tone = '') => ({ text, tone });
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

function fmtDelay(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

function urlLabel(u) {
  const s = String(u || '');
  return clip(s.replace(/^https?:\/\//i, '').replace(/\/$/, ''), 70);
}

// ── The call ──

/** Key/value rows for a tool input: the readable form of the generic card. */
export function inputRows(input, { max = 12, valueMax = 300 } = {}) {
  const rows = [];
  const entries = Object.entries(obj(input) || {});
  for (const [k, v] of entries.slice(0, max)) {
    if (v === undefined || v === null || v === '') continue;
    let value;
    if (typeof v === 'string') value = v;
    else if (typeof v === 'number' || typeof v === 'boolean') value = String(v);
    else { try { value = JSON.stringify(v); } catch { value = String(v); } }
    rows.push([k, clip(value, valueMax)]);
  }
  if (entries.length > max) rows.push(['…', `${entries.length - max} more`]);
  return rows;
}

/**
 * What a tool call is about, from its input alone.
 * @returns {{ detail: string, chips: {text: string, tone: string}[] }}
 */
export function describeToolCall(name, input) {
  const i = obj(input) || {};
  const chips = [];
  let detail = '';
  switch (name) {
    case 'Bash':
      if (i.dangerouslyDisableSandbox) chips.push(chip('sandbox off', 'warn'));
      if (Number(i.timeout) > 0) chips.push(chip(`timeout ${fmtDuration(i.timeout)}`));
      break;
    case 'Read': {
      detail = base(i.file_path);
      const from = Number(i.offset) || 0;
      const count = Number(i.limit) || 0;
      if (from || count) detail += `:${from || 1}${count ? `-${(from || 1) + count - 1}` : '+'}`;
      if (i.pages) detail += ` (pages ${i.pages})`;
      break;
    }
    case 'Edit':
      if (i.replace_all) chips.push(chip('replace all'));
      break;
    case 'NotebookEdit':
      if (i.edit_mode && i.edit_mode !== 'replace') chips.push(chip(i.edit_mode === 'delete' ? 'delete cell' : 'insert cell'));
      if (i.cell_type) chips.push(chip(i.cell_type));
      break;
    case 'Glob':
      detail = i.pattern || '';
      if (i.path) detail += ` in ${base(i.path)}`;
      break;
    case 'Grep':
      detail = i.pattern || '';
      if (i.glob) chips.push(chip(i.glob));
      if (i.type) chips.push(chip(`type ${i.type}`));
      if (i.output_mode && i.output_mode !== 'files_with_matches') chips.push(chip(i.output_mode));
      if (i.path) detail += ` in ${base(i.path)}`;
      break;
    case 'WebFetch':
      detail = urlLabel(i.url);
      break;
    case 'WebSearch':
      detail = clip(i.query, 70);
      if (Array.isArray(i.allowed_domains) && i.allowed_domains.length) chips.push(chip(`only ${i.allowed_domains.slice(0, 2).join(', ')}`));
      if (Array.isArray(i.blocked_domains) && i.blocked_domains.length) chips.push(chip(`not ${i.blocked_domains.slice(0, 2).join(', ')}`));
      break;
    case 'Agent':
    case 'Task':
      if (i.model) chips.push(chip(i.model));
      if (i.isolation) chips.push(chip(i.isolation === 'worktree' ? 'worktree' : 'remote'));
      if (i.run_in_background) chips.push(chip('bg', 'info'));
      if (i.name) chips.push(chip(i.name));
      break;
    case 'TaskCreate':
      detail = clip(i.subject, 70);
      break;
    case 'TaskUpdate':
      detail = `#${i.taskId || '?'}${i.status ? ` → ${String(i.status).replace('_', ' ')}` : ''}${i.subject ? ` ${clip(i.subject, 40)}` : ''}`;
      break;
    case 'TaskGet':
      detail = `#${i.taskId || '?'}`;
      break;
    case 'TaskStop':
      detail = i.task_id || i.shell_id || '';
      break;
    case 'Monitor':
      detail = clip(i.description || firstLine(i.command) || i.ws?.url, 70);
      if (Number(i.timeout_ms) > 0) chips.push(chip(`up to ${fmtDuration(i.timeout_ms)}`));
      if (i.ws?.url) chips.push(chip('websocket'));
      break;
    case 'ScheduleWakeup':
      if (i.stop) { detail = 'stop the loop'; break; }
      detail = `in ${fmtDelay(i.delaySeconds)}${i.reason ? `: ${clip(i.reason, 60)}` : ''}`;
      if (i.noop) chips.push(chip('nothing changed'));
      break;
    case 'CronCreate':
      detail = `${i.cron || ''}  ${clip(firstLine(i.prompt), 50)}`.trim();
      chips.push(chip(i.recurring === false ? 'once' : 'recurring'));
      if (i.durable) chips.push(chip('durable'));
      break;
    case 'CronDelete':
      detail = i.id || '';
      break;
    case 'PushNotification':
      detail = clip(i.message, 70);
      break;
    case 'Workflow':
      detail = clip(i.title || i.name || i.description || base(i.scriptPath) || 'inline script', 70);
      if (i.resumeFromRunId) chips.push(chip('resume'));
      break;
    case 'EnterWorktree':
      detail = i.name || base(i.path) || 'new worktree';
      break;
    case 'ExitWorktree':
      detail = i.action === 'remove' ? 'remove the worktree' : 'keep the worktree';
      if (i.discard_changes) chips.push(chip('discards changes', 'warn'));
      break;
    case 'ReportFindings': {
      const n = Array.isArray(i.findings) ? i.findings.length : 0;
      detail = plural(n, 'finding');
      if (i.level) chips.push(chip(`level ${i.level}`));
      break;
    }
    case 'ProposeGoal':
      detail = clip(i.condition, 70);
      break;
    case 'ProposeSkills': {
      const n = Array.isArray(i.proposals) ? i.proposals.length : 0;
      detail = plural(n, 'proposal');
      break;
    }
    case 'ReadMcpResource':
      detail = clip(i.uri, 70);
      if (i.server) chips.push(chip(i.server));
      break;
    case 'ListMcpResources':
    case 'RefreshMcpTools':
    case 'ReadMcpResourceDir':
      detail = i.server || i.uri || '';
      break;
    case 'Skill':
      detail = `${i.skill || ''}${i.args ? ` ${clip(i.args, 40)}` : ''}`;
      break;
    case 'ToolSearch':
      detail = clip(i.query, 60);
      break;
    case 'EnterPlanMode':
      detail = 'read and plan; nothing changes until you approve';
      break;
    case 'ExitPlanMode':
      detail = 'plan ready for approval';
      break;
    default: {
      // Anything else (MCP tools above all): the first field that says something.
      for (const k of ['description', 'query', 'url', 'path', 'file_path', 'command', 'action', 'name', 'id', 'title', 'prompt']) {
        if (typeof i[k] === 'string' && i[k].trim()) { detail = clip(firstLine(i[k]), 60); break; }
      }
    }
  }
  return { detail, chips };
}

/** Sections a call card shows beyond key/value input (findings, proposals). */
export function describeCallSections(name, input) {
  const i = obj(input) || {};
  if (name === 'ReportFindings' && Array.isArray(i.findings)) {
    return [{
      label: 'Findings',
      items: i.findings.slice(0, 40).map((f) => ({
        title: `${base(f?.file) || '?'}${f?.line ? `:${f.line}` : ''}${f?.verdict ? ` · ${String(f.verdict).toLowerCase()}` : ''}${f?.outcome ? ` · ${String(f.outcome).replace(/_/g, ' ')}` : ''}`,
        text: clip(f?.summary || f?.short_summary || '', 400),
        note: clip(f?.failure_scenario || '', 400),
      })),
    }];
  }
  if (name === 'ProposeSkills' && Array.isArray(i.proposals)) {
    return [{
      label: 'Proposed skills',
      items: i.proposals.map((p) => ({
        title: `${p?.name || '?'} · ${p?.kind === 'improvement' ? `improves ${p?.target || 'a skill'}` : 'new'}`,
        text: clip(p?.description || '', 400),
        note: Array.isArray(p?.evidence) ? clip(p.evidence.join(' · '), 300) : '',
      })),
    }];
  }
  if (name === 'ProposeGoal' && i.condition) {
    return [{ label: 'Goal condition', text: String(i.condition) }];
  }
  if ((name === 'CronCreate' || name === 'ScheduleWakeup' || name === 'Workflow') && typeof i.prompt === 'string' && i.prompt.trim()) {
    return [{ label: 'Prompt', text: clip(i.prompt, 2000) }];
  }
  return [];
}

// ── The result ──

/** Unified-diff rows from the CLI's structuredPatch, with real line numbers. */
export function patchToDiffLines(structuredPatch) {
  const out = [];
  const hunks = Array.isArray(structuredPatch) ? structuredPatch : [];
  hunks.forEach((h, idx) => {
    if (idx > 0) out.push({ kind: 'gap', text: '…' });
    let oldNo = Number(h?.oldStart) || 1;
    let newNo = Number(h?.newStart) || 1;
    for (const raw of Array.isArray(h?.lines) ? h.lines : []) {
      const line = String(raw);
      const mark = line[0];
      const text = line.slice(1);
      if (mark === '+') out.push({ kind: 'add', text, newNo: newNo++ });
      else if (mark === '-') out.push({ kind: 'del', text, oldNo: oldNo++ });
      else if (mark === '\\') continue; // "\ No newline at end of file"
      else out.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
    }
  });
  return out;
}

/** The background task id a result names (typed field first, then the sentence the CLI prints). */
export function backgroundTaskIdOf(structured, text) {
  const s = obj(structured);
  if (s && typeof s.backgroundTaskId === 'string' && s.backgroundTaskId) return s.backgroundTaskId;
  if (s && typeof s.taskId === 'string' && s.taskId) return s.taskId;
  const m = /\bwith ID:?\s*([A-Za-z0-9_-]{4,})/i.exec(String(text || '')) || /\bID:\s*([A-Za-z0-9_-]{4,})\b/.exec(String(text || ''));
  return m ? m[1] : '';
}

function gitChips(op) {
  const chips = [];
  const g = obj(op);
  if (!g) return chips;
  if (g.commit?.sha) chips.push(chip(`${g.commit.kind || 'committed'} ${String(g.commit.sha).slice(0, 7)}`, 'ok'));
  if (g.push?.branch) chips.push(chip(`pushed ${g.push.branch}`, 'ok'));
  if (g.branch?.ref) chips.push(chip(`${g.branch.action || 'updated'} ${g.branch.ref}`, 'ok'));
  if (g.pr?.number) chips.push({ text: `PR #${g.pr.number} ${g.pr.action || ''}`.trim(), tone: 'ok', url: httpUrl(g.pr.url) });
  return chips;
}

/**
 * What a finished tool call shows, from its typed output.
 * `content` (when set) replaces the raw result text of a generic card.
 * @returns {{ chips: object[], sections: object[], note: string, content: string|null, diff: object[]|null, bgTaskId: string, stats: string }}
 */
export function describeToolResult(name, input, structured, { text = '', isError = false } = {}) {
  const view = { chips: [], sections: [], note: '', content: null, diff: null, bgTaskId: '', stats: '' };
  const i = obj(input) || {};
  const r = structured;
  const o = obj(r);
  // Plan mode was refused (a rule, the mode, or the user): say so on the card.
  if (name === 'EnterPlanMode' && isError) { view.chips.push(chip('not entered', 'warn')); view.note = clip(firstLine(text), 200); view.content = ''; return view; }
  if (r == null || isError) return view;
  // WebFetch / WebSearch that moved to the background: the placeholder has no data.
  if (o?.detachedToolCall) { view.chips.push(chip('running in background', 'info')); return view; }

  switch (name) {
    case 'Bash': {
      if (!o) break;
      if (o.interrupted) view.chips.push(chip('interrupted', 'err'));
      if (Number(o.timedOutAfterMs) > 0) view.chips.push(chip(`timed out after ${fmtDuration(o.timedOutAfterMs)}`, 'err'));
      if (o.dangerouslyDisableSandbox && !i.dangerouslyDisableSandbox) view.chips.push(chip('sandbox off', 'warn'));
      if (o.backgroundTaskId) { view.bgTaskId = o.backgroundTaskId; view.chips.push(chip(o.backgroundedByUser ? 'moved to background' : `background ${o.backgroundTaskId}`, 'info')); }
      view.chips.push(...gitChips(o.gitOperation));
      const notes = [];
      if (o.returnCodeInterpretation) notes.push(String(o.returnCodeInterpretation));
      if (o.persistedOutputPath) notes.push(`Full output saved to ${o.persistedOutputPath}${o.persistedOutputSize ? ` (${fmtBytes(o.persistedOutputSize)})` : ''}`);
      view.note = notes.join(' · ');
      if (typeof o.stderr === 'string' && o.stderr.trim() && typeof o.stdout === 'string') {
        view.sections.push({ label: 'stderr', text: clip(o.stderr.trim(), 8000), tone: 'err' });
        view.stdout = o.stdout;
      }
      break;
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      if (!o) break;
      if (name === 'Write') view.chips.push(chip(o.type === 'update' ? 'overwrite' : 'new file'));
      if (o.replaceAll) view.chips.push(chip('replaced all'));
      if (o.staged) view.chips.push(chip('staged, not applied', 'warn'));
      if (o.userModified) view.chips.push(chip('edited by you'));
      if (Array.isArray(o.structuredPatch) && o.structuredPatch.length) view.diff = patchToDiffLines(o.structuredPatch);
      break;
    }
    case 'Read': {
      const f = obj(o?.file);
      if (!o || !f) break;
      if (o.type === 'text') {
        const total = Number(f.totalLines) || 0;
        const n = Number(f.numLines) || 0;
        view.chips.push(chip(total && n < total ? `lines ${f.startLine || 1}-${(f.startLine || 1) + n - 1} of ${total}` : plural(n, 'line')));
        if (f.truncatedByTokenCap) view.chips.push(chip('truncated', 'warn'));
      } else if (o.type === 'image') {
        view.chips.push(chip(`image${f.originalSize ? ` ${fmtBytes(f.originalSize)}` : ''}`));
      } else if (o.type === 'pdf') {
        view.chips.push(chip(`pdf${f.originalSize ? ` ${fmtBytes(f.originalSize)}` : ''}`));
      } else if (o.type === 'parts') {
        view.chips.push(chip(`pdf, ${plural(Number(f.count) || 0, 'page')}`));
      } else if (o.type === 'notebook') {
        view.chips.push(chip(`notebook, ${plural(Array.isArray(f.cells) ? f.cells.length : 0, 'cell')}`));
      } else if (o.type === 'file_unchanged') {
        view.chips.push(chip('unchanged since last read'));
      }
      break;
    }
    case 'Glob': {
      if (!o) break;
      const n = Number(o.numFiles) || 0;
      view.chips.push(chip(o.truncated && Number(o.totalMatches) > n ? `${n} of ${o.totalMatches} files` : plural(n, 'file')));
      if (o.truncated) view.chips.push(chip('truncated', 'warn'));
      if (Array.isArray(o.filenames) && o.filenames.length) view.content = o.filenames.slice(0, 200).join('\n');
      else view.content = 'No files matched.';
      break;
    }
    case 'Grep': {
      if (!o) break;
      if (o.mode === 'content') view.chips.push(chip(plural(Number(o.numLines) || 0, 'line')));
      else if (o.mode === 'count') view.chips.push(chip(plural(Number(o.numMatches) || 0, 'match') + (Number(o.numFiles) ? ` in ${plural(o.numFiles, 'file')}` : '')));
      else view.chips.push(chip(plural(Number(o.numFiles) || 0, 'file')));
      if (Number(o.appliedLimit) > 0) view.chips.push(chip(`first ${o.appliedLimit}`, 'warn'));
      if (typeof o.content === 'string' && o.content.trim()) view.content = o.content;
      else if (Array.isArray(o.filenames) && o.filenames.length) view.content = o.filenames.slice(0, 200).join('\n');
      else view.content = 'No matches.';
      break;
    }
    case 'WebFetch': {
      if (!o) break;
      if (o.code) view.chips.push(chip(`${o.code}${o.codeText ? ` ${o.codeText}` : ''}`, Number(o.code) >= 400 ? 'err' : 'ok'));
      if (o.bytes) view.chips.push(chip(fmtBytes(o.bytes)));
      if (Number(o.durationMs) > 0) view.chips.push(chip(fmtDuration(o.durationMs)));
      if (httpUrl(o.url)) view.sections.push({ label: 'Page', links: [{ title: urlLabel(o.url), url: o.url }] });
      if (typeof o.result === 'string') view.content = o.result;
      break;
    }
    case 'WebSearch': {
      if (!o) break;
      const links = [];
      const texts = [];
      for (const entry of Array.isArray(o.results) ? o.results : []) {
        if (typeof entry === 'string') { if (entry.trim()) texts.push(entry.trim()); continue; }
        for (const c of Array.isArray(entry?.content) ? entry.content : []) {
          const url = httpUrl(c?.url);
          if (url) links.push({ title: String(c.title || url), url });
        }
      }
      view.chips.push(chip(plural(links.length, 'result')));
      if (Number(o.durationSeconds) > 0) view.chips.push(chip(fmtDuration(o.durationSeconds * 1000)));
      if (links.length) view.sections.push({ label: 'Sources', links: links.slice(0, 30) });
      if (texts.length) view.content = texts.join('\n\n');
      break;
    }
    case 'Agent':
    case 'Task': {
      if (!o) break;
      if (o.status === 'async_launched' || o.status === 'remote_launched') {
        view.bgTaskId = o.agentId || o.taskId || '';
        if (httpUrl(o.sessionUrl)) view.sections.push({ label: 'Remote session', links: [{ title: urlLabel(o.sessionUrl), url: o.sessionUrl }] });
        if (o.resolvedModel) view.chips.push(chip(String(o.resolvedModel).replace(/^claude-/, '')));
        break;
      }
      const parts = [];
      if (o.resolvedModel) parts.push(String(o.resolvedModel).replace(/^claude-/, ''));
      if (Number(o.totalTokens) > 0) parts.push(`${fmtTokens(o.totalTokens)} tokens`);
      if (Number(o.totalDurationMs) > 0) parts.push(fmtDuration(o.totalDurationMs));
      if (Number(o.totalToolUseCount) > 0) parts.push(plural(o.totalToolUseCount, 'tool use'));
      const st = obj(o.toolStats);
      if (st && (st.linesAdded || st.linesRemoved)) parts.push(`+${st.linesAdded || 0} −${st.linesRemoved || 0} lines`);
      if (o.worktreeBranch || o.worktreePath) parts.push(`worktree ${o.worktreeBranch || base(o.worktreePath)}`);
      view.stats = parts.join(' · ');
      break;
    }
    case 'TaskCreate':
      if (o?.task?.id) view.chips.push(chip(`#${o.task.id}`));
      break;
    case 'TaskUpdate':
      if (o?.statusChange) view.chips.push(chip(`${String(o.statusChange.from).replace('_', ' ')} → ${String(o.statusChange.to).replace('_', ' ')}`));
      if (o && o.success === false) view.chips.push(chip(o.error ? clip(o.error, 40) : 'failed', 'err'));
      break;
    case 'TaskList': {
      const tasks = Array.isArray(o?.tasks) ? o.tasks : [];
      view.chips.push(chip(plural(tasks.length, 'task')));
      view.content = tasks.map(t => `#${t.id} [${String(t.status).replace('_', ' ')}] ${t.subject}${t.owner ? ` (${t.owner})` : ''}${Array.isArray(t.blockedBy) && t.blockedBy.length ? ` blocked by ${t.blockedBy.map(b => `#${b}`).join(', ')}` : ''}`).join('\n') || 'No tasks.';
      break;
    }
    case 'TaskStop':
      if (o?.task_id) { view.bgTaskId = o.task_id; view.chips.push(chip(`stopped ${o.task_type || 'task'}`)); }
      break;
    case 'Monitor':
      if (o?.taskId) { view.bgTaskId = o.taskId; view.chips.push(chip(`task ${o.taskId}`, 'info')); }
      if (o?.persistent) view.chips.push(chip('persistent'));
      break;
    case 'ScheduleWakeup':
      if (!o) break;
      if (o.stopped) { view.chips.push(chip(`loop stopped${Number(o.cancelledWakeups) ? `, ${plural(o.cancelledWakeups, 'wakeup')} cancelled` : ''}`)); break; }
      if (Number(o.scheduledFor) > 0) view.scheduledFor = Number(o.scheduledFor) < 1e12 ? Number(o.scheduledFor) * 1000 : Number(o.scheduledFor);
      if (o.wasClamped) view.chips.push(chip(`clamped to ${fmtDelay(o.clampedDelaySeconds)}`, 'warn'));
      break;
    case 'CronCreate':
      if (o?.humanSchedule) view.chips.push(chip(o.humanSchedule, 'info'));
      if (o?.id) view.chips.push(chip(o.id));
      break;
    case 'CronList': {
      const jobs = Array.isArray(o?.jobs) ? o.jobs : [];
      view.chips.push(chip(plural(jobs.length, 'job')));
      view.content = jobs.map(j => `${j.id}  ${j.humanSchedule || j.cron}  ${clip(firstLine(j.prompt), 80)}`).join('\n') || 'No scheduled jobs.';
      break;
    }
    case 'Workflow':
      if (!o) break;
      if (o.taskId) { view.bgTaskId = o.taskId; view.chips.push(chip(`task ${o.taskId}`, 'info')); }
      if (o.runId) view.chips.push(chip(`run ${o.runId}`));
      if (o.error) view.chips.push(chip(clip(o.error, 50), 'err'));
      if (o.warning) view.note = String(o.warning);
      if (httpUrl(o.sessionUrl)) view.sections.push({ label: 'Remote session', links: [{ title: urlLabel(o.sessionUrl), url: o.sessionUrl }] });
      break;
    case 'EnterPlanMode':
      // The result is the CLI's instruction text for the model: the card says
      // what it means for the user instead.
      view.chips.push(chip('plan mode on', 'ok'));
      view.content = '';
      break;
    case 'EnterWorktree':
      if (o?.worktreeBranch) view.chips.push(chip(o.worktreeBranch, 'info'));
      if (o?.worktreePath) view.note = o.worktreePath;
      break;
    case 'ExitWorktree':
      if (!o) break;
      view.chips.push(chip(o.action === 'remove' ? 'removed' : 'kept'));
      if (Number(o.discardedFiles) > 0 || Number(o.discardedCommits) > 0) {
        view.chips.push(chip(`discarded ${[Number(o.discardedFiles) > 0 ? plural(o.discardedFiles, 'file') : '', Number(o.discardedCommits) > 0 ? plural(o.discardedCommits, 'commit') : ''].filter(Boolean).join(', ')}`, 'warn'));
      }
      if (o.originalCwd) view.note = `Back in ${o.originalCwd}`;
      break;
    case 'ListMcpResources': {
      const list = Array.isArray(r) ? r : [];
      view.chips.push(chip(plural(list.length, 'resource')));
      view.content = list.slice(0, 100).map(x => `${x.server ? `[${x.server}] ` : ''}${x.name || ''}  ${x.uri || ''}`).join('\n') || 'No resources.';
      break;
    }
    case 'ReadMcpResource': {
      const contents = Array.isArray(o?.contents) ? o.contents : [];
      if (o?.error) view.chips.push(chip(clip(o.error, 50), 'err'));
      const parts = contents.map(c => (typeof c.text === 'string' ? c.text : (c.blobSavedTo ? `Saved to ${c.blobSavedTo}` : ''))).filter(Boolean);
      if (parts.length) view.content = parts.join('\n\n');
      break;
    }
    case 'RefreshMcpTools': {
      const list = Array.isArray(r) ? r : [];
      view.content = list.map(x => `${x.server}: ${x.status}${x.toolCount != null ? `, ${plural(x.toolCount, 'tool')}` : ''}${x.error ? ` (${x.error})` : ''}`).join('\n') || null;
      break;
    }
    default:
      break;
  }
  return view;
}

// ── Task tools → the todo dock ──

const TODO_STATUS = { pending: 'pending', in_progress: 'in_progress', completed: 'completed' };

/**
 * TaskCreate / TaskUpdate / TaskList keep a task list in the CLI; the dock shows
 * it in the shape TodoWrite uses. Returns the next list, or null when the call
 * changes nothing the dock shows.
 */
export function applyTaskTool(todos, name, input, output) {
  const list = (Array.isArray(todos) ? todos : []).map(t => ({ ...t }));
  const i = obj(input) || {};
  const o = obj(output) || {};
  if (name === 'TaskCreate') {
    const id = o.task?.id;
    if (!id) return null;
    if (list.some(t => t.id === String(id))) return null;
    list.push({ id: String(id), content: o.task.subject || i.subject || '', activeForm: i.activeForm || '', status: 'pending' });
    return list;
  }
  if (name === 'TaskUpdate') {
    if (o.success === false) return null;
    const id = String(o.taskId || i.taskId || '');
    if (!id) return null;
    const idx = list.findIndex(t => t.id === id);
    if (i.status === 'deleted') {
      if (idx < 0) return null;
      list.splice(idx, 1);
      return list;
    }
    const t = idx >= 0 ? list[idx] : { id, content: i.subject || `Task #${id}`, activeForm: '', status: 'pending' };
    if (i.subject) t.content = i.subject;
    if (i.activeForm) t.activeForm = i.activeForm;
    if (TODO_STATUS[i.status]) t.status = TODO_STATUS[i.status];
    if (i.owner) t.owner = i.owner;
    if (idx < 0) list.push(t);
    return list;
  }
  if (name === 'TaskList') {
    if (!Array.isArray(o.tasks)) return null;
    const known = new Map(list.map(t => [t.id, t]));
    return o.tasks.map((t) => {
      const prev = known.get(String(t.id)) || {};
      return {
        id: String(t.id),
        content: t.subject || prev.content || '',
        activeForm: prev.activeForm || '',
        status: TODO_STATUS[t.status] || 'pending',
        ...(t.owner ? { owner: t.owner } : {}),
        ...(Array.isArray(t.blockedBy) && t.blockedBy.length ? { blockedBy: t.blockedBy.map(String) } : {}),
      };
    });
  }
  return null;
}

// ── AskUserQuestion: what was asked and what was answered ──

/** Rows of an answered question card: [{header, question, answer}]. */
export function askAnswerRows(input, structured, text = '') {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const answers = obj(structured)?.answers || obj(input)?.answers || {};
  return questions.map((q) => {
    const a = answers?.[q?.question];
    return {
      header: q?.header || '',
      question: q?.question || '',
      answer: Array.isArray(a) ? a.join(', ') : (a != null ? String(a) : ''),
    };
  }).map((row, idx, all) => (
    // An older transcript has only the sentence the tool returned.
    !row.answer && all.length === 1 && text ? { ...row, answer: clip(text, 300) } : row
  ));
}

// ── Replay against a server that predates the history route ──
// public/ reloads at any time, lib/ only on a restart: until then the old route
// answers, and it returns tool calls without their results.

/** The history route that returns tool results also says where its page starts. */
export function historyHasResultSupport(data) {
  return Number.isFinite(data?.start) || Number.isFinite(data?.visible);
}

export const HISTORY_NO_RESULTS_CLASS = 'cp-history-noresults';
export const HISTORY_NO_RESULTS_TEXT = 'Tool results of this past session are not shown: they need the SynaBun server restart.';

/** One line for a replay whose calls came back without results from such a server; '' when there is nothing to say. */
export function historyResultsNotice(data) {
  if (historyHasResultSupport(data)) return '';
  let calls = 0;
  for (const m of Array.isArray(data?.messages) ? data.messages : []) {
    if (m?.role === 'tool_result') return '';
    if (m?.role === 'assistant' && Array.isArray(m.tools)) calls += m.tools.length;
  }
  return calls ? HISTORY_NO_RESULTS_TEXT : '';
}

/**
 * A stored snapshot built while the server could not return tool results is
 * rebuilt once the server can (`probe` is that route's answer): the snapshot
 * carries the notice above, or, stored before the notice existed, has tool
 * cards and not one result. `results: 1` marks a snapshot already rebuilt from
 * a current server, so a session that really has no result is not rebuilt on
 * every open.
 */
export function snapshotWantsResults(snapshot, probe) {
  if (!historyHasResultSupport(probe)) return false;
  const html = String(snapshot?.html || '');
  if (html.includes(HISTORY_NO_RESULTS_CLASS)) return true;
  if (snapshot?.results) return false;
  return /class="[^"]*\btool-card\b/.test(html) && !/class="[^"]*\btool-(?:ok|error)\b/.test(html);
}

/**
 * The full text of one result from `GET …/messages?tool=<id>`. A server that
 * predates `?tool=` ignores it and answers with the whole page (which carries
 * `total`): that is "restart needed", not "no such result".
 */
export function fullResultFromHistory(data, toolUseId) {
  const row = (Array.isArray(data?.messages) ? data.messages : []).find(m => m?.role === 'tool_result' && m.toolUseId === toolUseId);
  if (typeof row?.text === 'string' && row.text) return { text: row.text, notice: '' };
  return { text: null, notice: data && data.total !== undefined ? 'The full result needs the SynaBun server restart' : '' };
}
