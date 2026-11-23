// Read-only evidence for scratch retention, used inside its worker thread: who owns a folder, whether its run is
// positively finished, and which of its files the run's visible output still points at. Anything that cannot be read
// keeps the folder, and says why.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { HAS_SCRATCH, RUN_ID, collectRunRecord, collectTranscriptEntry, createReferenceIndex } from './scratch-references.js';

export const DAY_MS = 86_400_000;
const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const LOOP_SOURCES = new Set(['manual', 'schedule', 'schedule-manual', 'quick-timer', 'quick-timer-manual']);
const MAX_JSON = 128 * 1024 ** 2;
const CHUNK = 1024 * 1024;
const MAX_LINE = 8 * 1024 * 1024;
const LINE_OVERLAP = 4096;
const TURN_TEXT_CAP = 20_000;
const COORDINATION_SCHEMA = 1;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const BIG = { bigint: true };

/** A stable reason to count in the pass summary. */
export class Keep extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
export const reasonOf = (error) => (error instanceof Keep ? error.reason : 'unreadable');

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const stampOf = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const missing = (error) => error?.code === 'ENOENT';

export function timestamp(value) {
  if (typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    const when = Date.parse(value);
    if (Number.isFinite(when) && when > 0) return when;
  }
  throw new Keep('unknown-finish');
}

export function policy(config) {
  const limits = config?.scratchRetention === undefined ? {} : config.scratchRetention;
  if (!isObject(limits)) throw new Keep('invalid-settings');
  const number = (key, fallback, floor) => {
    const value = limits[key] === undefined ? fallback : limits[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < floor) throw new Keep('invalid-settings');
    return value;
  };
  return { ageMs: number('days', 14, 2) * DAY_MS, limitBytes: number('maxGB', 5, 0) * 1e9, floorMs: number('minHours', 48, 48) * 3_600_000 };
}

export class Evidence {
  constructor(data, { pause = async () => {}, realpath = null } = {}) {
    this.data = data;
    this.pause = pause;
    this.realpath = realpath || ((path) => { try { return realpathSync.native(path); } catch { return null; } });
    this.cache = new Map();
    this.sources = new Map();   // source → { refs }, each replaced or extended only when its file changed
    this.sidecars = new Map();  // run → the references of its whole last message
    this.eventDb = null;
    this.lastEvent = 0;
    this.eventRefs = createReferenceIndex();
  }

  /**
   * One regular file, never through a link, read only if it changed. The registries are replaced atomically, many
   * times a minute while a worker runs: the open descriptor is one consistent version of the file, so a replacement
   * during the read is not an error. The check right before a delete reads the newer version.
   */
  read(path, load) {
    if (realpathSync.native(path) !== path) throw new Keep('linked-record');
    const fd = openSync(path, READ_FLAGS);
    try {
      const st = fstatSync(fd, BIG);
      if (!st.isFile()) throw new Keep('invalid-record');
      const stamp = stampOf(st);
      const cached = this.cache.get(path);
      if (cached?.stamp === stamp) return cached.value;
      if (Number(st.size) > MAX_JSON) throw new Keep('oversized-record');
      const value = load(readFileSync(fd, 'utf8'));
      if (stampOf(fstatSync(fd, BIG)) !== stamp) throw new Keep('changing-record'); // written in place while it was read
      this.cache.set(path, { stamp, value });
      return value;
    } finally { closeSync(fd); }
  }

  settings() {
    try { return policy(this.read(join(this.data, 'assistant-config.json'), (text) => JSON.parse(text))); }
    catch (error) {
      if (missing(error)) return policy({});
      throw error;
    }
  }

  listing(path, { required = false } = {}) {
    try {
      if (realpathSync.native(path) !== path) throw new Keep('linked-record');
      return readdirSync(path);
    } catch (error) {
      if (!missing(error)) throw error;
      if (required) throw new Keep('unreadable-loop-owner');
      return [];
    }
  }

  ledger(name) {
    return this.read(join(this.data, name), (text) => {
      const rows = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Error('invalid ledger');
      const index = new Map();
      const refs = createReferenceIndex();
      for (const row of rows) {
        if (!isObject(row) || typeof row.runId !== 'string') throw new Error('invalid run id');
        collectRunRecord(refs, row, { realpath: this.realpath });
        index.set(row.runId, index.has(row.runId) ? null : row); // duplicate ownership is ambiguous for this id only
      }
      return { index, refs };
    });
  }

  jsonRefs(path) {
    const refs = this.read(path, (text) => {
      const value = JSON.parse(text);
      const out = createReferenceIndex();
      if (HAS_SCRATCH.test(text)) {
        out.addVisible(value);
        out.addWorkdirs(value, { realpath: this.realpath });
      }
      return out;
    });
    this.sources.set(path, { refs });
  }

  readTeams(held) {
    const base = join(this.data, 'teams');
    for (const name of this.listing(base)) {
      if (!name.endsWith('.json')) continue;
      const path = join(base, name);
      const row = this.read(path, (text) => {
        const value = JSON.parse(text);
        if (!isObject(value?.slices)) throw new Error('invalid team');
        const refs = createReferenceIndex();
        refs.addVisible(value);
        refs.addWorkdirs(value, { realpath: this.realpath });
        return { value, refs };
      });
      this.sources.set(path, { refs: row.refs });
      for (const member of Object.values(row.value.slices)) {
        if (member?.runId) held.set(member.runId, 'team');
        for (const id of Array.isArray(member?.runIds) ? member.runIds : []) held.set(id, 'team');
      }
    }
  }

  loopRecord(path) {
    return this.read(path, (text) => {
      const value = JSON.parse(text);
      if (!isObject(value)) throw new Error('invalid loop record');
      const refs = createReferenceIndex();
      collectRunRecord(refs, value, { realpath: this.realpath });
      return { value, refs };
    });
  }

  readLoops(held) {
    const base = join(this.data, 'loop');
    for (const name of this.listing(base, { required: true })) {
      if (!name.endsWith('.json')) continue;
      const stem = name.slice(0, -5);
      const path = join(base, name);
      try {
        const row = this.loopRecord(path);
        this.sources.set(path, { refs: row.refs });
        const state = row.value;
        if (name === 'active-pointer.json') {
          if (typeof state.sessionId !== 'string') throw new Keep('unreadable-loop-owner');
          held.set(state.sessionId, 'loop-pointer');
          continue;
        }
        if (state.active !== false || state.pending !== false) {
          if (stem.startsWith('pending-') && !state.terminalSessionId) throw new Keep('unreadable-loop-owner');
          for (const id of [state.runId, state.terminalSessionId, stem]) if (id) held.set(id, 'live-loop');
        }
      } catch {
        if (!RUN_ID.test(stem)) throw new Keep('unreadable-loop-owner');
        held.set(stem, 'unreadable-loop');
      }
    }
  }

  /** New lines only, for a file that only grows. A line that cannot be parsed is read as plain text. */
  async readTranscript(path) {
    let st;
    try { st = lstatSync(path, BIG); }
    catch (error) {
      if (!missing(error)) throw error;
      this.sources.delete(path);
      return;
    }
    if (!st.isFile()) throw new Keep('unreadable-references');
    const previous = this.sources.get(path);
    const grows = previous && previous.dev === st.dev && previous.ino === st.ino && Number(st.size) >= previous.offset;
    if (grows && previous.size === st.size && previous.mtimeNs === st.mtimeNs) return;
    const refs = grows ? previous.refs : createReferenceIndex();
    let offset = grows ? previous.offset : 0;
    let position = offset;
    let carry = Buffer.alloc(0);
    const line = (bytes) => {
      const text = bytes.toString('utf8');
      if (!HAS_SCRATCH.test(text)) return;
      try { collectTranscriptEntry(refs, JSON.parse(text)); } catch { refs.addText(text); }
    };
    const fd = openSync(path, READ_FLAGS);
    try {
      const opened = fstatSync(fd, BIG);
      if (opened.dev !== st.dev || opened.ino !== st.ino) throw new Keep('unreadable-references');
      const chunk = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const got = readSync(fd, chunk, 0, CHUNK, position);
        if (!got) break;
        position += got;
        let data = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : Buffer.from(chunk.subarray(0, got));
        let start = 0;
        for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
          line(data.subarray(start, end));
          offset += end - start + 1;
          start = end + 1;
        }
        data = data.subarray(start);
        if (data.length > MAX_LINE) {
          // One enormous line: read as text, keeping an overlap so a path across the cut is still seen.
          refs.addText(data.toString('utf8'));
          offset += data.length - LINE_OVERLAP;
          data = data.subarray(data.length - LINE_OVERLAP);
        }
        carry = Buffer.from(data);
        await this.pause();
      }
    } finally { closeSync(fd); }
    // A line still being written: seen now, read properly once it is complete.
    const partial = createReferenceIndex();
    if (carry.length) partial.addText(carry.toString('utf8'));
    this.sources.set(path, { refs, partial, offset, dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs });
  }

  async readTranscripts() {
    const base = join(this.data, 'assistant');
    const seen = new Set();
    for (const name of this.listing(base)) {
      const folder = join(base, name);
      let st;
      try { st = lstatSync(folder); } catch (error) { if (missing(error)) continue; throw error; }
      if (!st.isDirectory()) continue;
      const path = join(folder, 'transcript.jsonl');
      seen.add(path);
      await this.readTranscript(path);
    }
    const prefix = base + sep;
    for (const key of this.sources.keys()) if (key.startsWith(prefix) && !seen.has(key)) this.sources.delete(key);
  }

  readSavedWork() {
    for (const name of this.listing(this.data)) {
      if ((name.startsWith('loop-schedules') || name.startsWith('loop-templates')) && name.endsWith('.json')) this.jsonRefs(join(this.data, name));
    }
    for (const path of [join(this.data, 'skills', 'reviews.json'), join(this.data, 'assistant-sessions.json')]) {
      try { this.jsonRefs(path); }
      catch (error) { if (!missing(error)) throw error; this.sources.delete(path); }
    }
  }

  /** The outbox survives a restart; team claims and journal rows can outlive a registry entry. */
  async readCoordination(held) {
    const path = join(this.data, 'coordination.db');
    let st;
    try {
      if (realpathSync.native(path) !== path) throw new Keep('unreadable-coordination');
      st = lstatSync(path, BIG);
    } catch (error) {
      throw error instanceof Keep ? error : new Keep('unreadable-coordination');
    }
    if (!st.isFile()) throw new Keep('unreadable-coordination');
    const { DatabaseSync } = await import('node:sqlite');
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA busy_timeout=200');
      db.exec('PRAGMA query_only=ON');
      if (db.prepare('SELECT MAX(version) AS v FROM migrations').get()?.v !== COORDINATION_SCHEMA) throw new Keep('unknown-coordination-schema');
      const identity = `${st.dev}:${st.ino}`;
      if (this.eventDb !== identity) {
        this.eventDb = identity;
        this.lastEvent = 0;
        this.eventRefs = createReferenceIndex();
      }
      const last = Number(db.prepare('SELECT MAX(seq) AS s FROM events').get()?.s) || 0;
      const page = db.prepare('SELECT seq, payload FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT 128');
      while (this.lastEvent < last) {
        const before = this.lastEvent;
        for (const row of page.all(before, last)) {
          if (HAS_SCRATCH.test(row.payload)) {
            try { this.eventRefs.addVisible(JSON.parse(row.payload)); } catch { this.eventRefs.addText(row.payload); }
          }
          this.lastEvent = Number(row.seq);
        }
        if (this.lastEvent === before) break; // the coordination pruner removed the rest of this window
        await this.pause();
      }
      this.sources.set('coordination:events', { refs: this.eventRefs });
      const outbox = createReferenceIndex();
      for (const row of db.prepare('SELECT run_id, text FROM outbox WHERE sent_at IS NULL').all()) {
        outbox.addText(row.text);
        held.set(row.run_id, 'queued-followup');
      }
      this.sources.set('coordination:outbox', { refs: outbox });
      for (const row of db.prepare('SELECT run_id FROM claims WHERE released_at IS NULL AND run_id IS NOT NULL UNION SELECT run_id FROM team_tasks WHERE run_id IS NOT NULL').all()) {
        held.set(row.run_id, 'team');
      }
    } catch (error) {
      throw error instanceof Keep ? error : new Keep('unreadable-coordination');
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }

  /** The current holds, with every reference source brought up to date. Throws when one cannot be read. */
  async collect() {
    const held = new Map();
    this.readTeams(held);
    this.readLoops(held);
    await this.readTranscripts();
    this.readSavedWork();
    await this.readCoordination(held);
    this.sources.set('ledger:dispatches', { refs: this.ledger('assistant-dispatches.json').refs });
    this.sources.set('ledger:native', { refs: this.ledger('native-loop-runs.json').refs });
    for (const source of this.sources.values()) {
      for (const run of source.refs?.workdirs || []) if (!held.has(run)) held.set(run, 'working-directory');
    }
    return held;
  }

  /** Everything that points into this run's folder. `overflow`: more references than can be kept apart. */
  referencesTo(run) {
    const tails = new Set();
    let overflow = false;
    const take = (refs) => {
      if (!refs) return;
      for (const tail of refs.byRun.get(run) || []) tails.add(tail);
      if (refs.overflow.has(run)) overflow = true;
    };
    for (const source of this.sources.values()) { take(source.refs); take(source.partial); }
    take(this.sidecars.get(run));
    return { tails, overflow };
  }

  /** The registry clips a turn's text. Its whole text must be somewhere, or a link in the cut part would be missed. */
  checkComplete(run, dispatch) {
    const turns = Array.isArray(dispatch.turns) ? dispatch.turns : [];
    if (turns.length && turns[0]?.n !== 1) throw new Keep('incomplete-references');
    this.sidecars.delete(run);
    turns.forEach((turn, position) => {
      const text = typeof turn?.text === 'string' ? turn.text : '';
      if (text.length < TURN_TEXT_CAP) return;
      const raw = turn?.result?.raw;
      if (typeof raw === 'string' && raw.length >= text.length) return;
      if (position !== turns.length - 1) throw new Keep('incomplete-references');
      let kept;
      try {
        kept = this.read(join(this.data, 'run-tails', `${run}.text.json`), (body) => JSON.parse(body));
      } catch { throw new Keep('incomplete-references'); }
      if (!isObject(kept) || typeof kept.text !== 'string' || kept.cut === true || kept.turn !== turn.n) throw new Keep('incomplete-references');
      const refs = createReferenceIndex();
      refs.addText(kept.text);
      this.sidecars.set(run, refs);
    });
  }

  /** @returns {{ end: number, task: boolean }} a run that is positively over. Throws Keep for anything else. */
  evaluate(run, held) {
    if (!RUN_ID.test(run)) throw new Keep('unknown');
    const dispatches = this.ledger('assistant-dispatches.json').index;
    const natives = this.ledger('native-loop-runs.json').index;
    if (held.has(run)) throw new Keep(held.get(run));
    const native = natives.get(run);
    const dispatch = dispatches.get(run);
    if (!native || (dispatches.has(run) && !dispatch)) throw new Keep('unknown');
    if (native.runMode === 'task' || native.source === 'assistant') {
      if (!dispatch || native.runMode !== 'task' || native.source !== 'assistant') throw new Keep('unknown-dispatch');
    } else if (native.runMode !== 'loop' || !LOOP_SOURCES.has(native.source) || dispatch) {
      throw new Keep('ambiguous-owner');
    }
    const finished = [];
    for (const [row, state, end] of [[native, 'status', 'completedAt'], [dispatch, 'state', 'finishedAt']]) {
      if (!row) continue;
      if (!TERMINAL.has(row[state]) || ![undefined, null, 'terminal'].includes(row.turnState) || row.active) throw new Keep('live-or-unknown-state');
      const waiting = row.pending !== undefined && row.pending !== null && !(Array.isArray(row.pending) && !row.pending.length);
      if (waiting || row.judging || row.resumeInfo?.inFlight) throw new Keep('pending');
      if (row.team || row.teamId || String(row.workflowId).startsWith('team:')) throw new Keep('team');
      finished.push(timestamp(row[end]));
    }
    if (dispatch) {
      if (dispatch.confinement || dispatch.teamBrief) throw new Keep('team-or-review');
      const own = typeof dispatch.scratchDir === 'string' ? this.realpath(dispatch.scratchDir) : null;
      if (own !== join(this.data, 'scratch', run)) throw new Keep('ambiguous-owner');
      this.checkComplete(run, dispatch);
    }
    // GET /api/loop/active and the session hooks unlink inactive markers: only a cleanly absent one is optional.
    let marker;
    try {
      marker = this.loopRecord(join(this.data, 'loop', `${run}.json`)).value;
    } catch (error) {
      if (!missing(error)) throw error;
      this.listing(join(this.data, 'loop'), { required: true });
      return { end: Math.max(...finished), task: !!dispatch };
    }
    if (!isObject(marker) || marker.runId !== run || marker.terminalSessionId !== run) throw new Keep('ambiguous-owner');
    if (marker.team || marker.confinement) throw new Keep('team-or-review');
    if (marker.active !== false || marker.pending !== false) throw new Keep('live-loop');
    finished.push(timestamp(marker.completedAt));
    return { end: Math.max(...finished), task: !!dispatch };
  }
}
