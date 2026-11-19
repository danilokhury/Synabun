import { createHash, randomBytes } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { readConfinedFile } from './confined-fs.js';
import { fileURLToPath } from 'node:url';
import { fail, handle, HISTORY, MAX_FILE, safeError } from '../../browser-extension/protocol.js';
import sharp from 'sharp';
import { parseScreenshotOptions, screenshotPathRefusal, defaultScreenshotPath, writeScreenshotFile } from './browser-screenshot.js';
import { ownerOnlyCreateFields } from './browser-automation-routes.js';

export const EXTENSION_FOLDER = fileURLToPath(new URL('../../browser-extension/', import.meta.url));
const aliases = { 'screenshot-base64': 'screenshot' };
const supported = new Set(['navigate', 'back', 'forward', 'reload', 'snapshot', 'click', 'hover', 'fill', 'type', 'press', 'select', 'scroll', 'wait', 'content', 'screenshot', 'upload']);
const argumentKeys = ['url', 'ref', 'selector', 'nthMatch', 'value', 'text', 'key', 'direction', 'distance', 'maxChars', 'offset', 'timeout', 'state'];
const unsupported = reason => Object.assign(new Error(reason), { code: 'UNSUPPORTED_IN_EXTENSION_MODE' });
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
export function createExtensionAdapter({ bridge, sessions, uploadRoot, caller, ownerPage, selected, dataHome, log = () => {} }) {
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
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
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
          const bytes = readConfinedFile(uploadRoot, resolve(paths[index]), { maxBytes: remaining });
          remaining -= bytes.length;
          return bytes;
        } catch (error) {
          if (error.status === 404) fail('UPLOAD_FILE_MISSING');
          if (error.status === 413) fail('UPLOAD_TOO_LARGE');
          fail('UPLOAD_FILE_REFUSED');
        }
      },
    };
  }
  async function operation(s, owner, tab, action, body = {}) {
    if (!bridge.status().connected) fail('EXTENSION_NOT_CONNECTED');
    if (!s || !tab || !s.tabs.has(tab)) fail('TAB_CLOSED');
    if (!ownsTab(s, owner, tab)) fail('NOT_OWNED');
    const op = aliases[action] || action;
    if (!supported.has(op)) throw unsupported('This operation is not supported by the extension backend. No debugger or arbitrary JavaScript is enabled.');
    let shot;
    if (op === 'screenshot') {
      shot = parseScreenshotOptions(body);
      if (shot.fullPage || shot.width || shot.height || ['selector', 'ref', 'clip', 'region'].some(k => body[k])) throw unsupported('Only the visible viewport can be captured: the extension has no debugger for viewport emulation, element crops or full-page capture. Use maxWidth to downscale the captured image.');
      if (shot.path && screenshotPathRefusal(shot.path, { dataHome })) fail('SCREENSHOT_PATH_REFUSED');
    }
    if (op === 'wait' && body.loadState) throw unsupported('Extension waits support selectors and fixed delays, not browser network/load states.');
    if (op === 'snapshot' && body.mode && body.mode !== 'ai') throw unsupported('Extension snapshots support mode="ai" (DOM refs) only.');
    if (HISTORY.includes(op)) {
      // Back and forward take no arguments on the wire; the server and the extension check the landing page.
      bridge.authorize(op, tab, agent(owner), {});
      try { return finish(s, tab, await bridge.request(op, tab, agent(owner), {})); }
      catch (error) { if (error?.code === 'SITE_NOT_APPROVED') error.reason = HISTORY_DESTINATION; throw error; }
    }
    const args = {};
    for (const k of argumentKeys) if (body[k] !== undefined && body[k] !== null) args[k] = ['nthMatch', 'distance', 'maxChars', 'offset', 'timeout'].includes(k) ? Number(body[k]) : body[k];
    let upload;
    if (op === 'upload') {
      bridge.authorize(op, tab, agent(owner), args);
      upload = uploadFiles(body.filePaths);
      args.files = upload.names;
    }
    const result = finish(s, tab, await bridge.request(op, tab, agent(owner), args, upload));
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
  function denied(res, error) {
    const body = safeError(error);
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
            const body = failure ? safeError(failure) : { ...safeError(nav), ...(typeof nav?.error === 'string' ? { error: nav.error } : {}) };
            let released = false;
            if (!acq.reused) { try { await release(acq.browserSessionId, owner, acq.browserTabId); released = true; } catch {} }
            const closing = acq.reused ? 'Your tab stays as it was.' : released ? (adopt ? 'The taken-over tab went back to the owner, open; you hold no tab from this create.' : 'The tab this create opened was closed; nothing was left open.') : 'The tab this create opened could not be closed (the extension did not answer); it stays yours: close it with browser_session close.';
            try { log({ command: 'create', tab: null, code: body.code }); } catch {}
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
      const result = await operation(s, owner, tab, match[2], body);
      return res.status(result.ok ? 200 : result.code === 'TAB_CLOSED' ? 410 : 400).json(result);
    } catch (error) { try { log({ command: supported.has(match?.[2]) ? match[2] : 'session', tab: null, code: safeError(error).code }); } catch {} return denied(res, error); }
  }
  return { acquire, release, destroy, sync, operation, middleware, agent, session, ownerTabs, ownsTab };
}
