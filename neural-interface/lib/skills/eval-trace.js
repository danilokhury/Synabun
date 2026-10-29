// ── What an evaluation run did: its tool calls, and whether the runtime picked the skill (P4, SK-085) ──
// The dispatcher keeps the tool calls of an evaluation run (assistant-dispatch.js, transcript format `tools`), read
// here from each provider's own events; a trigger trial is read from them:
//
//   Claude Code   a `Skill` call naming the skill: method `native_skill_tool` (seen). A Read of its SKILL.md without
//                 one: `successful_skill_file_read` (an inference).
//   OpenCode      a `skill` tool call naming it (`{ id }`): `native_skill_tool`;
//                 a read of its SKILL.md: the inference.
//   Codex         Codex has no skill tool: it lists its skills and the model reads the file with its shell. A command
//                 that ran (exit 0) and names the skill's SKILL.md: `successful_skill_file_read` (an inference).
//
// A skill named that is not the one under test is evidence too (the runtime picked another), never a "yes". The
// runtime's own listing at start (Claude's init `skills`) is kept as the catalog the run saw: a baseline that lists
// the skill under test was not a baseline. Startup discovery is never counted as a selection. A call's input is kept with
// its secrets redacted, the way an answer and a written file are (lib/log-redact.js). Pure.

import { redactSecrets } from '../../../lib/log-redact.js';

const clipJson = (value, max = 600) => {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value ?? null); } catch { text = String(value); }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The tool calls one provider event carries: [{ id, tool, input, phase?, ok? }]. Claude: the tool_use blocks of a
 * whole assistant message; Codex: a command (started, then done with its exit code), an MCP call, a file change;
 * OpenCode: a tool part (each update of a call has its id: the caller keeps one entry per id).
 */
export function toolCallsOf(payload = {}) {
  const event = payload?.event || {};
  const eventType = String(payload?.eventType || event.type || '');
  const out = [];
  if (payload.provider === 'claude-code') {
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_use') out.push({ id: String(block.id || ''), tool: String(block.name || ''), input: isObject(block.input) ? block.input : {}, sub: !!event.parent_tool_use_id });
      }
    }
    return out;
  }
  if (payload.provider === 'codex') {
    if (event.type === 'item.started' || event.type === 'item.completed') {
      const item = event.item || {};
      const done = event.type === 'item.completed';
      if (item.type === 'command_execution') {
        const command = typeof item.command === 'string' ? item.command : Array.isArray(item.command) ? item.command.join(' ') : '';
        out.push({ id: String(item.id || ''), tool: 'shell', input: { command }, phase: done ? 'done' : 'started', ok: done ? Number(item.exit_code) === 0 : null });
      } else if (item.type === 'mcp_tool_call') out.push({ id: String(item.id || ''), tool: `${item.server || ''}.${item.tool || ''}`, input: {}, phase: done ? 'done' : 'started' });
      else if (item.type === 'file_change') out.push({ id: String(item.id || ''), tool: 'file_change', input: { paths: (item.changes || []).map((c) => c?.path).filter(Boolean) }, phase: done ? 'done' : 'started' });
      else if (item.type === 'web_search') out.push({ id: String(item.id || ''), tool: 'web_search', input: { query: item.query || '' }, phase: done ? 'done' : 'started' });
    }
    return out;
  }
  if (payload.provider === 'opencode') {
    if (/^message[.:]part[.:]updated$/i.test(eventType)) {
      const part = event.part || {};
      if (part.type === 'tool') out.push({ id: String(part.callID || part.id || ''), tool: String(part.tool || part.name || ''), input: isObject(part.state?.input) ? part.state.input : {}, phase: String(part.state?.status || ''), ok: part.state?.status === 'completed' ? true : part.state?.status === 'error' ? false : null });
    }
    return out;
  }
  return out;
}

/** Claude's init event, as the catalog the run saw: { model, skills, tools, cwd } (null for any other event). */
export function initOf(payload = {}) {
  const event = payload?.event || {};
  if (payload.provider !== 'claude-code' || event.type !== 'system' || event.subtype !== 'init') return null;
  const names = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x?.name)).filter((x) => typeof x === 'string').slice(0, 200) : null);
  return { model: typeof event.model === 'string' ? event.model : null, skills: names(event.skills), tools: names(event.tools), cwd: typeof event.cwd === 'string' ? event.cwd : null };
}

/** A value with a secret in any of its texts redacted (each string as it is, before it is written as JSON). Bounded. */
function redactValue(value, depth = 0) {
  if (typeof value === 'string') return redactSecrets(value.length > 20_000 ? value.slice(0, 20_000) : value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactValue(v, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([k, v]) => [k, redactValue(v, depth + 1)]));
}

/** A tool call kept for the record: its tool, its input as bounded JSON text, every secret in it redacted first. */
export const callRecord = (c) => ({ tool: c.tool, input: clipJson(redactValue(c.input), 400), ...(c.phase ? { phase: c.phase } : {}), ...(c.ok === true || c.ok === false ? { ok: c.ok } : {}) });

const skillFilePattern = (name) => new RegExp(`(?:^|[\\\\/\\s'"])skills[\\\\/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]SKILL\\.md\\b`, 'i');
const SKILL_MD = /(?:^|[\\/\s'"])skills[\\/]([a-z0-9][a-z0-9._-]{0,63})[\\/]SKILL\.md\b/gi;

/**
 * Whether the run picked the skill: { observed: true|false, method, evidence: [{ tool, input }], others: [names] }.
 * `observed` is false when nothing named it (the caller decides whether the run got far enough to say so).
 */
export function detectSelection({ provider, calls = [], skillName }) {
  const name = String(skillName || '');
  const evidence = [];
  const others = new Set();
  let native = false;
  let read = false;
  const file = name ? skillFilePattern(name) : null;
  for (const c of calls) {
    const tool = String(c.tool || '');
    const input = isObject(c.input) ? c.input : {};
    if ((provider === 'claude-code' && tool === 'Skill') || (provider === 'opencode' && tool === 'skill')) {
      // Claude Code's Skill sends { skill }, OpenCode's skill tool { id } (seen in a live run).
      const asked = String(input.skill ?? input.id ?? input.command ?? '').replace(/^\//, '');
      const bare = asked.includes(':') ? asked.split(':').pop() : asked;
      if (name && (asked === name || bare === name)) { native = true; evidence.push(callRecord(c)); } else if (asked) others.add(asked.slice(0, 64));
      continue;
    }
    const text = provider === 'codex' ? String(input.command || '') : String(input.file_path ?? input.filePath ?? input.path ?? '');
    if (!text) continue;
    if (provider === 'codex' && c.phase === 'started') continue;   // a command that ran (its done item, exit 0) is a read
    if (provider === 'codex' && c.ok === false) continue;
    const readTool = provider === 'codex' ? tool === 'shell' : /^(?:read|Read)$/.test(tool);
    if (!readTool) continue;
    if (file && file.test(text)) { read = true; evidence.push(callRecord(c)); continue; }
    for (const m of text.matchAll(SKILL_MD)) if (m[1] !== name) others.add(m[1]);
  }
  return { observed: native || read, method: native ? 'native_skill_tool' : read ? 'successful_skill_file_read' : null, evidence: evidence.slice(0, 5), others: [...others].slice(0, 10) };
}
