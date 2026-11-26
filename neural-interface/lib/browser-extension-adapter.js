import { connectionAdvice } from './browser-connection-state.js';
import { createHash, randomBytes } from 'node:crypto';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import express from 'express';
import { readConfinedFileWithMetadata } from './confined-fs.js';
import { errorDetail, EVALUATE_SCRIPT_MAX, EVALUATE_TIMEOUT_MAX, EVALUATE_WORLDS, fail, handle, HISTORY, LOAD_STATES, MAX_FILE, NETWORK_IDLE_TIMEOUT_MAX, PAGED_READERS, READER_IDS, READS_SINCE, safeError, uploadType } from './browser-extension-protocol.js';
import sharp from 'sharp';
import { parseScreenshotOptions, screenshotPathRefusal, defaultScreenshotPath, writeScreenshotFile } from './browser-screenshot.js';
import { ownerOnlyCreateFields } from './browser-automation-routes.js';
import { budgetExtractionItems, EXTRACTION_TIMEOUT_MS } from './browser-extraction.js';
import { compareVersions } from './browser-extension-folder.js';

// The extension's fixed type table first (protocol.js UPLOAD_TYPES: the type the extension gives the File anyway),
// then the server's static-file MIME table for a name it does not know.
export function uploadMimeType(name) {
  const named = uploadType(name);
  if (named !== 'application/octet-stream') return named;
  const ext = extname(name).toLowerCase();
  return (ext && express.static.mime.lookup(ext)) || named;
}
const aliases = { 'screenshot-base64': 'screenshot' };
const supported = new Set(['navigate', 'back', 'forward', 'reload', 'snapshot', 'click', 'hover', 'fill', 'type', 'press', 'select', 'scroll', 'wait', 'content', 'markdown', 'extract', 'screenshot', 'upload', 'evaluate']);
// The Playwright routes' reading contract (server.js /content and /markdown), which the extension's readers answer to
// as well: the default page size of each, and the note a cut page ends with (the same words, the same next offset).
export const TEXT_PAGE_DEFAULT = 50000;
export const MARKDOWN_PAGE_DEFAULT = 80000;
export function pageOf(whole, query = {}, defaultMax, separator) {
  const totalChars = whole.length;
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  const maxChars = Math.max(1, parseInt(query.maxChars, 10) || defaultMax);
  let text = whole;
  if (offset > 0 || totalChars > offset + maxChars) {
    const slice = whole.slice(offset, offset + maxChars), more = totalChars > offset + maxChars;
    text = slice + (more ? `${separator}... (truncated — ${totalChars} chars total, pass offset=${offset + maxChars} to continue)` : '');
  }
  return { text, totalChars };
}
const SELECTOR_ONE = 'Content selector must match exactly one element.';
const argumentKeys = ['url', 'ref', 'selector', 'nthMatch', 'value', 'text', 'key', 'direction', 'distance', 'maxChars', 'offset', 'timeout', 'state'];
const unsupported = reason => Object.assign(new Error(reason), { code: 'UNSUPPORTED_IN_EXTENSION_MODE' });
// A whole number of milliseconds from a request body, 1 to `most`; undefined when none (or nothing usable) was given.
const milliseconds = (value, most) => { const n = Number(value); return Number.isFinite(n) && n >= 1 ? Math.min(most, Math.floor(n)) : undefined; };
// A refusal always says what its code means, also when the extension answered the code alone.
const worded = result => (result && result.ok === false && result.code && typeof result.error !== 'string' ? { ...result, error: safeError(result).error } : result);
// evaluate refusals after which the page's script certainly did not run (a paced write then takes no slot).
const NOTHING_RAN = ['USER_SCRIPTS_DISABLED', 'USER_SCRIPTS_UNSUPPORTED', 'EXTENSION_RELOAD_REQUIRED', 'EXTENSION_NOT_CONNECTED', 'BLANK_PAGE', 'FRAME_NOT_FOUND',
  'RESTRICTED_PAGE', 'SYNABUN_PAGE_BLOCKED', 'SITE_NOT_APPROVED', 'NOT_OWNED', 'AUTH_FAILED', 'INVALID_MESSAGE'];
// What an agent may see of its tab's address. Full control: the address. Restricted mode: an approved site's URL, or
// the blank start page; a page that history (or a redirect) took the tab to on an unapproved site stays the owner's:
// the session listing shows no URL for it.
const agentUrl = (url, status) => {
  if (url === 'about:blank') return url;
  if (status.fullControl) return typeof url === 'string' ? url : '';
  try { return status.sites.includes(new URL(url).origin) ? url : ''; } catch { return ''; }
};
// What a listing shows of a tab's address: its origin and path, never a query string or fragment (they carry sign-in
// and challenge tokens: `?jsc_token=…`, `?__cf_chl_rt_tk=…`). An agent's own navigate, snapshot and content results keep
// the full URL of its own page; only listings are cut.
export function listedUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  if (url === 'about:blank') return url;
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : ''; } catch { return ''; }
}
// A fixed sentence: never the landing page's URL, title or content.
const HISTORY_DESTINATION = 'The page this history step reached is not on an approved site (or an approval was revoked meanwhile). No page content was returned. The tab stays there and refuses commands until the owner shares that site in the extension popup (or switches to full control); release the session to stop using it.';

/** Owns routing only; extension sessions intentionally expose no Playwright/CDP surface. */
// `evaluateGate` holds page JavaScript to the rules the Playwright evaluate route holds a loop's tab to (server.js):
// `refusal({ session, req, tabId, script })` answers the X publish gate's refusal (or null), `run({ session, req, execute })`
// spaces a social write (`pace` in the body) and answers { result } or { paced } with it. Without one, nothing is gated
// (tests of the adapter alone).
// `htmlToMarkdown(html)` is the Playwright Markdown route's converter (server.js nhm.translate), so both backends turn a
// page into the same Markdown; `now` / `sleep` are the paged extraction's clock (tests pass their own).
export function createExtensionAdapter({ bridge, sessions, uploadRoot, caller, ownerPage, selected, dataHome, log = () => {}, evaluateGate = null,
  htmlToMarkdown = null, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const salt = randomBytes(32).toString('hex');
  const agent = owner => createHash('sha256').update(`${salt}:${owner}`).digest('hex');
  let sessionId = null, chain = Promise.resolve();
  const serialized = fn => { const next = chain.catch(() => {}).then(fn); chain = next; return next; };
  function session() {
    if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);
    sessionId = randomBytes(16).toString('hex');
    const s = { id: sessionId, _profileMode: 'extension', _profileSourceName: 'Everyday browser extension', _isPersistent: false,
      createdAt: Date.now(), clients: new Set(), tabs: new Map(), _tabOwners: new Map(), _loopOwned: new Set(), _interactiveOwned: new Set(), currentUrl: '', title: '', activeTabId: null };
    sessions.set(sessionId, s); return s;
  }
  const ownsTab = (s, owner, tab) => s?.tabs.get(tab)?.extensionOwner === agent(owner);
  function refreshOwner(s, owner) {
    const owned = [...s.tabs].filter(([, t]) => t.extensionOwner === agent(owner));
    if (!owned.length) { s._tabOwners.delete(owner); s._loopOwned.delete(owner); s._interactiveOwned.delete(owner); }
    else if (!ownsTab(s, owner, s._tabOwners.get(owner))) s._tabOwners.set(owner, owned.at(-1)[0]);
  }
  function sync(state) {
    for (const s of sessions.values()) {
      if (s._profileMode !== 'extension') continue;
      for (const [key, t] of s.tabs) {
        const live = state.tabs.find(v => v.handle === key);
        if (!live || live.owner !== t.extensionOwner) {
          s.tabs.delete(key);
          for (const owner of s._tabOwners.keys()) refreshOwner(s, owner);
        } else { t.url = agentUrl(live.url, state); t.title = t.url ? live.title || '' : ''; }
      }
      if (!s.tabs.has(s.activeTabId)) { s.activeTabId = s.tabs.keys().next().value || null; s.page = s.tabs.get(s.activeTabId)?.page || null; }
    }
  }
  // `adopt`: the handle of one of the owner's open tabs to take over (browser_session list shows them in full
  // control; in restricted mode a shared tab). Without it: full control opens a new tab of the agent's own (it never
  // takes one of the owner's by itself); restricted mode takes the first shared tab, else opens one.
  async function acquire(owner, ownerType = 'interactive', { adopt } = {}) {
    return serialized(async () => {
      if (!bridge.status().connected) fail('EXTENSION_NOT_CONNECTED');
      if (adopt !== undefined && adopt !== null) handle(adopt);
      const s = session(), opaque = agent(owner);
      if (adopt && ownsTab(s, owner, adopt)) return { browserSessionId: s.id, browserTabId: adopt, url: s.tabs.get(adopt)?.url || '', reused: true };
      let target = null;
      if (adopt) {
        // A refused take-over leaves every tab the agent already holds alone.
        target = bridge.status().tabs.find(t => t.handle === adopt);
        if (!target) fail('TAB_CLOSED');
        if (target.owner && target.owner !== opaque) fail('NOT_OWNED');
        bridge.authorize('claim', adopt, opaque, {});
      }
      // _tabOwners is only the default route. Every entry retains its exclusive owner until explicit release.
      const status = bridge.status();
      const shared = target || (status.fullControl ? null : status.tabs.find(t => t.owner === null && !t.created));
      const result = await bridge.request(shared ? 'claim' : 'create', shared?.handle || null, opaque);
      // What the browser said when it refused (protocol.js errorDetail) stays with the code, to the agent and the log.
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code, detail: errorDetail(result) });
      const tab = result.tab;
      const now = bridge.status(), reading = now.tabs.find(t => t.handle === tab && t.owner === opaque);
      if (!reading) fail('TAB_NOT_APPROVED');
      // A shared tab may have left its approved site before an agent took it over: the agent sees no URL of it.
      const entry = { url: agentUrl(reading.url, now), title: agentUrl(reading.url, now) ? reading.title || '' : '', extensionOwner: opaque, created: reading.created };
      entry.page = { url: () => entry.url, title: async () => entry.title, isClosed: () => !s.tabs.has(tab) };
      s.tabs.set(tab, entry); s._tabOwners.set(owner, tab);
      (ownerType === 'loop' ? s._loopOwned : s._interactiveOwned).add(owner);
      if (!s.activeTabId) { s.activeTabId = tab; s.page = entry.page; }
      return { browserSessionId: s.id, browserTabId: tab, url: entry.url };
    });
  }
  // Full control: eligible tabs with optional ownership labels for the session listing. Never a browser page or SynaBun's own. Null when the mode is restricted or nothing is connected.
  function ownerTabs({ caller: requestingOwner, includeOwned = false } = {}) {
    const status = bridge.status();
    if (!status.connected || !status.fullControl) return null;
    return status.tabs.filter(t => (includeOwned || !t.owner) && bridge.openable(t.url)).map(t => ({ id: t.handle, url: listedUrl(t.url), title: t.title || '',
      ...(includeOwned ? { owner: !t.owner ? null : t.owner === agent(requestingOwner) ? 'you' : `agent-${t.owner.slice(0, 12)}` } : {}) }));
  }
  async function release(id, owner, onlyTab) {
    const s = sessions.get(id); if (!s || s._profileMode !== 'extension') return;
    if (onlyTab && !ownsTab(s, owner, onlyTab)) fail(s.tabs.has(onlyTab) ? 'NOT_OWNED' : 'TAB_CLOSED');
    const owned = [...s.tabs].filter(([tab, t]) => t.extensionOwner === agent(owner) && (!onlyTab || tab === onlyTab));
    for (const [tab] of owned) {
      // Keep ownership on a failed/disconnected release, so a reconnect accounts for every tab.
      const result = await bridge.request('release', tab, agent(owner));
      if (!result.ok && result.code !== 'TAB_CLOSED') throw Object.assign(new Error(result.error), { code: result.code });
      s.tabs.delete(tab);
    }
    refreshOwner(s, owner);
    sync(bridge.status());
  }
  async function destroy(id) {
    const s = sessions.get(id); if (!s) return;
    for (const owner of [...s._tabOwners.keys()]) await release(id, owner);
    sessions.delete(id); if (sessionId === id) sessionId = null;
  }
  function uploadFiles(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 4 ||
        paths.some(path => typeof path !== 'string' || !isAbsolute(path))) fail('INVALID_MESSAGE');
    let remaining = MAX_FILE;
    return {
      names: paths.map(path => basename(path)),
      read(index) {
        try {
          const file = readConfinedFileWithMetadata(uploadRoot, resolve(paths[index]), { maxBytes: remaining });
          remaining -= file.bytes.length;
          return { ...file, type: uploadMimeType(paths[index]) };
        } catch (error) {
          if (error.status === 404) fail('UPLOAD_FILE_MISSING');
          if (error.status === 413) fail('UPLOAD_TOO_LARGE');
          fail('UPLOAD_FILE_REFUSED');
        }
      },
    };
  }
  // Page JavaScript (extension 1.4.0 and later): the script of the Playwright route's body, as one expression, through
  // chrome.userScripts.execute in the agent's own tab. The answer has that route's shape: { ok, result } with the
  // script's value, or { ok: false, error }. Before anything is sent: the bridge's own rules for the tab (and its
  // version gate), then the publish gate; a paced write then waits its gap and runs only if the agent still holds the tab.
  async function evaluate(s, owner, tab, body, req) {
    const script = body.script;
    if (typeof script !== 'string' || !script.trim()) return { ok: false, error: 'script required' };
    if (script.length > EVALUATE_SCRIPT_MAX) return { ok: false, error: `script exceeds ${EVALUATE_SCRIPT_MAX} characters` };
    const args = { expression: script };
    const timeout = milliseconds(body.timeout, EVALUATE_TIMEOUT_MAX), maxChars = milliseconds(body.maxChars, 1000000);
    if (timeout) args.timeout = timeout;
    if (maxChars) args.maxChars = maxChars;
    if (body.world !== undefined && body.world !== null) { if (!EVALUATE_WORLDS.includes(body.world)) return { ok: false, error: `Invalid world. Use: ${EVALUATE_WORLDS.join(', ')}` }; args.world = body.world; }
    if (body.frame !== undefined && body.frame !== null) { if (!Number.isSafeInteger(Number(body.frame)) || Number(body.frame) < 0) return { ok: false, error: 'Invalid frame id' }; args.frame = Number(body.frame); }
    bridge.authorize('evaluate', tab, agent(owner), args);
    const refusal = evaluateGate?.refusal?.({ session: s, req, tabId: tab, script }) || null;
    if (refusal) return { ok: false, ...refusal };
    let cut = null;
    const execute = async () => {
      // A paced write may have waited a minute: it runs only in the tab this request named, if the agent still holds it.
      if (sessions.get(s.id) !== s || !ownsTab(s, owner, tab)) throw Object.assign(new Error('TAB_CLOSED'), { code: 'TAB_CLOSED', writeStarted: false });
      let result;
      try { result = finish(s, tab, await bridge.request('evaluate', tab, agent(owner), args)); }
      catch (error) { if (NOTHING_RAN.includes(error?.code)) error.writeStarted = false; throw error; }
      if (result.ok) {
        // `value` is the JSON text of what the script returned. One that was cut is the beginning of that text (not
        // valid JSON): it is answered as that text, flagged.
        if (result.truncated) { cut = { truncated: true, valueLength: result.valueLength }; return result.value; }
        try { return JSON.parse(result.value); } catch { fail('OPERATION_FAILED'); }
      }
      let answer = worded(result);
      if (result.code === 'PAGE_ERROR') {
        // What the page's script threw, in the words of a Playwright failure. No stack: the script did not compile.
        const message = result.errorMessage || 'The script threw.';
        answer = { ok: false, code: 'PAGE_ERROR', error: `page.evaluate: ${message}${result.errorStack ? '' : ' browser_evaluate takes one JavaScript expression: wrap statements in a function, (() => { …; return value; })().'}`,
          ...(result.errorStack ? { errorStack: result.errorStack } : {}) };
      }
      throw Object.assign(new Error(result.code || 'OPERATION_FAILED'), { answer, ...(NOTHING_RAN.includes(result.code) ? { writeStarted: false } : {}) });
    };
    let outcome;
    try { outcome = evaluateGate?.run ? await evaluateGate.run({ session: s, req, execute }) : { result: await execute() }; }
    catch (error) { if (error?.answer) return error.answer; throw error; }
    if (outcome.paced?.pending) return { ok: true, paced: outcome.paced };
    return { ok: true, result: outcome.result === undefined ? null : outcome.result, ...(cut || {}), ...(outcome.paced ? { paced: outcome.paced } : {}) };
  }
  // ── The extension's fixed readers (1.5.0): protocol.js READER_IDS, run by id, never a script ──
  const readsReaders = () => compareVersions(bridge.status().extensionVersion, READS_SINCE) >= 0;
  const coded = result => Object.assign(new Error(result?.code || 'OPERATION_FAILED'), { code: result?.code || 'OPERATION_FAILED', detail: errorDetail(result), answer: worded(result) });
  async function read(s, owner, tab, args) {
    const result = finish(s, tab, await bridge.request('read', tab, agent(owner), args));
    if (!result.ok) throw coded(result);
    return result;
  }
  // A reader's JSON answer (what an extractor returned), parsed; one cut for length is a refusal, never half an answer.
  function valueOf(result) {
    if (result.truncated) throw Object.assign(new Error('READER_FAILED'), { code: 'READER_FAILED', answer: { ok: false, code: 'READER_FAILED', error: `READER_FAILED: what the page shows is larger than one answer (${result.valueLength} characters of JSON). Read fewer items, or narrow the page first.` } });
    try { return JSON.parse(result.value); } catch { fail('OPERATION_FAILED'); }
  }
  // browser_content format "text" (GET /content): the page's innerText, paged as the Playwright route pages it.
  async function contentText(s, owner, tab, body) {
    if (!readsReaders()) {
      // An extension from before the readers: its own content command, as it always answered.
      const args = {};
      for (const k of ['selector', 'maxChars', 'offset']) if (body[k] !== undefined && body[k] !== null && body[k] !== '') args[k] = k === 'selector' ? String(body[k]) : Number(body[k]);
      return finish(s, tab, await bridge.request('content', tab, agent(owner), args));
    }
    const selector = typeof body.selector === 'string' && body.selector ? body.selector : undefined;
    let result;
    try { result = await read(s, owner, tab, { reader: 'page.text', ...(selector ? { selector } : {}) }); }
    catch (error) { if (['NO_MATCH', 'AMBIGUOUS_TARGET', 'INVALID_SELECTOR'].includes(error.code)) return { ok: false, code: error.code, error: SELECTOR_ONE }; throw error; }
    const page = pageOf(result.text || '', body, TEXT_PAGE_DEFAULT, '\n');
    return { ok: true, url: result.url, title: result.title ?? '', text: page.text, totalChars: page.totalChars, ...(selector ? { selector } : {}),
      ...(result.truncated ? { sourceTruncated: true, sourceChars: result.valueLength } : {}) };
  }
  // browser_content format "markdown" (GET /markdown): the page's main content as HTML, read by the same page function
  // the Playwright route runs (lib/browser-extraction.js contentHtmlOf, shipped as the reader 'page.html'), turned into
  // Markdown by the same converter, paged the same way.
  async function contentMarkdown(s, owner, tab, body) {
    if (!readsReaders()) fail('EXTENSION_RELOAD_REQUIRED');
    if (typeof htmlToMarkdown !== 'function') throw unsupported('Markdown is unavailable in this server build.');
    const selector = typeof body.selector === 'string' && body.selector ? body.selector : undefined;
    let result;
    try { result = await read(s, owner, tab, { reader: 'page.html', ...(selector ? { selector } : {}) }); }
    catch (error) { if (['NO_MATCH', 'AMBIGUOUS_TARGET', 'INVALID_SELECTOR'].includes(error.code)) return { ok: false, code: error.code, error: SELECTOR_ONE }; throw error; }
    const html = result.text || '';
    if (!html) return { ok: true, url: result.url, title: result.title ?? '', markdown: '', tokens: 0 };
    const markdown = htmlToMarkdown(html);
    const page = pageOf(markdown, body, MARKDOWN_PAGE_DEFAULT, '\n\n');
    return { ok: true, url: result.url, title: result.title ?? '', markdown: page.text, tokens: Math.ceil(page.totalChars / 4), totalChars: page.totalChars, ...(selector ? { selector } : {}),
      ...(result.truncated ? { sourceTruncated: true, sourceChars: result.valueLength } : {}) };
  }
  // The paged extraction (POST /extract), as lib/browser-extraction.js runBrowserExtraction runs it on a Playwright
  // page: read, merge and dedupe, scroll, wait until the feed shows something new (or its loading marker ends), read
  // again; the same options, limits, stop reasons and answer. Here the reads and the scroll are the extractor's fixed
  // reader (`body.extractor`, one of protocol.js PAGED_READERS); the `script` and `scrollTarget` the request also
  // carries are for the Playwright backend and are never sent anywhere.
  async function extract(s, owner, tab, body, req) {
    const id = body.extractor;
    if (typeof id !== 'string' || !PAGED_READERS.includes(id)) {
      return { ok: false, actionStarted: false, code: 'UNSUPPORTED_IN_EXTENSION_MODE',
        error: `UNSUPPORTED_IN_EXTENSION_MODE: the extension backend runs only its own fixed extractors, named by id (${PAGED_READERS.join(', ')}); this request names ${typeof id === 'string' ? JSON.stringify(id.slice(0, 64)) : 'none'}. No script was run.` };
    }
    const opts = {};
    for (const name of ['scrolls', 'minItems', 'maxItems', 'maxChars', 'timeoutMs', 'settleMs', 'scrollDistance']) {
      if (body[name] === undefined || body[name] === null) continue;
      const v = body[name];
      if (!Number.isInteger(v) || v < (name === 'scrolls' ? 0 : name === 'maxChars' ? 2 : 1)) return { ok: false, actionStarted: false, error: `${name} must be a ${name === 'scrolls' ? 'nonnegative' : 'positive'} integer` };
      opts[name] = v;
    }
    for (const name of ['fields', 'dedupeKeys']) {
      if (body[name] === undefined) continue;
      if (!Array.isArray(body[name]) || body[name].some(key => typeof key !== 'string' || !key)) return { ok: false, actionStarted: false, error: `${name} must be an array of nonempty strings` };
      opts[name] = body[name];
    }
    opts.scrollDirection = body.scrollDirection === -1 ? -1 : 1;
    opts.scrollIfEmpty = body.scrollIfEmpty === true;
    if (!readsReaders()) fail('EXTENSION_RELOAD_REQUIRED');
    bridge.authorize('read', tab, agent(owner), { reader: id });
    const scrolls = Math.min(Math.max(Math.trunc(opts.scrolls ?? 0), 0), 10), maxItems = Math.max(1, Math.trunc(opts.maxItems || 50));
    const dedupeKeys = opts.dedupeKeys || [], timeoutMs = Math.min(Math.max(opts.timeoutMs || EXTRACTION_TIMEOUT_MS, 1), 30000);
    const deadline = Math.min(now() + timeoutMs, Number.isFinite(req?.browserRequest?.deadline) ? req.browserRequest.deadline : Infinity);
    const signal = req?.browserRequest?.signal;
    const keyOf = item => { for (const key of dedupeKeys) if (item[key] !== null && item[key] !== undefined && item[key] !== '') return `${key}:${item[key]}`; return JSON.stringify(item); };
    const stop = (message, code) => Object.assign(new Error(message), { code, stopCode: code });
    const active = () => {
      if (signal?.aborted) throw stop('Extraction cancelled; collected items are preserved.', 'cancelled');
      if (now() >= deadline) throw stop('Extraction deadline reached; collected items are preserved.', 'deadline');
    };
    const readOnce = async () => {
      active();
      const result = await read(s, owner, tab, { reader: id });
      const items = valueOf(result);
      if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('Extractor must return an array of objects.');
      return { items, loading: result.loading === true };
    };
    const collected = new Map();
    let raw = 0, scrollsUsed = 0, stopReason = 'scroll_limit', failureReason, dryRounds = 0, bonusRounds = 0;
    const merge = items => { raw += items.length; const before = collected.size; for (const item of items) collected.set(keyOf(item), item); return collected.size - before; };
    try {
      let { items } = await readOnce();
      for (let round = 0; ; round++) {
        active();
        const added = merge(items);
        const budget = budgetExtractionItems([...collected.values()], opts);
        if (budget.budgetReason) { stopReason = budget.budgetReason; break; }
        if (collected.size >= maxItems) { stopReason = 'max_items'; break; }
        if (opts.minItems && collected.size >= opts.minItems) { stopReason = 'min_items'; break; }
        if (opts.scrollIfEmpty && round === 0 && collected.size === 0) bonusRounds = 1;
        dryRounds = added ? 0 : dryRounds + 1;
        if (dryRounds >= 2) { stopReason = 'end_of_feed'; break; }
        if (round >= scrolls + bonusRounds) break;
        active();
        const distance = (opts.scrollDistance ?? 1200) * opts.scrollDirection;
        const scrolled = await read(s, owner, tab, { reader: id, step: 'scroll', distance: Math.min(100000, Math.abs(distance)), direction: distance < 0 ? 'up' : 'down' });
        let loadingBefore = scrolled.loading === true;
        scrollsUsed++;
        // Wait, within settleMs, for the feed to show an item not seen yet (or for its loading marker to end).
        const until = Math.min(now() + Math.min(opts.settleMs ?? 3000, Math.max(1, deadline - now())), deadline);
        let next = null;
        for (;;) {
          await sleep(Math.max(1, Math.min(150, until - now())));
          const seen = await readOnce();
          loadingBefore ||= seen.loading;
          const fresh = seen.items.some(item => !collected.has(keyOf(item)));
          if (!seen.loading && (fresh || loadingBefore)) { next = seen.items; break; }
          if (now() >= until) {
            if (seen.loading) throw stop('Feed is still loading after the readiness deadline; collected items are preserved.', 'readiness_timeout');
            next = seen.items; break;
          }
        }
        items = next;
      }
    } catch (error) {
      if (error?.code === 'NOT_OWNED' || error?.code === 'TAB_CLOSED' && !collected.size) throw error;
      stopReason = ['deadline', 'cancelled', 'readiness_timeout'].includes(error?.stopCode) ? error.stopCode : 'extraction_error';
      failureReason = error?.answer?.error || (error?.code && !error.stopCode ? safeError(error).error : error?.message) || 'Extraction failed.';
    }
    const budget = budgetExtractionItems([...collected.values()], opts);
    const outcome = { ...budget, raw, scrollsUsed, stopReason: budget.budgetReason || stopReason, partial: !!failureReason && collected.size > 0,
      ...(failureReason ? { failureReason, ...(collected.size === 0 ? { error: failureReason } : {}) } : {}) };
    return { ok: !outcome.error, url: s.tabs.get(tab)?.url || '', ...outcome };
  }
  // A read-only script the MCP tools tagged with the id of the extension's fixed reader that does the same
  // (`body.extractor`; mcp-server/src/tools/browser-readers.ts): that reader runs, and the script never does. An id the
  // extension does not have is refused (never "run the script instead"). Only an extension from before the readers
  // gets the script, as browser_evaluate, exactly as before (Allow User Scripts and the publish gate apply).
  async function evaluateReader(s, owner, tab, body) {
    const id = body.extractor;
    if (typeof id !== 'string' || !READER_IDS.includes(id) || PAGED_READERS.includes(id) || ['page.text', 'page.html'].includes(id)) {
      return { ok: false, code: 'INVALID_MESSAGE', error: `INVALID_MESSAGE: ${typeof id === 'string' ? JSON.stringify(id.slice(0, 64)) : 'This value'} is not one of the extension's one-shot readers. Nothing was run.` };
    }
    try { return { ok: true, result: valueOf(await read(s, owner, tab, { reader: id })) }; }
    catch (error) { if (error?.answer) return error.answer; throw error; }
  }
  async function operation(s, owner, tab, action, body = {}, req = null) {
    if (!bridge.status().connected) fail('EXTENSION_NOT_CONNECTED');
    if (!s || !tab || !s.tabs.has(tab)) fail('TAB_CLOSED');
    if (!ownsTab(s, owner, tab)) fail('NOT_OWNED');
    const op = aliases[action] || action;
    if (!supported.has(op)) throw unsupported('This operation is not supported by the extension backend. No debugger is attached; page JavaScript runs through browser_evaluate only.');
    if (op === 'evaluate' && body.extractor !== undefined && body.extractor !== null && readsReaders()) return evaluateReader(s, owner, tab, body);
    if (op === 'evaluate') return evaluate(s, owner, tab, body, req);
    if (op === 'content') return contentText(s, owner, tab, body);
    if (op === 'markdown') return contentMarkdown(s, owner, tab, body);
    if (op === 'extract') return extract(s, owner, tab, body, req);
    let shot;
    if (op === 'screenshot') {
      shot = parseScreenshotOptions(body);
      if (shot.fullPage || shot.width || shot.height || ['selector', 'ref', 'clip', 'region'].some(k => body[k])) throw unsupported('Only the visible viewport can be captured: the extension has no debugger for viewport emulation, element crops or full-page capture. Use maxWidth to downscale the captured image.');
      if (shot.path && screenshotPathRefusal(shot.path, { dataHome })) fail('SCREENSHOT_PATH_REFUSED');
    }
    if (op === 'wait' && body.loadState) {
      // A load-state wait (extension 1.4.0 and later): 'load' and 'networkidle', and from 1.5.0 'domcontentloaded' (the
      // document's readyState, read by a fixed function), for the tab, not for an element (as in the Playwright route,
      // a selector sent with it is not used). None of them needs "Allow User Scripts".
      if (!LOAD_STATES.includes(body.loadState)) return { ok: false, error: 'Invalid loadState. Use: load, domcontentloaded, networkidle' };
      const timeout = milliseconds(body.timeout, NETWORK_IDLE_TIMEOUT_MAX);
      return worded(finish(s, tab, await bridge.request('wait', tab, agent(owner), { loadState: body.loadState, ...(timeout ? { timeout } : {}) })));
    }
    if (op === 'snapshot' && body.mode && body.mode !== 'ai') throw unsupported('Extension snapshots support mode="ai" (DOM refs) only.');
    if (HISTORY.includes(op)) {
      // Back and forward take no arguments on the wire; the server and the extension check the landing page.
      bridge.authorize(op, tab, agent(owner), {});
      try { return finish(s, tab, await bridge.request(op, tab, agent(owner), {})); }
      catch (error) { if (error?.code === 'SITE_NOT_APPROVED') error.reason = HISTORY_DESTINATION; throw error; }
    }
    const args = {};
    for (const k of argumentKeys) if (body[k] !== undefined && body[k] !== null) args[k] = ['nthMatch', 'distance', 'maxChars', 'offset', 'timeout'].includes(k) ? Number(body[k]) : body[k];
    if (op === 'snapshot') {
      // An extension with the readers pages its snapshot (offset, default 0) and says how long it is; an older one
      // never gets an offset (it would not know what to answer with).
      if (readsReaders()) args.offset = Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 0; else delete args.offset;
      const result = finish(s, tab, await bridge.request('snapshot', tab, agent(owner), args));
      if (!result.ok || result.snapshotTotal === undefined) return result;
      const { snapshotTotal, snapshotNext, ...rest } = result, more = snapshotNext < snapshotTotal;
      return { ...rest, snapshotBudgetApplied: true, snapshotOffset: args.offset, snapshotTotalChars: snapshotTotal, ...(more ? { snapshotTruncated: true, snapshotNextOffset: snapshotNext } : {}) };
    }
    let upload;
    if (op === 'upload') {
      bridge.authorize(op, tab, agent(owner), args);
      upload = uploadFiles(body.filePaths);
      args.files = upload.names;
    }
    const result = finish(s, tab, await bridge.request(op, tab, agent(owner), args, upload));
    if (op === 'upload' && result.ok && !result.files) {
      // A still-loaded 1.3.0 extension may already have dispatched events. Do not replay it.
      return { ok: false, error: 'The extension returned no file details. Check the page before retrying and reload SynaBun Browser Bridge.' };
    }
    if (op === 'wait' && result.ok) result.state = body.state || 'visible';
    if (op === 'screenshot' && result.ok) {
      const raw = Buffer.from(result.base64, 'base64'), meta = await sharp(raw).metadata();
      const format = (body.format || shot.path) ? shot.inlineFormat : 'png';
      const imageWidth = Math.max(1, Math.min(meta.width, shot.maxWidth || meta.width, 8192));
      const image = sharp(raw).resize({ width: imageWidth, withoutEnlargement: true });
      const data = await (format === 'jpeg' ? image.jpeg({ quality: shot.quality }) : image.png()).toBuffer();
      let savedPath;
      if (shot.save) {
        const file = sharp(raw);
        const bytes = await (shot.fileFormat === 'jpeg' ? file.jpeg({ quality: shot.fileQuality }) : file.png()).toBuffer();
        const target = shot.path || defaultScreenshotPath({ dataHome, pageUrl: s.tabs.get(tab)?.url, width: meta.width, height: meta.height, format: shot.fileFormat });
        savedPath = writeScreenshotFile(target, bytes, { dataHome });
      }
      return { ok: true, data: data.toString('base64'), mime: `image/${format}`, url: s.tabs.get(tab)?.url || '', title: s.tabs.get(tab)?.title || '',
        width: meta.width, height: meta.height, imageWidth, imageHeight: Math.round(meta.height * imageWidth / meta.width), fullPage: false, ...(savedPath ? { savedPath } : {}) };
    }
    return result;
  }
  // Every URL an operation answers with passes the same filter as the session view; a page off the approved sites
  // gives neither its URL nor its title.
  function finish(s, tab, result) {
    if (result.ok && typeof result.url === 'string') {
      const shown = agentUrl(result.url, bridge.status());
      if (shown !== result.url) { result = { ...result, url: shown }; delete result.title; }
      if (s.tabs.has(tab)) { s.tabs.get(tab).url = shown; if (typeof result.title === 'string') s.tabs.get(tab).title = shown ? result.title : ''; }
    }
    return result;
  }
  async function describeError(error) {
    const body = safeError(error);
    if (body.code === 'EXTENSION_NOT_CONNECTED' || body.code === 'NOT_CONNECTED') {
      // The handshake carries no paired browser/profile identity. Only the connection can be checked live. An unpaired
      // or paused bridge is fixed in SynaBun, not from the extension's popup (which a paused bridge refuses): the advice
      // says so (review round 3, I7b).
      const status = bridge.status();
      const advice = status.connected ? 'The extension has reconnected. Retry the browser tool.'
        : status.paired === false ? 'The SynaBun browser extension is not paired. Pair it in SynaBun Settings → Browser (Start pairing), then retry the browser tool.'
        : status.paused === true ? 'The browser extension bridge is paused: it was disconnected in SynaBun Settings → Browser. Resume it there (Reconnect), then retry the browser tool.'
        : connectionAdvice();
      body.error = `${body.code}: ${advice}`;
    }
    return body;
  }
  async function denied(res, error) {
    const body = await describeError(error);
    if (body.code === 'UNSUPPORTED_IN_EXTENSION_MODE') body.error = `${body.code}: ${error.message}`;
    else if (body.code === 'SITE_NOT_APPROVED' && typeof error.reason === 'string') body.error = `${body.code}: ${error.reason}`;
    return res.status(body.code === 'TAB_CLOSED' ? 410 : body.code === 'EXTENSION_NOT_CONNECTED' || body.code === 'NOT_CONNECTED' ? 503 : 403).json(body);
  }
  async function middleware(req, res, next) {
    const match = req.path.match(/^\/sessions\/([A-Za-z0-9_-]+)(?:\/(.*))?$/);
    const s = match && sessions.get(match[1]);
    const relevant = s?._profileMode === 'extension' || selected(req) && (req.path === '/acquire' || req.path === '/release' || req.path === '/sessions' && req.method === 'POST' || match && !s);
    if (!relevant) return next();
    try {
      const who = caller(req);
      if (who.automation && (!who.id || who.status !== 'verified')) fail('AUTH_FAILED');
      if (!who.automation && !ownerPage(req)) fail('AUTH_FAILED');
      const owner = who.id || 'owner-page';
      if (req.method === 'POST' && ['/sessions', '/acquire'].includes(req.path)) {
        if (who.automation && ownerOnlyCreateFields(req.body).length) fail('PERMISSION_REQUIRED');
        const adopt = req.body?.takeOverTab;
        if (adopt !== undefined && adopt !== null && typeof adopt !== 'string') fail('INVALID_MESSAGE');
        const acq = await acquire(owner, 'interactive', { adopt: adopt || undefined });
        const created = sessions.get(acq.browserSessionId);
        if (req.body?.url && req.body.url !== 'about:blank') {
          // A create whose URL does not open leaves nothing behind: the tab it opened is closed (a tab it took over goes
          // back to the owner, open), and the answer says so. A tab the agent already held is left as it was.
          let nav, failure = null;
          try { nav = await operation(created, owner, acq.browserTabId, 'navigate', { url: req.body.url }); } catch (error) { failure = error; }
          if (failure || !nav?.ok) {
            const body = failure ? await describeError(failure) : { ...safeError(nav), ...(typeof nav?.error === 'string' ? { error: nav.error } : {}) };
            let released = false;
            if (!acq.reused) { try { await release(acq.browserSessionId, owner, acq.browserTabId); released = true; } catch {} }
            const closing = acq.reused ? 'Your tab stays as it was.' : released ? (adopt ? 'The taken-over tab went back to the owner, open; you hold no tab from this create.' : 'The tab this create opened was closed; nothing was left open.') : 'The tab this create opened could not be closed (the extension did not answer); it stays yours: close it with browser_session close.';
            try { log({ command: 'create', tab: null, code: body.code, ...(errorDetail(body) ? { detail: errorDetail(body) } : {}) }); } catch {}
            return res.status(body.code === 'EXTENSION_NOT_CONNECTED' || body.code === 'NOT_CONNECTED' ? 503 : 403)
              .json({ ...body, error: `${body.error} ${closing}`, tabReleased: released, ...(acq.reused || !released ? { sessionId: acq.browserSessionId, tabId: acq.browserTabId } : {}) });
          }
        }
        return res.json({ ok: true, sessionId: acq.browserSessionId, tabId: acq.browserTabId, profileMode: 'extension', url: created.tabs.get(acq.browserTabId)?.url, wsEndpoint: null, shared: true, ...(adopt ? { tookOver: true } : {}) });
      }
      if (req.path === '/release' && req.method === 'POST') {
        if (req.body?.clientId !== owner) fail('NOT_OWNED');
        for (const s of sessions.values()) if (s._profileMode === 'extension') await release(s.id, owner);
        return res.json({ ok: true });
      }
      if (!s) fail('TAB_CLOSED');
      if (req.method === 'DELETE' && !match[2]) {
        if (who.automation && !s._tabOwners.has(owner)) fail('NOT_OWNED');
        const onlyTab = req.query?.tabId;
        const releasedTabIds = [...s.tabs.keys()].filter(tab => (!onlyTab || tab === onlyTab) && (!who.automation || ownsTab(s, owner, tab)));
        if (who.automation || onlyTab) await release(s.id, owner, onlyTab); else await destroy(s.id);
        return res.json({ ok: true, profileMode: 'extension', sessionKept: sessions.has(s.id), releasedTabIds,
          ...(onlyTab ? { releasedTabId: onlyTab } : {}) });
      }
      const body = { ...req.query, ...req.body };
      const tab = body.tabId || s._tabOwners.get(owner);
      if (!['GET', 'POST'].includes(req.method)) throw unsupported('Tab management is through the extension popup.');
      // Every extension session endpoint is intercepted, including CDP, raw screenshot and UI routes.
      const result = await operation(s, owner, tab, match[2], body, req);
      // 409: the publish gate's refusal, as the Playwright routes answer it.
      return res.status(result.ok ? 200 : result.code === 'TAB_CLOSED' ? 410 : result.quoteGuard ? 409 : 400).json(result);
    } catch (error) {
      const command = supported.has(match?.[2]) ? match[2] : req.method === 'POST' && ['/sessions', '/acquire'].includes(req.path) ? 'create' : 'session', said = safeError(error);
      try { log({ command, tab: null, code: said.code, ...(errorDetail(said) ? { detail: errorDetail(said) } : {}) }); } catch {}
      return denied(res, error);
    }
  }
  return { acquire, describeError, release, destroy, sync, operation, middleware, agent, session, ownerTabs, ownsTab };
}
