// ═══════════════════════════════════════════
// SynaBun — Assistant hidden models (every provider)
// ═══════════════════════════════════════════
//
// The models the user switched off in the Assistant's Models manager. The
// router, the dispatcher, the catalog (routing sheet, agent_catalog) and every
// Assistant model menu leave them out. One denylist per provider, so new
// models start enabled:
//   claude-code, codex → ~/.synabun/data/assistant-hidden-models.json
//   opencode           → the Settings → OpenCode store (lib/opencode-hidden-models.js),
//                        so both screens edit the same list
// Matching (lib/assistant-catalog.js hiddenModelId): the id, or the row's
// resolved model at the same context window, case-insensitive; context
// variants ("opus" / "opus[1m]", "gpt-x" / "gpt-x[extended]") hide
// independently. OpenCode ids match full or bare. Re-read when the file
// changes (time, size or inode); writes are atomic.
//
// Every save is one read-modify-write of the file as it is on disk at that
// moment, alone among SynaBun's writers (two servers can share a data home):
// an OS-held mutex next to the data (hiddenModelsLockPath; an empty SQLite file,
// lib/rulesets/lock.js) and, right before the new file takes the old one's
// place, a second look at what is there. A document someone saved in between (a
// hand edit, an older build, which take no mutex) is the newer one: the change
// is made again on it, and an automatic one (the pin migration below) that
// cannot be made that way is not saved at all.
//
// A hidden alias hides a model, not a name. "haiku", "opus", "default" name
// whatever Claude Code points them at, and a CLI update moves them. So an alias
// entry carries a pin: the model and context window it named when the user hid
// it, its label and the time (`pins` in the file, next to `providers`; a build
// that knows nothing of pins still reads the lists). Each catalog build settles
// the pins against the rows the provider lists (reconcile → planHiddenPins):
//   the alias still names the pinned model  → hidden, as before
//   the alias names another model           → the alias is shown again and the
//                                             pinned model stays hidden under
//                                             its own id (the entry is rewritten)
//   an alias entry with no pin (written by  → pinned to what the alias names
//   an older build, or hidden while the       now, marked `inferred`
//   list was not a verified one)
//   an entry already rewritten, whose model → the entry takes the id the model is
//   is listed under another id                listed by (it was absent, or respelled)
// A pinned entry hides its own row only. What an alias names comes from the
// row's `upstream`, which is the `resolvedModel` the Claude Code CLI reports
// for it. Nothing is decided without it: while the list is the static
// stand-in, the provider does not answer, the alias is not listed, or the CLI
// names no versioned model behind it, an entry keeps hiding the alias by name.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Router } from 'express';
import { CATALOG_PROVIDERS, aliasTargetOf, baseModelId, canonicalModelId, contextSuffix, contextVariantOf, modelIdentity, pinnedModelId, sameModelPin } from './assistant-catalog.js';
import { HIDDEN_MODELS_SYNC_TYPE as OPENCODE_SYNC_TYPE } from './opencode-hidden-models.js';
import { createWriterLock } from './rulesets/lock.js';

export const ASSISTANT_HIDDEN_SYNC_TYPE = 'assistant:hidden-models-changed';
export const OWN_PROVIDERS = Object.freeze(['claude-code', 'codex']);
export const MAX_HIDDEN_PER_PROVIDER = 2000;
/** How long a save waits for another process that is saving. */
export const HIDDEN_LOCK_TIMEOUT_MS = 2000;
/** The same for the pin migration, which runs inside a catalog build and is made again by the next one. */
export const HIDDEN_MIGRATION_WAIT_MS = 250;
/** How many times one save is made again on a file that changed under it before it gives up. */
export const HIDDEN_SAVE_ATTEMPTS = 3;

const FILE_IO = Object.freeze({ mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync });
const NO_FILE = 'absent';

/**
 * The mutex that goes with a hidden-models file: <data home>/runtime/<name>.mutex
 * for <data home>/data/<name>.json, outside data/ so no backup or restore ever
 * opens it (see lib/rulesets/lock.js on why nothing may), and beside the file
 * for any other layout.
 */
export function hiddenModelsLockPath(file) {
  const dir = dirname(file);
  const name = `${basename(file).replace(/\.json$/i, '')}.mutex`;
  return basename(dir) === 'data' ? join(dirname(dir), 'runtime', name) : join(dir, name);
}

function hiddenError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}
function arr(value) { return Array.isArray(value) ? value : []; }

/** Unique (case-insensitive), sorted model ids; blanks and oversize values are dropped. */
export function normalizeModelIds(list) {
  const out = new Map();
  for (const value of arr(list)) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id.length > 300) continue;
    if (!out.has(id.toLowerCase())) out.set(id.toLowerCase(), id);
    if (out.size >= MAX_HIDDEN_PER_PROVIDER) break;
  }
  return [...out.values()].sort();
}

const text = (value, max = 300) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** One pin record, or null when it names no model: { model, variant, label, at, alias?, movedAt?, inferred? }. */
export function normalizePin(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = text(baseModelId(text(raw.model) || ''))?.toLowerCase() || null;
  if (!model) return null;
  const variant = contextVariantOf(`x[${String(raw.variant || '').toLowerCase()}]`);
  const pin = { model, variant, label: text(raw.label, 200), at: text(raw.at, 40) };
  if (text(raw.alias)) pin.alias = text(raw.alias);
  if (text(raw.movedAt, 40)) pin.movedAt = text(raw.movedAt, 40);
  if (raw.inferred === true) pin.inferred = true;
  return pin;
}

/** The pins of the ids in `ids`, keyed by lower-case id; anything else is dropped. */
export function normalizePins(raw, ids) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const source = new Map(Object.entries(raw).map(([key, value]) => [String(key).toLowerCase(), value]));
  for (const key of arr(ids).map((id) => String(id).toLowerCase()).sort()) {
    const pin = normalizePin(source.get(key));
    if (pin) out[key] = pin;
  }
  return out;
}

/** The pin to record when `row` is hidden: what the alias names now, with its label. null for a row that is its own model. */
export function pinForRow(row) {
  const target = aliasTargetOf(row);
  return target ? { ...target, label: text(row.label, 200) } : null;
}

/**
 * Settle one provider's hidden ids against the rows it lists (pure).
 *   ids, pins  the stored list and its pin records
 *   rows       every row of the provider, hidden ones included
 *   source     how the list was obtained; only 'live' decides anything
 *   at         the time to record (ISO)
 * → { ids, pins, changed, moved: [{ alias, from, to, listed }], pinned: [ids] }
 */
export function planHiddenPins({ ids = [], pins = {}, rows = [], source = null, at = null } = {}) {
  const live = source === 'live';
  const list = arr(rows).filter((row) => row?.id);
  const byId = new Map(list.map((row) => [String(row.id).toLowerCase(), row]));
  const current = normalizePins(pins, ids);
  const nextIds = [];
  const nextPins = {};
  const seen = new Set();
  const keep = (id, pin) => {
    const key = String(id).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    nextIds.push(id);
    if (pin) nextPins[key] = pin;
    return true;
  };
  const moved = [];
  const pinned = [];
  const movedOn = [];
  const adrift = [];
  // The row that is the model a pin names, under the id the provider lists it by (a snapshot date is the same model).
  const ownRowOf = (pin) => list.find((row) => !aliasTargetOf(row) && sameModelPin(pin, { model: baseModelId(row.id), variant: contextVariantOf(row.id) })) || null;
  for (const id of arr(ids)) {
    const key = String(id).toLowerCase();
    const pin = current[key] || null;
    const row = byId.get(key) || null;
    // An entry already rewritten to its model's own id (`alias` says from where) is that model, never an
    // alias again. It hides the model whatever id the provider lists it by today: with no row under the
    // stored id it is settled below, by model.
    if (live && pin?.alias) { if (row) keep(id, pin); else adrift.push({ id, pin }); continue; }
    const target = live && row ? aliasTargetOf(row) : null;
    // Not an alias with a model named behind it, or nothing verified to read it from: as it is.
    if (!target) { keep(id, pin); continue; }
    if (!pin) {
      // Written before pins existed: it hides what the alias names now, as it did until this moment.
      keep(id, { ...target, label: text(row.label, 200), at, inferred: true });
      pinned.push(id);
      continue;
    }
    if (sameModelPin(pin, target)) { keep(id, pin); continue; }
    movedOn.push({ id, pin, target });
  }
  // After every entry that stays, so an entry the user made for the old model keeps its own meaning.
  // The model is listed again, or under another id (it was absent when its alias moved on, or the provider
  // respelled it): the entry follows it. Not listed at all: it waits under the id it has.
  for (const { id, pin } of adrift) {
    const own = ownRowOf(pin);
    keep(own ? String(own.id) : id, pin);
  }
  for (const { id, pin, target } of movedOn) {
    const own = ownRowOf(pin);
    const concrete = own ? String(own.id) : pinnedModelId(pin);
    keep(concrete, { model: pin.model, variant: pin.variant, label: pin.label, at: pin.at, alias: String(id), movedAt: at });
    moved.push({ alias: String(id), from: concrete, to: pinnedModelId(target), listed: !!own });
  }
  const sameIds = normalizeModelIds(nextIds).join('\n') === normalizeModelIds(ids).join('\n');
  const finalPins = normalizePins(nextPins, nextIds);
  const changed = !sameIds || JSON.stringify(finalPins) !== JSON.stringify(normalizePins(pins, ids));
  return { ids: normalizeModelIds(nextIds), pins: finalPins, changed, moved, pinned };
}

/**
 * The Claude Code / Codex store:
 * { version, updatedAt, providers: { 'claude-code': [], codex: [] }, pins: { 'claude-code': { [id]: pin }, codex: {} } }.
 */
export function createAssistantHiddenModelsStore({
  path, now = Date.now, log = () => {},
  lockPath = path ? hiddenModelsLockPath(path) : null, lockTimeoutMs = HIDDEN_LOCK_TIMEOUT_MS,
  // The file calls (node:fs by default): a seam for tests that save between two of them.
  fs: io = FILE_IO,
} = {}) {
  if (!path) throw new Error('createAssistantHiddenModelsStore requires path');
  const emptyProviders = () => Object.fromEntries(OWN_PROVIDERS.map((p) => [p, []]));
  const emptyPins = () => Object.fromEntries(OWN_PROVIDERS.map((p) => [p, {}]));
  const empty = Object.freeze({ providers: emptyProviders(), pins: emptyPins(), version: 0, updatedAt: null });
  let cached = null; // { stamp, value }
  const listeners = new Set();

  /** Which file is there, by stat alone: '' when there is none. An atomic save is a new inode even inside one clock tick. */
  function stamp() { try { const info = io.statSync(path); return `${info.mtimeMs}:${info.size}:${info.ino}`; } catch { return ''; } }
  /** The revision of the file on disk: a digest of its bytes, NO_FILE when there is none. */
  function revisionOf(raw) { return createHash('sha256').update(raw).digest('hex'); }
  function revisionOnDisk() {
    try { return revisionOf(io.readFileSync(path, 'utf8')); }
    catch (error) { return error?.code === 'ENOENT' ? NO_FILE : `unreadable:${error?.code || 'read'}`; }
  }
  /** The document on disk, never the copy in memory: { value, rev, readable } (`readable` false = it is there and does not parse). */
  function load() {
    let raw;
    try { raw = io.readFileSync(path, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return { value: empty, rev: NO_FILE, readable: true };
      log('hidden-models:unreadable', error?.message || String(error));
      return { value: cached?.value || empty, rev: `unreadable:${error?.code || 'read'}`, readable: false };
    }
    try {
      const doc = JSON.parse(raw) || {};
      const providers = emptyProviders();
      const pins = emptyPins();
      for (const p of OWN_PROVIDERS) {
        providers[p] = normalizeModelIds(doc.providers?.[p]);
        pins[p] = normalizePins(doc.pins?.[p], providers[p]);
      }
      return { value: { providers, pins, version: Number(doc.version) || 0, updatedAt: doc.updatedAt || null }, rev: revisionOf(raw), readable: true };
    } catch (error) {
      log('hidden-models:unreadable', error?.message || String(error));
      return { value: cached?.value || empty, rev: revisionOf(raw), readable: false };
    }
  }
  function read() {
    const s = stamp();
    if (cached && cached.stamp === s) return cached.value;
    const value = s ? load().value : empty;
    cached = { stamp: s, value };
    return value;
  }
  function list(provider) { return read().providers[provider] || []; }
  function pins(provider) { return read().pins?.[provider] || {}; }

  /** Run `fn` as the only SynaBun writer of the file. Throws (nothing was changed) when the mutex cannot be had within `waitMs`. */
  function alone(fn, waitMs = lockTimeoutMs) {
    const lock = createWriterLock(lockPath, { timeoutMs: Math.min(lockTimeoutMs, waitMs) });
    try { lock.enter(); } catch (error) {
      lock.close();
      if (error?.code === 'BUSY') throw hiddenError('HIDDEN_BUSY', 'Another SynaBun process is saving the hidden-models list right now, so nothing was changed. Try again in a moment.', 503, { retryable: true });
      throw hiddenError('HIDDEN_LOCK_UNAVAILABLE', `SynaBun could not lock the hidden-models list (${lockPath}): ${error?.cause?.message || error?.message || error}. Nothing was changed.`, 503);
    }
    // One connection per save, closed with it: nothing stays open on the mutex between two saves.
    try { return fn(); } finally { lock.leave(); lock.close(); }
  }

  /**
   * One read-modify-write of one provider's list. `decide(document)` gets the document as it is
   * on disk at that moment and answers { ids, pins? } (`pins` default: the ones the provider has; a
   * pin whose id left the list goes with it) or null for no change. It runs again when the file
   * changed before the new one could take its place, so it must be a function of the document it
   * is given. Nothing is saved over a file that is there and does not parse (someone is in the
   * middle of saving it, or it needs a hand). `reason` reaches the listeners; `waitMs` shortens
   * the wait for another process that is saving (the server's event loop stands still meanwhile).
   * Returns { providers, pins, version, updatedAt, changed }.
   */
  function change(provider, decide, { reason = null, waitMs = lockTimeoutMs } = {}) {
    if (!OWN_PROVIDERS.includes(provider)) throw hiddenError('PROVIDER_INVALID', `provider must be one of ${OWN_PROVIDERS.join(', ')}`);
    const saved = alone(() => {
      for (let attempt = 1; ; attempt += 1) {
        const found = load();
        if (!found.readable) throw hiddenError('HIDDEN_UNREADABLE', `The hidden-models file (${path}) could not be read as JSON right now, so it was left as it is. If it stays that way, fix or remove it.`, 409, { retryable: true });
        const current = found.value;
        const wanted = decide(current);
        const nextList = wanted ? normalizeModelIds(wanted.ids) : current.providers[provider];
        const nextPins = wanted ? normalizePins(wanted.pins === undefined ? current.pins?.[provider] : wanted.pins, nextList) : null;
        const changed = !!wanted && (current.providers[provider].join('\n') !== nextList.join('\n')
          || JSON.stringify(nextPins) !== JSON.stringify(current.pins?.[provider] || {}));
        if (!changed) return { value: current, changed: false };
        const next = {
          version: current.version + 1, updatedAt: new Date(now()).toISOString(),
          providers: { ...current.providers, [provider]: nextList },
          pins: { ...emptyPins(), ...current.pins, [provider]: nextPins },
        };
        io.mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.${now()}.tmp`;
        try {
          io.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
          // Once more, with the new file ready: a writer outside the mutex (a hand edit, an older build) may
          // have saved since `found` was read. Its document is the newer one and is never replaced by a
          // decision made without it.
          if (revisionOnDisk() !== found.rev) {
            if (attempt >= HIDDEN_SAVE_ATTEMPTS) throw hiddenError('HIDDEN_BUSY', 'The hidden-models file kept changing while SynaBun was saving it, so it was left as it is. Try again in a moment.', 503, { retryable: true });
            continue;
          }
          io.renameSync(tmp, path);
        } finally {
          try { io.rmSync(tmp, { force: true }); } catch {}
        }
        cached = { stamp: stamp(), value: next };
        return { value: next, changed: true };
      }
    }, waitMs);
    // Outside the mutex: a listener may read or save in its turn.
    if (saved.changed) for (const listener of listeners) { try { listener(saved.value, { provider, changed: true, reason }); } catch {} }
    return { ...saved.value, changed: saved.changed };
  }

  /**
   * Replace one provider's list. `pins` replaces its pin records (default: the ones it has);
   * a pin whose id left the list goes with it. `reason` reaches the listeners.
   * Returns { providers, pins, version, updatedAt, changed }.
   */
  function set(provider, ids, { pins: nextPinsRaw = undefined, reason = null } = {}) {
    return change(provider, () => ({ ids, pins: nextPinsRaw }), { reason });
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  return { read, list, pins, set, change, onChange, path, lockPath };
}

/**
 * One view over both stores.
 *   list(provider) → ids; all() → { 'claude-code', codex, opencode }
 *   pins(provider) → { [id]: pin }; allPins() → the same per provider (OpenCode has none)
 *   update(provider, { hide, show, pins }) → { provider, hidden, changed, added, removed };
 *     `pins` = { [id]: { model, variant, label } } for the aliases among `hide` (pinForRow)
 *   reconcile({ provider, rows, source }) → { ids, pins, moved, pinned } | null: settles the
 *     pins against the rows a catalog build lists (planHiddenPins) and saves what changed
 *   Both save through the store's `change`: on the document that is on disk at that moment.
 *   onChange(fn) → fn({ provider, reason, moved }) after either store changes; reason 'pins' =
 *     reconcile's own write (`moved` lists the aliases that were shown again)
 * OpenCode ids are "provider/model" (its store drops anything else); callers
 * resolve bare ids first (the router does, from the catalog).
 */
export function createHiddenModels({ file, opencodeStore = null, now = Date.now, log = () => {}, lockPath = undefined, lockTimeoutMs = undefined, fs = undefined } = {}) {
  const own = createAssistantHiddenModelsStore({ path: file, now, log, lockPath, lockTimeoutMs, fs });
  const listeners = new Set();
  let settling = null; // what reconcile is saving right now, for its change event
  const emit = (provider, reason = null) => {
    const event = { provider, reason, moved: reason === 'pins' ? settling?.moved || [] : [] };
    for (const fn of listeners) { try { fn(event); } catch {} }
  };
  own.onChange((_value, meta) => emit(meta?.provider || null, meta?.reason || null));
  opencodeStore?.onChange?.(() => emit('opencode'));

  function list(provider) {
    if (provider === 'opencode') { try { return arr(opencodeStore?.list?.()); } catch { return []; } }
    return OWN_PROVIDERS.includes(provider) ? own.list(provider) : [];
  }
  function all() { return Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, list(p)])); }
  function pins(provider) { return OWN_PROVIDERS.includes(provider) ? own.pins(provider) : {}; }
  function allPins() { return Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, pins(p)])); }

  function reconcile({ provider, rows = [], source = null } = {}) {
    if (!OWN_PROVIDERS.includes(provider)) return null;
    const at = new Date(now()).toISOString();
    const settle = (ids, pins) => planHiddenPins({ ids, pins, rows, source, at });
    // The look every build takes, from the copy in memory: most have nothing to settle and save nothing.
    let plan = settle(own.list(provider), own.pins(provider));
    if (plan.changed) {
      // Nobody asked for this change, so it is settled again on the document that is on disk when the
      // save happens: an id someone added since this build read the list is part of what gets saved.
      // A list that cannot be saved still applies to this build; the next one settles it again, so
      // a build never waits long for another process.
      try {
        own.change(provider, (doc) => {
          plan = settle(doc.providers[provider], doc.pins?.[provider] || {});
          settling = plan;
          return plan.changed ? { ids: plan.ids, pins: plan.pins } : null;
        }, { reason: 'pins', waitMs: HIDDEN_MIGRATION_WAIT_MS });
      } catch (error) { log('hidden-models:pins-unsaved', error?.message || String(error)); }
      finally { settling = null; }
      for (const m of plan.moved) log('hidden-models:alias-moved', `${provider}: "${m.alias}" now names ${m.to}; ${m.from} stays hidden, "${m.alias}" is shown`);
    }
    return { ids: plan.ids, pins: plan.pins, moved: plan.moved, pinned: plan.pinned };
  }

  function update(provider, { hide = [], show = [], pins: hidePins = null } = {}) {
    if (!CATALOG_PROVIDERS.includes(provider)) throw hiddenError('PROVIDER_INVALID', `provider must be one of ${CATALOG_PROVIDERS.join(', ')}`);
    if (provider === 'opencode' && !opencodeStore) throw hiddenError('PROVIDER_UNAVAILABLE', 'The OpenCode hidden-model store is not available.', 503);
    const key = (id) => String(id).trim().toLowerCase();
    const hideIds = arr(hide).map((id) => String(id || '').trim()).filter(Boolean);
    const showKeys = new Set(arr(show).map(key).filter(Boolean));
    /** This edit on the list it finds: the list after it, and what it added and removed. */
    const edit = (current) => {
      const next = new Map(current.map((id) => [key(id), id]));
      for (const id of hideIds) if (!next.has(key(id))) next.set(key(id), id);
      for (const k of showKeys) next.delete(k);
      const nextList = [...next.values()];
      const before = new Set(current.map(key));
      const after = new Set(nextList.map(key));
      return { current, nextList, added: nextList.filter((id) => !before.has(key(id))), removed: current.filter((id) => !after.has(key(id))) };
    };
    if (provider === 'opencode') {
      const { current, nextList, added, removed } = edit(list(provider));
      if (!added.length && !removed.length) return { provider, hidden: current, changed: false, added, removed };
      const result = opencodeStore.set(nextList);
      return { provider, hidden: result.models, changed: true, added, removed, version: result.version };
    }
    const given = hidePins && typeof hidePins === 'object' ? new Map(Object.entries(hidePins).map(([id, pin]) => [key(id), pin])) : new Map();
    const at = new Date(now()).toISOString();
    // An edit is a difference, so it is made on the list that is on disk when it is saved: what another
    // writer added or removed in the meantime stays as that writer left it.
    let made = null;
    const result = own.change(provider, (doc) => {
      made = edit(doc.providers[provider]);
      if (!made.added.length && !made.removed.length) return null;
      // An alias that is hidden now is pinned to the model it names now; an id already hidden keeps its pin.
      const nextPins = { ...(doc.pins?.[provider] || {}) };
      for (const id of made.added) {
        const pin = normalizePin(given.get(key(id)));
        if (pin) nextPins[key(id)] = { ...pin, at };
      }
      return { ids: made.nextList, pins: nextPins };
    });
    const { added, removed } = made;
    if (!result.changed) return { provider, hidden: made.current, changed: false, added, removed };
    return { provider, hidden: result.providers[provider], pins: result.pins[provider], changed: true, added, removed, version: result.version };
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  return { list, all, pins, allPins, update, reconcile, onChange, store: own, path: file };
}

// ── resolving user-typed ids against the unfiltered catalog ─────────────────

/**
 * How well `want` names `row` (higher is better, 0 = no match): exact id 4,
 * case-insensitive id 3, resolved model at the same context window or bare
 * OpenCode id 2, label 1. The context suffix always counts: "opus" never
 * names "opus[1m]".
 */
function rowScore(row, want) {
  const id = String(row.id || '');
  const lower = want.toLowerCase();
  if (id === want) return 4;
  if (id.toLowerCase() === lower) return 3;
  if (row.provider === 'claude-code' && row.upstream && `${baseModelId(row.upstream)}${contextSuffix(id)}`.toLowerCase() === lower) return 2;
  if (row.provider === 'opencode' && !want.includes('/') && id.split('/').slice(1).join('/').toLowerCase() === lower) return 2;
  if (String(row.label || '').toLowerCase() === lower) return 1;
  return 0;
}

function suggestionsFor(rowsByProvider, want, provider = null) {
  const needle = String(want || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const score = (row) => { const id = String(row.id).toLowerCase().replace(/[^a-z0-9]/g, ''); let s = 0; for (const ch of new Set(needle)) if (id.includes(ch)) s += 1; if (id.includes(needle)) s += 10; return s; };
  const rows = Object.entries(rowsByProvider).filter(([p]) => !provider || p === provider).flatMap(([p, list]) => list.map((row) => ({ ...row, provider: p })));
  return rows.sort((a, b) => score(b) - score(a)).slice(0, 5).map((row) => ({ provider: row.provider, id: row.id }));
}

/**
 * Resolve one id to { provider, id } for `action` ('hide' | 'show').
 * `rowsByProvider` = every catalog row, hidden ones included; `hiddenByProvider`
 * = the current lists (a model that left the catalog can still be shown again).
 * A claude-* id the CLI accepts without listing it can be hidden too.
 */
export function resolveHiddenModelId({ id, provider = null, action = 'hide', rowsByProvider = {}, hiddenByProvider = {} }) {
  const typed = String(id || '').trim();
  if (!typed) throw hiddenError('MODEL_REQUIRED', 'Model id required.');
  const providers = provider ? [provider] : CATALOG_PROVIDERS;
  const candidates = [];
  let want = typed;
  for (const p of providers) {
    want = canonicalModelId(p, typed);
    let best = null;
    for (const row of arr(rowsByProvider[p])) {
      const s = rowScore({ ...row, provider: p }, want);
      // A resolved-model match hides the resolved id itself, so every alias of
      // it (default, opus, …) goes with it, at that context window only.
      if (s && (!best || s > best.score)) best = { provider: p, id: s === 2 && p === 'claude-code' ? want.toLowerCase() : row.id, score: s };
    }
    if (!best && action === 'show') {
      const lower = want.toLowerCase();
      const hit = arr(hiddenByProvider[p]).find((h) => String(h).toLowerCase() === lower || (p === 'opencode' && !want.includes('/') && String(h).split('/').slice(1).join('/').toLowerCase() === lower));
      if (hit) best = { provider: p, id: hit, score: 3 };
    }
    if (!best && p === 'claude-code' && /^claude-[a-z0-9.\-]+(\[1m\])?$/i.test(want)) best = { provider: p, id: want.toLowerCase(), score: 1 };
    if (best) candidates.push(best);
  }
  want = typed;
  if (!candidates.length) {
    throw hiddenError('MODEL_UNKNOWN', `Unknown model "${want}"${provider ? ` for ${provider}` : ''}. Use an id from the Assistant's Models list.`, 400, { suggestions: suggestionsFor(rowsByProvider, want, provider) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.filter((c) => c.score === candidates[0].score);
  if (top.length > 1) {
    throw hiddenError('MODEL_AMBIGUOUS', `"${want}" names a model of ${top.map((c) => c.provider).join(' and ')}. Pass provider.`, 400, { suggestions: top.map((c) => ({ provider: c.provider, id: c.id })) });
  }
  return { provider: top[0].provider, id: top[0].id };
}

/**
 * GET   /  → { ok, providers: { 'claude-code': [], codex: [], opencode: [] }, pins }
 * PATCH /  { provider?, hide?: [], show?: [] } → the new lists plus what changed.
 *          A missing provider is inferred from the unfiltered catalog. Hiding an
 *          alias ("haiku") records the model it names at that moment (`pins`),
 *          when the catalog's list for the provider is a live one; else the
 *          next live build records it. 503 HIDDEN_BUSY / HIDDEN_LOCK_UNAVAILABLE
 *          and 409 HIDDEN_UNREADABLE: nothing was changed.
 * Owner only (guests get 403). Broadcasts assistant:hidden-models-changed, and
 * opencode:hidden-models-changed when the OpenCode list changed.
 */
export function createAssistantHiddenModelsRouter({ hiddenModels, catalog = null, opencodeStore = null, isGuestRequest = () => false, broadcastSync = () => {} } = {}) {
  if (!hiddenModels) throw new Error('createAssistantHiddenModelsRouter requires hiddenModels');
  const router = Router();
  router.use((req, res, next) => {
    if (isGuestRequest(req)) return res.status(403).json({ ok: false, code: 'OWNER_ONLY', error: 'Admin only' });
    next();
  });
  router.get('/', (req, res) => {
    try { res.json({ ok: true, providers: hiddenModels.all(), pins: hiddenModels.allPins?.() || {} }); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  router.patch('/', async (req, res) => {
    try {
      const body = req.body || {};
      const toList = (value) => (Array.isArray(value) ? value : (typeof value === 'string' && value.trim() ? [value] : []));
      const hide = toList(body.hide);
      const show = toList(body.show);
      if (!hide.length && !show.length) throw hiddenError('MODELS_REQUIRED', 'Pass hide and/or show: arrays of model ids.');
      if (hide.length + show.length > MAX_HIDDEN_PER_PROVIDER) throw hiddenError('TOO_MANY', `At most ${MAX_HIDDEN_PER_PROVIDER} ids per request.`);
      const provider = body.provider ? String(body.provider).trim().toLowerCase() : null;
      if (provider && !CATALOG_PROVIDERS.includes(provider)) throw hiddenError('PROVIDER_INVALID', `provider must be one of ${CATALOG_PROVIDERS.join(', ')}`);
      // The rows and how each list was obtained, from one catalog build: what an alias names is
      // only taken from a list the provider just gave (`live`), never from a remembered one.
      let rowsByProvider = {};
      let sources = {};
      try {
        if (typeof catalog?.manageSnapshot === 'function') {
          const snapshot = (await catalog.manageSnapshot()) || {};
          rowsByProvider = snapshot.rows || {};
          sources = snapshot.sources || {};
        } else rowsByProvider = (await catalog?.manageRows?.()) || {};
      } catch {}
      const hiddenByProvider = hiddenModels.all();
      const plan = new Map(); // provider → { hide: [], show: [], pins: {} }
      const applied = [];
      const add = (action, raw) => {
        const hit = resolveHiddenModelId({ id: raw, provider, action, rowsByProvider, hiddenByProvider });
        if (!plan.has(hit.provider)) plan.set(hit.provider, { hide: [], show: [], pins: {} });
        plan.get(hit.provider)[action].push(hit.id);
        const entry = { action, provider: hit.provider, id: hit.id, requested: String(raw) };
        if (action === 'hide') {
          // The row being hidden: an alias is hidden as the model it names right now. While the list is
          // not a verified one the entry is saved without a pin, and the next live build pins it to what
          // the alias names then (reconcile): a pin read off a stale list would be undone by that build.
          const row = sources[hit.provider] === 'live'
            ? arr(rowsByProvider[hit.provider]).find((r) => String(r?.id || '').toLowerCase() === String(hit.id).toLowerCase())
            : null;
          const pin = row ? pinForRow({ ...row, provider: hit.provider }) : null;
          if (pin) { plan.get(hit.provider).pins[String(hit.id).toLowerCase()] = pin; entry.pinned = pinnedModelId(pin); }
        }
        applied.push(entry);
      };
      for (const id of hide) add('hide', id);
      for (const id of show) add('show', id);
      const results = [];
      for (const [p, change] of plan) results.push(hiddenModels.update(p, change));
      const changed = results.filter((r) => r.changed);
      const providers = hiddenModels.all();
      const pins = hiddenModels.allPins?.() || {};
      if (changed.length) {
        broadcastSync({ type: ASSISTANT_HIDDEN_SYNC_TYPE, providers, pins, changed: changed.map((r) => r.provider) });
        const oc = changed.find((r) => r.provider === 'opencode');
        if (oc) {
          let version = oc.version;
          try { version = opencodeStore?.read?.().version ?? version; } catch {}
          broadcastSync({ type: OPENCODE_SYNC_TYPE, models: providers.opencode, version });
        }
      }
      res.json({
        ok: true, providers, pins, changed: changed.length > 0, applied,
        added: Object.fromEntries(changed.map((r) => [r.provider, r.added])),
        removed: Object.fromEntries(changed.map((r) => [r.provider, r.removed])),
      });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.message, code: error.code || null, suggestions: error.suggestions || undefined });
    }
  });
  return router;
}
