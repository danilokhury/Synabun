import { anyOrigin, command, CONTROL, controlSurface, ERROR_TEXT, EVALUATE_RESULT_MAX, fail, HISTORY, inventory, hostPattern, localDeadline, longBudget, MAX_FILE, MAX_TABS, NETWORK_IDLE_QUIET, nonce, publicOrigin, safeError } from './protocol.js';

// The script handed to chrome.userScripts.execute for `evaluate`: the agent's code inside a wrapper that awaits it,
// turns what it returns into JSON text (cut at `cap` characters) and reports what it throws, so the answer is always
// this envelope and never a live object of the page. The arguments are parsed here and written back as JSON, so the
// script holds nothing but that data and the agent's own code. No string is ever evaluated by the extension itself:
// the browser compiles the script in the page (or in the user-script world), where the owner allowed user scripts.
// An expression that evaluates to a function is called with the arguments (as Playwright does for a string); a body
// is the body of an async function whose parameter `args` is the array of arguments.
function pageScript(args, cap) {
  const list = JSON.stringify(args.params === undefined ? [] : JSON.parse(args.params));
  const call = args.body !== undefined
    ? `(async function (args) {\n${args.body}\n}).call(undefined, __synabunArgs)`
    : `(__synabunValue => typeof __synabunValue === 'function' ? __synabunValue.apply(undefined, __synabunArgs) : __synabunValue)((\n${args.expression.replace(/[\s;]+$/, '')}\n))`;
  return `(async () => { const __synabunArgs = ${list}; try { const __synabunResult = await ${call}; `
    + `let __synabunJson = JSON.stringify(__synabunResult); if (typeof __synabunJson !== 'string') __synabunJson = 'null'; `
    + `return { synabun: 1, ok: true, json: __synabunJson.length > ${cap} ? __synabunJson.slice(0, ${cap}) : __synabunJson, length: __synabunJson.length }; } `
    + `catch (__synabunError) { return { synabun: 1, ok: false, name: String(__synabunError && __synabunError.name || '').slice(0, 200), `
    + `message: String(__synabunError && __synabunError.message !== undefined ? __synabunError.message : __synabunError).slice(0, 2000), `
    + `stack: String(__synabunError && __synabunError.stack || '').slice(0, 6000) }; } })()`;
}
// The result's JSON text as it travels: at most `cap` characters, and few enough bytes for one bridge message.
const RESULT_BYTES = 2500000;
function clipped(text, cap) {
  let out = text.length > cap ? text.slice(0, cap) : text;
  for (let size = new TextEncoder().encode(out).length; size > RESULT_BYTES; size = new TextEncoder().encode(out).length) out = out.slice(0, Math.floor(out.length * RESULT_BYTES / size) - 1);
  return out;
}

/** Pure controller over an injected chrome API; no socket or storage credential access. */
// `now` is a monotonic clock (milliseconds) for command deadlines; `wallClock` the system clock the content script shares.
// `fullControlDefault` is the mode before the owner ever chose one (full control: agents may use any http(s) site and
// any tab of this browser with no sharing step). `activateMs` is how long a full-control screenshot lets a tab it
// brought to the front settle before capturing it. `idleMs` is how long a tab must have had no request in flight to be
// network-idle (a load-state wait).
export function createEngine(chrome, { readUpload, save = async () => {}, changed = () => {}, settleMs = 10000, quietMs = 500, pollMs = 50,
  now = () => performance.now(), wallClock = () => Date.now(), fullControlDefault = true, activateMs = 150, commitMs = 20000, visibleMs = 2000,
  idleMs = NETWORK_IDLE_QUIET } = {}) {
  // `epoch` moves only on the owner's revocations and pairing changes, and cancels every tab's work. A tab's own
  // navigation, update or close moves that tab's counter in `moves` (by Chrome tab id) and nothing else: one agent's
  // ordinary navigation never cancels another agent's work on another tab. `focus` moves when the active tab changes;
  // only a screenshot, which captures whatever tab is active, is held to it.
  let tabs = new Map(), sites = [], allowNewTabs = false, downloads = false, epoch = 0, focus = 0;
  // The mode and its version. Only the owner changes it: the popup (setMode) or the server's `mode` control message,
  // whose version must be newer. Switching to restricted is a revocation; switching to full control widens only.
  // In full control `tabs` also holds a record for every other tab of the browser (`listed`), so agents can see and
  // take over the owner's tabs; restricted mode keeps only shared and agent-created ones.
  let fullControl = fullControlDefault === true, modeVersion = 0;
  const clip = value => String(value || '').slice(0, 300);
  // The page a tab shows. Chrome reports `url` as '' until a tab's first navigation commits (a tab tabs.create just
  // opened, briefly): that tab shows its initial empty document, which is about:blank, and its pendingUrl is about:blank
  // (or nothing). A tab whose first page is still pending elsewhere is held to that pending URL (a browser page stays
  // RESTRICTED_PAGE, SynaBun's own stays blocked). Reading '' as a page made every command on a just-created tab fail
  // with RESTRICTED_PAGE before its first navigation committed.
  const shownUrl = tab => String(tab?.url || (!tab?.pendingUrl || tab.pendingUrl === 'about:blank' ? 'about:blank' : tab.pendingUrl));
  // Only approved tabs are counted, and a closed tab's counter goes (its commands then fail TAB_CLOSED).
  const moves = new Map(), moved = id => moves.get(id) || 0;
  const move = id => { if ([...tabs.values()].some(t => t.id === id)) moves.set(id, moved(id) + 1); };
  let lastCapture = 0;
  // Owner approval version per origin. Only share() raises it (the popup's owner gesture); nothing an agent asks for does.
  // Versions of sites no longer approved are kept (a re-share continues from them) up to RETIRED_VERSIONS, oldest
  // dropped first; a dropped one is harmless because share() never goes below the clock.
  let versions = new Map();
  const RETIRED_VERSIONS = 100;
  const pruneVersions = () => {
    const retired = [...versions].filter(([site]) => !sites.includes(site)).sort((a, b) => a[1] - b[1]);
    for (const [site] of retired.slice(0, Math.max(0, retired.length - RETIRED_VERSIONS))) versions.delete(site);
  };
  // Generations a command is held to. `approval` moves, synchronously, on every owner revocation (a tab, a site, an
  // option switched off, a host permission removed, pairing); `connection` when the connection a command came on ends.
  // A command records both when it arrives (ticket()) and is refused, before any further chrome.* or page effect, once
  // either has moved: a queued command never starts, a running one stops at its next effect boundary.
  let approval = 0, connection = 0;
  const ticket = () => Object.freeze({ approval, connection });
  // A caller may also stop a ticket it holds (`stopped`), e.g. the worker's queue giving up on a command that hangs.
  const valid = given => given.approval === approval && given.connection === connection && given.stopped !== true;
  // What the server is told: the tabs agents hold first, then the rest, up to MAX_TABS.
  const current = () => {
    const all = [...tabs.values()].filter(t => { if (t.owner || !fullControl) return true; try { anyOrigin(t.url); return true; } catch { return false; } }), listed = [...all.filter(t => t.owner), ...all.filter(t => !t.owner)].slice(0, MAX_TABS);
    return inventory({ tabs: listed.map(t => ({ handle: t.handle, url: t.url, owner: t.owner, created: t.created === true, title: clip(t.title) })),
      sites: [...sites], versions: sites.map(s => versions.get(s) || 0), allowNewTabs, uploads: true, downloads, fullControl, modeVersion });
  };
  // ── The network watch, for a wait with loadState 'networkidle' ──
  // Only a tab an agent holds is watched: three non-blocking webRequest listeners, filtered to that tab, added when an
  // agent takes it and removed when it gives it back, the tab closes or the owner takes it back (rewatch(), on every
  // change of the tabs). Nothing of a request is kept but its id, and the owner's other tabs are never observed.
  // `quietSince` is when the tab last had no request in flight (or when the watch began).
  const web = chrome.webRequest, watchable = !!(web?.onBeforeRequest?.addListener && web.onCompleted?.addListener && web.onErrorOccurred?.addListener);
  const watched = new Map();
  function watch(id) {
    const record = { inflight: new Set(), quietSince: now() };
    const begin = details => {
      // A new document: the requests of the one it replaces end with it (Playwright starts counting again, too).
      if (details?.type === 'main_frame') record.inflight.clear();
      record.inflight.add(String(details?.requestId));
    };
    const end = details => { if (record.inflight.delete(String(details?.requestId)) && !record.inflight.size) record.quietSince = now(); };
    const entry = { record, begin, end }, filter = { urls: ['<all_urls>'], tabId: id };
    watched.set(id, entry);
    try { web.onBeforeRequest.addListener(begin, filter); web.onCompleted.addListener(end, filter); web.onErrorOccurred.addListener(end, filter); }
    catch { unwatch(id); }
  }
  function unwatch(id) {
    const entry = watched.get(id); if (!entry) return;
    watched.delete(id);
    for (const [event, listener] of [['onBeforeRequest', entry.begin], ['onCompleted', entry.end], ['onErrorOccurred', entry.end]]) { try { web[event].removeListener(listener); } catch {} }
  }
  function rewatch() {
    if (!watchable) return;
    const held = new Set([...tabs.values()].filter(t => t.owner).map(t => t.id));
    for (const id of [...watched.keys()]) if (!held.has(id)) unwatch(id);
    for (const id of held) if (!watched.has(id)) watch(id);
  }
  const persist = async () => { rewatch(); await save({ tabs: [...tabs.values()], sites, versions: [...versions], allowNewTabs, uploads: true, downloads, fullControl, modeVersion }); changed(current()); };
  async function live(t) {
    try { const tab = await chrome.tabs.get(t.id); t.url = shownUrl(tab); t.title = clip(tab.title); return tab; }
    catch { move(t.id); tabs.delete(t.handle); moves.delete(t.id); await persist(); fail('TAB_CLOSED'); }
  }
  // Restricted mode: an approved site, with its host permission.
  async function permitted(url) {
    const origin = publicOrigin(url);
    if (!sites.includes(origin) || !await chrome.permissions.contains({ origins: [hostPattern(origin)] })) fail('SITE_NOT_APPROVED');
    return origin;
  }
  // Full control: any http(s) page or the blank page; never a page no extension may touch, nor SynaBun's own.
  function open(url, blocked) {
    anyOrigin(url);
    if (controlSurface(url, blocked)) fail('SYNABUN_PAGE_BLOCKED');
  }
  // The destination rule of the mode in force.
  async function destination(url, blocked) { if (fullControl) open(url, blocked); else await permitted(url); }
  // Full control: one record per tab of the browser. A tab already known keeps its handle and owner; a new one is
  // listed with no owner; a tab gone is forgotten (its counter too, so its commands fail TAB_CLOSED).
  async function enumerate() {
    if (!fullControl) return;
    const before = new Map([...tabs.values()].map(t => [t.id, { t, move: moved(t.id), url: t.url, title: t.title }]));
    let present; try { present = await chrome.tabs.query({ windowType: 'normal' }); } catch { return; }
    if (!fullControl) return;
    const byId = new Map([...tabs.values()].map(t => [t.id, t])), seen = new Set();
    for (const tab of present) {
      if (!Number.isSafeInteger(tab?.id) || tab.id < 0) continue;
      seen.add(tab.id);
      const known = byId.get(tab.id), url = shownUrl(tab).slice(0, 8192);
      const previous = before.get(tab.id);
      if (known) {
        if (previous?.t === known && previous.move === moved(tab.id)) {
          if (known.url === previous.url) known.url = url || known.url;
          if (known.title === previous.title) known.title = clip(tab.title);
        }
      } else if (previous) continue; // Removed while this query was pending: never resurrect its stale snapshot.
      else { const t = { handle: nonce(), id: tab.id, url, title: clip(tab.title), owner: null, created: false, listed: true }; tabs.set(t.handle, t); }
    }
    for (const t of [...tabs.values()]) if (!seen.has(t.id) && before.get(t.id)?.t === t) { tabs.delete(t.handle); moves.delete(t.id); }
  }
  async function authorized(op, tab, owner, args, blocked = {}) {
    if (CONTROL.includes(op)) { if (owner !== 'owner') fail('NOT_OWNED'); return null; }
    if (op === 'create') { if (!fullControl && !allowNewTabs) fail('PERMISSION_REQUIRED'); return null; }
    const t = tabs.get(tab); if (!t) fail('TAB_CLOSED');
    if (op === 'claim') {
      if (!t.owner && [...tabs.values()].filter(v => v.owner).length >= MAX_TABS) fail('TAB_LIMIT');
      if (t.owner && t.owner !== owner) fail('NOT_OWNED'); await live(t);
      // A tab on a page no agent may use is not taken over.
      if (fullControl) open(t.url, blocked);
      return t;
    }
    if (t.owner !== owner) fail('NOT_OWNED');
    if (op === 'release') return t;
    await live(t);
    if (fullControl) open(t.url, blocked);
    else if (t.url !== 'about:blank') await permitted(t.url); else if (op !== 'navigate' && !HISTORY.includes(op)) fail('SITE_NOT_APPROVED');
    if (args.url) await destination(args.url, blocked);
    if (op === 'download' && !downloads) fail('PERMISSION_REQUIRED');
    return t;
  }
  // The owner's mode change, from the popup or the server. An older version never applies. Switching to restricted
  // is a revocation, synchronously, before anything is awaited: every command in flight is stopped and the tabs that
  // were listed only because of full control are forgotten (their agents lose them; the tabs stay open).
  function applyMode(full, version) {
    if (!Number.isSafeInteger(version) || version < modeVersion) return false;
    if (full === fullControl) { modeVersion = version; return false; }
    if (!full) {
      approval++; epoch++;
      for (const t of [...tabs.values()]) if (t.listed && !t.created) { tabs.delete(t.handle); moves.delete(t.id); }
    }
    fullControl = full; modeVersion = version; return true;
  }
  // chrome.tabs.goBack/goForward answer once the traversal starts, not when it lands: wait for the tab to commit.
  // A cross-document entry changes the URL or shows a load; a same-document entry with the same URL shows neither.
  // `landing(url)` refuses an unapproved destination. It runs on every reading whose committed or pending URL differs
  // from the start, so an unapproved destination is refused as soon as the tab shows it, without waiting for its load.
  async function traverse(t, op, act, guard, landing) {
    const before = await live(t);
    // act() refuses a stale command before the step; only the browser's own refusal reaches the catch below.
    const step = act(() => chrome.tabs[op === 'back' ? 'goBack' : 'goForward'](t.id));
    try { await step; }
    catch (error) {
      await live(t); guard();
      if (/cannot find a (next|previous) page in history/i.test(String(error?.message || ''))) fail('NO_HISTORY_ENTRY');
      fail('OPERATION_FAILED');
    }
    t.nav = nonce();
    const start = Date.now(); let loading = false;
    for (;;) {
      const seen = await live(t); guard();
      for (const url of [seen.url, seen.pendingUrl]) if (url && url !== before.url) { await landing(url); guard(); }
      const moved = seen.url !== before.url;
      if (seen.status === 'loading') loading = true;
      else if (moved || loading || Date.now() - start >= quietMs) return seen;
      if (Date.now() - start >= settleMs) { if (moved) return seen; fail('TIMEOUT'); }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
  async function settled(t, guard, landing) {
    const start = Date.now(); let last = '', stableSince = start;
    for (;;) {
      const reading = await live(t); guard();
      for (const url of [reading.url, reading.pendingUrl]) if (url) { await landing(url); guard(); }
      const signature = `${reading.url}\n${reading.title || ''}\n${reading.status || ''}`;
      if (signature !== last) { last = signature; stableSince = Date.now(); }
      // Allow a click's navigation to begin, and URL/title events to settle. Never wait beyond its command budget.
      if (reading.status !== 'loading' && !reading.pendingUrl && Date.now() - stableSince >= quietMs) return reading;
      if (Date.now() - start >= settleMs) return reading;
      await new Promise(resolve => setTimeout(resolve, pollMs)); guard();
    }
  }
  // A navigation answers with the page it committed, never with the page the tab was still on. Chrome's tabs.update
  // resolves once the navigation is asked for, not when it commits: a navigation the browser dropped, or one still
  // waiting for its server, leaves the tab on `start` (live test, 2026-11-16: "Navigated about:blank" for a tab that
  // never left about:blank). Committed means the tab's committed URL is no longer `start` (a redirect counts), or, when
  // the target is the page the tab was already on, that page once it is quiet. Nothing committed within `commitMs` or
  // the command's deadline (less `reserve`, so the answer still goes out) is NAVIGATION_NOT_COMMITTED. Once committed,
  // the reading settles like settled() (no load, no pending URL, `quietMs` without change) or is returned after
  // `settleMs` still loading: the committed page.
  const sameUrl = (a, b) => { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } };
  async function committed(t, start, target, guard, landing, left) {
    const begin = Date.now(), same = sameUrl(start, target);
    let since = 0, last = '', stableSince = begin, started = false;
    for (;;) {
      const reading = await live(t); guard();
      for (const url of [reading.url, reading.pendingUrl]) if (url) { await landing(url); guard(); }
      const busy = reading.status === 'loading' || !!reading.pendingUrl;
      const done = shownUrl(reading) !== start || same && !busy;
      const signature = `${reading.url}\n${reading.title || ''}\n${reading.status || ''}\n${reading.pendingUrl || ''}`;
      if (signature !== last) { last = signature; stableSince = Date.now(); }
      if (done) {
        since ||= Date.now();
        if (!busy && Date.now() - stableSince >= quietMs) return reading;
        // Committed but not settled at the deadline: TIMEOUT from guard(), as before (the outcome is uncertain).
        if (Date.now() - since >= settleMs) return reading;
      } else if (Date.now() - begin >= commitMs || left() <= 0) fail('NAVIGATION_NOT_COMMITTED');
      // Started (a load or a pending URL was seen) and stopped again on the old page: the browser abandoned it (a
      // download, a 204, a navigation cancelled), so there is no need to wait out the deadline.
      else if (started && !busy && Date.now() - stableSince >= quietMs) fail('NAVIGATION_NOT_COMMITTED');
      started ||= busy;
      await new Promise(resolve => setTimeout(resolve, pollMs)); guard();
    }
  }
  // Owner revocations from the server. Everything that narrows happens synchronously, on the call itself, before the
  // first await: the caller runs these as soon as they arrive, ahead of queued commands.
  function control(op, tab, owner, args) {
    if (owner !== 'owner') return Promise.reject(Object.assign(new Error('NOT_OWNED'), { code: 'NOT_OWNED' }));
    if (op === 'mode') { applyMode(args.fullControl, args.version); return enumerate().then(persist).then(() => ({ ok: true })); }
    approval++; epoch++;
    if (op === 'revokeTab') tabs.delete(tab);
    else if (op === 'revokeSite') { sites = sites.filter(s => s !== args.site); pruneVersions(); }
    // A restarted server knows none of the agents that held tabs: every tab goes back to the owner. A tab an agent
    // opened stays open (it becomes one of the owner's), and nothing is closed.
    else if (op === 'reset') { for (const t of [...tabs.values()]) { if (t.created) tabs.delete(t.handle); else t.owner = null; } }
    else { tabs.clear(); connection++; }
    return enumerate().then(persist).then(() => ({ ok: true }));
  }
  // `given` is the ticket the command arrived with; a direct call is held to the generations of the moment it starts.
  // `given.expires` is the command's local deadline (on `now`), set by the worker when the message arrived; without one
  // the deadline is counted from this call. Owner revocations ignore it: they only narrow, so they always apply.
  async function execute(input, given = ticket()) {
    const { op, tab, owner, args, blockedHosts = [], blockedPorts = [], selfHosts = [], deadline } = command(input);
    const blocked = { blockedHosts, blockedPorts, selfHosts };
    if (CONTROL.includes(op)) return control(op, tab, owner, args);
    const expires = Number.isFinite(given.expires) ? given.expires : localDeadline(now(), deadline);
    // Held to the generations (CANCELLED) and to the deadline (TIMEOUT): a command never acts after the server gave up.
    const guard = () => { if (!valid(given)) fail('CANCELLED'); if (now() >= expires) fail('TIMEOUT'); };
    // Every chrome.* call with an effect goes through act(): checked in the same synchronous step as the call, after
    // the last await before it, so a revocation or disconnect that landed during that await stops it.
    const act = effect => { guard(); return effect(); };
    guard();
    // SynaBun's own addresses, in either mode (in restricted mode a local address is not an approvable site anyway).
    const denyControlHost = url => { if (controlSurface(url, blocked)) fail(fullControl ? 'SYNABUN_PAGE_BLOCKED' : 'SITE_NOT_APPROVED'); };
    if (!['release', 'create'].includes(op)) {
      const existing = tabs.get(tab);
      if (existing) { await live(existing); guard(); denyControlHost(existing.url); }
      denyControlHost(args.url);
    }
    let t = await authorized(op, tab, owner, args, blocked);
    guard();
    // Held to the owner's epoch and to this command's own tab only; a screenshot also to the active tab.
    const began = epoch, tabBegan = t ? moved(t.id) : 0; let focusBegan = focus;
    const unchanged = () => {
      if (began !== epoch || t && moved(t.id) !== tabBegan || op === 'screenshot' && focus !== focusBegan) fail('TAB_NOT_APPROVED');
    };
    const recheck = async () => { guard(); unchanged(); if (t) { await authorized(op, tab, owner, args, blocked); guard(); unchanged(); denyControlHost(t.url); } };
    const landing = async url => { if (fullControl) open(url, blocked); else if (url !== 'about:blank') await permitted(url); denyControlHost(url); };
    // The URL and title returned come from one reading of the tab whose URL is the one authorization checked.
    const metadata = async (read = () => settled(t, guard, landing)) => {
      let reading = await read();
      for (let attempt = 0; ; attempt++) {
        await authorized(op, tab, owner, {}, blocked); guard(); denyControlHost(t.url);
        if (t.url === shownUrl(reading)) return { url: shownUrl(reading), title: String(reading.title || '').slice(0, 1000) };
        if (attempt >= 2) fail('TIMEOUT');
        reading = await read();
      }
    };
    let result = { ok: true };
    if (op === 'create') {
      const opened = await act(() => chrome.tabs.create({ url: 'about:blank', active: false }));
      if (!valid(given) || now() >= expires || began !== epoch || !fullControl && !allowNewTabs) {
        await chrome.tabs.remove(opened.id); fail(!valid(given) ? 'CANCELLED' : now() >= expires ? 'TIMEOUT' : 'TAB_NOT_APPROVED');
      }
      if ([...tabs.values()].filter(v => v.owner).length >= MAX_TABS) { await chrome.tabs.remove(opened.id); fail('TAB_LIMIT'); }
      // A listing of the browser's tabs may have seen the new tab first: it is this agent's, under one handle.
      for (const known of [...tabs.values()]) if (known.id === opened.id) tabs.delete(known.handle);
      t = { handle: nonce(), id: opened.id, url: 'about:blank', title: '', owner, created: true }; tabs.set(t.handle, t); result.tab = t.handle;
    } else if (op === 'claim') { guard(); t.owner = owner; result.tab = t.handle; }
    else if (op === 'release') {
      // A tab the agent opened is closed. Any other tab goes back to the owner, open: in full control it stays listed,
      // in restricted mode its sharing ends with the agent's use of it (as before).
      guard();
      if (t.created) { tabs.delete(t.handle); await act(() => chrome.tabs.remove(t.id)).catch(() => {}); }
      else if (fullControl) t.owner = null;
      else tabs.delete(t.handle);
    }
    else if (op === 'navigate') {
      await recheck();
      const start = t.url;
      try { await act(() => chrome.tabs.update(t.id, { url: args.url })); }
      catch (error) { guard(); if (error?.code) throw error; fail(/tabs cannot be edited/i.test(error?.message || '') ? 'TAB_BUSY' : 'NAVIGATION_FAILED'); }
      t.nav = nonce();
      // What is left before the deadline, less the time the answer needs to go out (a tenth of the budget, ≤ 300 ms).
      const reserveMs = Math.min(300, Math.max(0, (expires - now()) / 10)), left = () => expires - now() - reserveMs;
      try { result = { ok: true, ...await metadata(() => committed(t, start, args.url, guard, landing, left)) }; }
      catch (error) { if (error?.code === 'NAVIGATION_NOT_COMMITTED') await persist(); throw error; }
    }
    else if (op === 'reload') { await recheck(); await act(() => chrome.tabs.reload(t.id)); }
    else if (HISTORY.includes(op)) {
      await recheck();
      // The destination is unknown until the tab lands (no history permission). Check it like a navigate target,
      // while it lands and after: the tab keeps its new URL, so every later command on it is refused too, and nothing
      // of an unapproved page is returned. recheck() is not used here: the URL change itself moves the tab's counter.
      const landing = async url => { if (fullControl) open(url, blocked); else if (url !== 'about:blank') await permitted(url); denyControlHost(url); };
      let reading;
      try {
        reading = await traverse(t, op, act, guard, landing);
        // The URL and title returned come from one reading of the tab, and that reading's URL is the one authorized
        // (authorized() reads the tab again). A redirect between the two readings means another reading, up to three.
        for (let attempt = 1; ; attempt++) {
          await authorized(op, tab, owner, {}, blocked); guard(); denyControlHost(t.url);
          if (t.url === reading.url) break;
          if (attempt >= 3) fail('TIMEOUT');
          reading = await live(t); guard();
        }
      } catch (error) { await persist(); throw error; }
      result = { ok: true, url: reading.url, title: String(reading.title || '').slice(0, 1000) };
    }
    else if (op === 'download') {
      if (!await chrome.permissions.contains({ permissions: ['downloads'] })) fail('PERMISSION_REQUIRED');
      await recheck(); result.downloadId = await act(() => chrome.downloads.download({ url: args.url, saveAs: true }));
    } else if (op === 'screenshot' && fullControl) {
      // Full control (live test, 2026-11-16: ACTIVE_TAB_REQUIRED on a fresh agent tab while the owner worked in another
      // window). captureVisibleTab captures what a window shows, and Chrome refuses it for a window that is minimized or
      // hidden behind others (its view is not visible). Each attempt brings the agent's tab to the front of its own
      // window, restores and focuses that window when needed (always on the retry), waits until the tab is the active one
      // of a window that is not minimized, and captures that window (the tab's own windowId). One retry; then
      // ACTIVE_TAB_REQUIRED. The capture is still held to the tab staying the active one, and to the command's counters.
      const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, expires - now()))));
      const windowOf = async id => { try { return chrome.windows?.get ? await chrome.windows.get(id) : null; } catch { return null; } };
      const frontOf = async windowId => (await chrome.tabs.query({ active: true, windowId }))[0];
      // Until the tab is the active one of its window and that window is not minimized (and focused, when asked).
      async function shown(focused) {
        const until = Date.now() + visibleMs;
        for (;;) {
          const tab = await live(t); guard();
          const win = await windowOf(tab.windowId), front = await frontOf(tab.windowId); guard();
          if (tab.active && front?.id === t.id && win?.state !== 'minimized' && (!focused || !win || win.focused !== false)) return tab;
          if (Date.now() >= until) return null;
          await sleep(pollMs); guard();
        }
      }
      async function attempt(retry) {
        try {
          // The focus counter guards the capture itself; a tab switch before this attempt (this command's own earlier
          // activation included) is not a reason to refuse it.
          focusBegan = focus;
          let opened = await live(t); guard();
          if (!opened.active || (await frontOf(opened.windowId))?.id !== t.id) { await recheck(); await act(() => chrome.tabs.update(t.id, { active: true })); }
          const win = await windowOf(opened.windowId); guard();
          const focusIt = retry || win?.state === 'minimized';
          if (focusIt && chrome.windows?.update) {
            await recheck();
            await act(() => chrome.windows.update(opened.windowId, { focused: true, ...(win?.state === 'minimized' ? { state: 'normal' } : {}) }));
          }
          await sleep(activateMs); guard();
          opened = await shown(focusIt);
          if (!opened) return null;
          focusBegan = focus;
          // SynaBun's own pace (one capture a second): a retry waits it out within the deadline instead of failing.
          const gap = 1000 - (Date.now() - lastCapture);
          if (gap > 0) { if (gap >= expires - now()) fail('TIMEOUT'); await sleep(gap); guard(); }
          await recheck();
          const capture = act(() => chrome.tabs.captureVisibleTab(opened.windowId, { format: 'png' }));
          lastCapture = Date.now();
          let data;
          try { data = await capture; } catch { guard(); return null; }
          const after = await frontOf(opened.windowId);
          if (after?.id !== t.id || after.url !== opened.url) return null;
          await recheck();
          return typeof data === 'string' && data.includes(',') ? data : null;
        } catch (error) {
          // The owner switched tabs while it ran (only the focus counter moved): the retry brings the tab back.
          if (error?.code === 'TAB_NOT_APPROVED' && began === epoch && moved(t.id) === tabBegan && valid(given)) return null;
          throw error;
        }
      }
      const data = await attempt(false) || await attempt(true);
      if (!data) fail('ACTIVE_TAB_REQUIRED');
      result.base64 = data.split(',')[1]; result.mimeType = 'image/png';
    } else if (op === 'screenshot') {
      // Restricted mode: the tab must already be the active one; nothing is brought forward.
      const opened = await live(t); guard();
      const active = (await chrome.tabs.query({ active: true, windowId: opened.windowId }))[0];
      if (!active || active.id !== t.id || !opened.active) fail('ACTIVE_TAB_REQUIRED');
      if (Date.now() - lastCapture < 1000) fail('TIMEOUT');
      await recheck();
      const capture = act(() => chrome.tabs.captureVisibleTab(opened.windowId, { format: 'png' }));
      lastCapture = Date.now();
      let data;
      try { data = await capture; } catch { fail('ACTIVE_TAB_REQUIRED'); }
      const after = (await chrome.tabs.query({ active: true, windowId: opened.windowId }))[0];
      if (after?.id !== t.id || after.url !== opened.url) fail('ACTIVE_TAB_REQUIRED');
      await recheck(); result.base64 = data.split(',')[1]; result.mimeType = 'image/png';
    } else if (op === 'wait' && args.loadState) {
      // A load-state wait reads the tab (and, for 'networkidle', the requests the watch saw); nothing is done to the
      // page. 'load': the tab is not loading and has no navigation pending. 'networkidle': also no request of the tab
      // in flight for `idleMs` (already so for a page that has been quiet: it answers at once). Every page the tab
      // shows meanwhile must be one the mode allows. The tab closing is TAB_CLOSED; the timeout (args.timeout, or
      // the deadline) is TIMEOUT.
      if (args.loadState === 'networkidle' && !watchable) fail('NETWORK_IDLE_UNAVAILABLE');
      const until = Math.min(now() + longBudget(op, args), expires);
      for (;;) {
        const reading = await live(t); guard();
        if (began !== epoch || tabs.get(tab) !== t || t.owner !== owner) fail('TAB_NOT_APPROVED');
        for (const url of [reading.url, reading.pendingUrl]) if (url) { await landing(url); guard(); }
        let idle = reading.status !== 'loading' && !reading.pendingUrl;
        if (idle && args.loadState === 'networkidle') {
          rewatch();
          const seen = watched.get(t.id)?.record;
          if (!seen) fail('NETWORK_IDLE_UNAVAILABLE');
          idle = !seen.inflight.size && now() - seen.quietSince >= idleMs;
        }
        if (idle) break;
        if (now() >= until) fail('TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(pollMs, until - now()))));
      }
      await authorized(op, tab, owner, {}, blocked); guard(); denyControlHost(t.url);
      result = { ok: true, url: t.url, title: String(t.title || '').slice(0, 1000), loadState: args.loadState };
    } else if (op === 'evaluate') {
      // Page JavaScript, through chrome.userScripts.execute: the one way an MV3 extension may run code it did not ship,
      // and only where the owner switched "Allow User Scripts" on for this extension (USER_SCRIPTS_DISABLED says how).
      // Held to every gate of a page command (the agent's own tab, a page the mode allows, never SynaBun's own, the
      // approval and connection generations, the deadline), and to one document: the frame's document is read first in
      // the isolated world (its id and its address, which the page cannot forge), that address passes the same rule as
      // the tab's, and the script runs in that document only (gone meanwhile: nothing runs).
      if (t.url === 'about:blank') fail('BLANK_PAGE');
      await recheck();
      const scripts = chrome.userScripts;
      const available = async () => { try { await scripts.getScripts(); return true; } catch { return false; } };
      if (!scripts || !await available()) fail('USER_SCRIPTS_DISABLED');
      if (typeof scripts.execute !== 'function') fail('USER_SCRIPTS_UNSUPPORTED');
      guard();
      const frame = args.frame ?? 0;
      let probe;
      try { probe = await act(() => chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [frame] }, world: 'ISOLATED', injectImmediately: true, func: () => location.href })); }
      catch (error) { if (error?.code) throw error; guard(); await live(t); fail(frame ? 'FRAME_NOT_FOUND' : 'OPERATION_FAILED'); }
      const page = probe?.[0];
      if (typeof page?.documentId !== 'string' || typeof page.result !== 'string') fail(frame ? 'FRAME_NOT_FOUND' : 'TAB_NOT_APPROVED');
      await recheck();
      // A frame's document is an http(s) page of its own: a blank or srcdoc frame takes the origin of whoever made it.
      if (!/^https?:/i.test(page.result)) fail('RESTRICTED_PAGE');
      await landing(page.result); guard();
      const cap = Math.max(1, Math.min(args.maxChars || EVALUATE_RESULT_MAX, EVALUATE_RESULT_MAX));
      const EXPIRED = {}; let timer, running;
      try {
        running = Promise.resolve(act(() => scripts.execute({ target: { tabId: t.id, documentIds: [page.documentId] }, world: args.world || 'MAIN',
          injectImmediately: true, js: [{ code: pageScript(args, cap) }] })));
      } catch (error) { if (error?.code) throw error; running = Promise.reject(error); }
      running.catch(() => {});
      // The script's own timeout, never past the command's deadline. The page's script cannot be stopped: at the
      // timeout the answer is TIMEOUT and whatever it returns later is dropped.
      const expired = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, Math.min(longBudget(op, args), expires - now())), EXPIRED); });
      let outcome;
      try { outcome = await Promise.race([running, expired]); }
      catch {
        // The browser refused: the document is gone (the tab navigated or closed), or user scripts were switched off.
        guard(); await live(t);
        if (began !== epoch || moved(t.id) !== tabBegan || !frame && t.url !== page.result) fail('TAB_NOT_APPROVED');
        if (!await available()) fail('USER_SCRIPTS_DISABLED');
        fail('OPERATION_FAILED');
      } finally { clearTimeout(timer); }
      guard();
      if (outcome === EXPIRED) fail('TIMEOUT');
      // The script may itself have navigated the tab: that is its effect, not a reason to withhold what it returned
      // from the document that was checked. An owner's revocation meanwhile is (guard(), the epoch).
      if (began !== epoch) fail('TAB_NOT_APPROVED');
      if (moved(t.id) !== tabBegan) t.nav = nonce();
      const entry = Array.isArray(outcome) ? outcome[0] : null, reply = entry?.result;
      if (reply?.synabun === 1 && reply.ok === true && typeof reply.json === 'string') {
        const value = clipped(reply.json, cap), total = Number.isSafeInteger(reply.length) && reply.length > reply.json.length ? reply.length : reply.json.length;
        result = { ok: true, value, ...(value.length < total ? { truncated: true, valueLength: total } : {}) };
      } else {
        // What the page's script threw (the wrapper's report), or what the browser said when it could not compile or
        // run it. A page error is an answer about the page, with its own code: the bridge did what it was asked.
        const threw = reply?.synabun === 1 && reply.ok === false, text = (value, max) => String(value ?? '').slice(0, max);
        const message = threw ? [text(reply.name, 200), text(reply.message, 2000)].filter(Boolean).join(': ')
          : typeof entry?.error === 'string' && entry.error ? text(entry.error, 2000) : 'The script returned no result: it did not compile, or the page stopped it.';
        result = { ok: false, code: 'PAGE_ERROR', error: `PAGE_ERROR: ${ERROR_TEXT.PAGE_ERROR}`, errorMessage: message || 'The script threw.', errorStack: threw ? text(reply.stack, 6000) : '' };
      }
    } else if (fullControl && t.url === 'about:blank') {
      // A blank tab (where a new agent tab starts) has no page an extension may script: it reads as empty, a plain
      // wait waits, and anything that needs an element finds none.
      await recheck();
      const blank = { ok: true, url: 'about:blank', title: '' };
      if (op === 'snapshot') result = { ...blank, mode: 'ai', snapshotId: 'blank', snapshotText: '' };
      else if (op === 'content') result = { ...blank, content: '', text: '' };
      else if (op === 'wait' && !args.selector) {
        const ms = Math.min(args.timeout ?? 1000, 15000), left = expires - now();
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, left)))); guard();
        if (ms >= left) fail('TIMEOUT');
        await recheck(); result = blank;
      } else fail('NO_MATCH');
    } else {
      const injection = await act(() => chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: ['content.js'], world: 'ISOLATED' }));
      await recheck();
      t.nav ||= nonce();
      // The page action carries the deadline as a system-clock time (`until`), which the content script shares: it
      // refuses to act once that has passed, however late the message reaches it, and a wait ends there.
      // Full control sends no site list: the page checks only that a link or form does not lead to SynaBun's own
      // addresses (`blocked`). Restricted mode sends the approved sites, less SynaBun's public aliases.
      const beforeActionUrl = t.url;
      let delivery = { frameId: 0 }, pageArgs = args;
      if (op === 'upload') {
        const documentId = injection?.[0]?.documentId;
        if (!documentId) fail('TAB_NOT_APPROVED');
        delivery = { documentId };
        const metadata = [];
        let remaining = MAX_FILE;
        for (let index = 0; index < args.files.length; index++) {
          await recheck();
          const response = await readUpload(input.id, index, Math.max(1, expires - now()));
          const timestamp = response.headers.get('X-SynaBun-Last-Modified');
          if (!timestamp || !Number.isSafeInteger(Number(timestamp))) fail('UPLOAD_METADATA_UNAVAILABLE');
          const blob = await response.blob();
          if (!blob.type) fail('UPLOAD_METADATA_UNAVAILABLE');
          if (blob.size > remaining) fail('UPLOAD_TOO_LARGE');
          remaining -= blob.size;
          metadata.push({ size: blob.size, type: blob.type, lastModified: Number(timestamp) });
          // Chrome serializes tab messages as JSON. Keep even a 50 MB file below its IPC cap.
          const chunkSize = 1024 * 1024;
          for (let pos = 0; pos < blob.size; pos += chunkSize) {
            const reader = new FileReader();
            const data = await new Promise((resolve, reject) => {
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob.slice(pos, pos + chunkSize));
            });
            await recheck();
            const ack = await act(() => chrome.tabs.sendMessage(t.id, { kind: 'synabun-upload-part',
              id: input.id, index, data, until: wallClock() + Math.max(0, expires - now()) }, delivery));
            if (!ack?.ok) fail(ack?.code || 'OPERATION_FAILED');
          }
        }
        await recheck();
        pageArgs = { ...args, uploadId: input.id, metadata };
      }
      result = await act(() => chrome.tabs.sendMessage(t.id, { kind: 'synabun-fixed-command', op, args: pageArgs,
        sites: fullControl ? null : sites.filter(site => !blockedHosts.includes(new URL(site).hostname)), blocked, downloads, nav: t.nav,
        until: wallClock() + Math.max(0, expires - now()) }, delivery));
      if (op === 'click' && result?.ok) {
        Object.assign(result, await metadata());
        if (result.url !== beforeActionUrl || moved(t.id) !== tabBegan) t.nav = nonce();
      } else await recheck();
      if (!result?.ok) return safeError(result);
      if (result.downloadUrl) {
        if (!downloads || !await chrome.permissions.contains({ permissions: ['downloads'] })) fail('PERMISSION_REQUIRED');
        guard(); await destination(result.downloadUrl, blocked); denyControlHost(result.downloadUrl); await recheck();
        const downloadId = await act(() => chrome.downloads.download({ url: result.downloadUrl, saveAs: true }));
        result = { ok: true, downloadId };
      }
    }
    await persist(); return result;
  }
  return {
    current, ticket, now,
    mode: () => ({ fullControl, modeVersion }),
    async restore(saved = {}) {
      sites = (saved.sites || []).filter(s => { try { return publicOrigin(s) === s; } catch { return false; } });
      versions = new Map((Array.isArray(saved.versions) ? saved.versions : []).filter(e => Array.isArray(e) && typeof e[0] === 'string' && Number.isSafeInteger(e[1]) && e[1] >= 0));
      allowNewTabs = saved.allowNewTabs === true; downloads = saved.downloads === true;
      fullControl = typeof saved.fullControl === 'boolean' ? saved.fullControl : fullControlDefault === true;
      modeVersion = Number.isSafeInteger(saved.modeVersion) && saved.modeVersion >= 0 ? saved.modeVersion : 0;
      tabs = new Map((saved.tabs || []).filter(t => fullControl || !t.listed || t.created).map(t => [t.handle, t]));
      for (const t of [...tabs.values()]) { try { await live(t); } catch {} }
      await enumerate(); await persist();
    },
    // The popup's mode switch (the owner's gesture): always newer than any version either side has seen.
    async setMode(full) {
      if (typeof full !== 'boolean') fail('INVALID_MESSAGE');
      applyMode(full, Math.max(modeVersion + 1, wallClock()));
      await enumerate(); await persist();
    },
    // The popup's owner gesture, and the only place an approval version rises: every share is a fresh approval, newer
    // than any the server saw (a wall-clock floor keeps that true even after the extension's storage was cleared).
    async share(id, siteOnly = false) {
      const opened = await chrome.tabs.get(id); const origin = publicOrigin(opened.url);
      if (!await chrome.permissions.contains({ origins: [hostPattern(origin)] })) fail('PERMISSION_REQUIRED');
      if (!sites.includes(origin)) sites.push(origin);
      versions.set(origin, Math.max((versions.get(origin) || 0) + 1, Date.now()));
      const known = [...tabs.values()].find(t => t.id === id);
      if (!siteOnly && known) known.listed = false;
      else if (!siteOnly) { const t = { handle: nonce(), id, url: opened.url, title: clip(opened.title), owner: null, created: false }; tabs.set(t.handle, t); }
      await persist();
    },
    async revokeTab(handle) { approval++; tabs.delete(handle); epoch++; await enumerate(); await persist(); },
    async revokeSite(site) { approval++; sites = sites.filter(s => s !== site); epoch++; pruneVersions(); await persist(); },
    async options(value) {
      // Switching a permission off is a revocation; switching one on is not.
      if (allowNewTabs && value.allowNewTabs !== true || downloads && value.downloads !== true) { approval++; epoch++; }
      allowNewTabs = value.allowNewTabs === true; downloads = value.downloads === true; await persist();
    },
    // Tab events from the browser concern that tab only.
    async closed(id) { move(id); for (const t of tabs.values()) if (t.id === id) tabs.delete(t.handle); moves.delete(id); await persist(); },
    async updated(id) { move(id); for (const t of tabs.values()) if (t.id === id) { try { await live(t); } catch {} } await enumerate(); await persist(); },
    // Full control: a tab opened or retitled. Neither moves a tab's counter (a title changes while agents work).
    async opened() { if (!fullControl) return; await enumerate(); await persist(); },
    async retitled(id) {
      if (![...tabs.values()].some(t => t.id === id)) return;
      for (const t of tabs.values()) if (t.id === id) { try { const tab = await chrome.tabs.get(id); t.title = clip(tab.title); } catch {} }
      await persist();
    },
    // A new pairing or an unpairing ends every approval and every agent's hold. The mode is the owner's setting and stays.
    async clear() { approval++; tabs.clear(); sites = []; allowNewTabs = downloads = false; epoch++; await enumerate(); await persist(); },
    activated() { focus++; },
    // Whether an agent holds the browser tab with this Chrome id (SynaBun's setup page is never paired from one).
    heldByAgent: id => [...tabs.values()].some(t => t.id === id && t.owner),
    // The connection commands came on has ended (closed, paused, unpaired or replaced by a new pairing).
    disconnected() { connection++; },
    // An approval was withdrawn outside the popup (a host permission removed in the browser's own settings).
    withdrawn() { approval++; },
    execute,
  };
}
