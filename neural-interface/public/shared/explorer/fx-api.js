// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer: the server
// ═══════════════════════════════════════════
//
// Every request the explorer makes. The page reloads at any time and the
// server only on a restart, so it works against an older server with what that
// has: the listing and search of /api/project-files, git from /api/git/status,
// a new file or folder and a delete through the editor's routes. Whether the
// server has the explorer's own routes (lib/file-explorer-api.js) it is told
// by the answer of GET /api/projects, which the panel asks for anyway
// (`serverSays`): an older server lists nothing there, and nothing of
// /api/explorer is ever asked of it. What it cannot do answers
// `{ ok: false, code: 'unsupported' }` here, without a request.
// Nothing in this file throws: a call resolves to `{ ok: true, … }` or to
// `{ ok: false, code, … }` (`offline` when the server did not answer).

import { fromLegacyListing, fromLegacySearch, trimSlash } from './fx-logic.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const RECONNECT_MS = [1500, 3000, 6000, 12000, 30000];

/**
 * @param {{ fetchImpl?: typeof fetch, EventSourceImpl?: typeof EventSource }} [o]
 */
export function createExplorerApi({ fetchImpl = (...args) => fetch(...args), EventSourceImpl = globalThis.EventSource } = {}) {
  let asked = null;   // the one question about what the server has
  let listed = null;  // what GET /api/projects said this server has
  let caps = { known: false, explorer: false, info: null };

  async function request(url, init) {
    let res;
    try { res = await fetchImpl(url, init); } catch (error) { return { ok: false, code: error?.name === 'AbortError' ? 'aborted' : 'offline' }; }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.ok && body && body.ok !== false) return { ok: true, ...body };
    // The server's first gate answers an invited guest 403 "Admin only", without a code of its own.
    const guest = res.status === 403 && body?.error === 'Admin only';
    return { ...(body && typeof body === 'object' ? body : {}), ok: false, code: body?.code || (guest ? 'GUEST_FORBIDDEN' : res.status === 403 ? 'denied' : res.status === 404 ? 'gone' : 'failed'), status: res.status };
  }
  const post = (path, body) => request(`/api/explorer${path}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const unsupported = () => Promise.resolve({ ok: false, code: 'unsupported' });

  /**
   * What GET /api/projects listed as this server's capabilities (null when it did not answer). Called by the panel
   * each time it reads the projects: a server that was restarted since is found out by the next read.
   */
  function serverSays(list) {
    const has = Array.isArray(list) && list.includes('explorer');
    if (listed !== null && has === caps.explorer && caps.known) return;
    listed = Array.isArray(list) ? list : (list === null ? null : []);
    asked = null;
    caps = { known: false, explorer: false, info: null };
  }

  /** What the server can do: its own word on the explorer's routes, asked for once it says it has them. */
  function capabilities() {
    if (!asked) {
      asked = (async () => {
        if (listed === null) { asked = null; return caps; }   // not told yet: the next call looks again
        const has = listed.includes('explorer');
        const info = has ? await request('/api/explorer/info') : null;
        if (has && !info.ok && info.code === 'offline') { asked = null; return caps; }
        caps = { known: true, explorer: !!(has && info?.ok), info: info?.ok ? info : null };
        return caps;
      })();
    }
    return asked;
  }

  /** What is known of the server right now (after `capabilities()` answered). */
  const abilities = () => ({
    known: caps.known,
    ops: caps.explorer,
    watch: caps.explorer,
    trash: caps.explorer && !!caps.info?.trash,
    reveal: caps.explorer && !!caps.info?.reveal,
    preview: caps.explorer,
    platform: caps.info?.platform || null,
  });

  async function list(path) {
    await capabilities();
    if (caps.explorer) return request(`/api/explorer/list?path=${encodeURIComponent(path)}`);
    const old = await request(`/api/project-files?path=${encodeURIComponent(path)}`);
    if (!old.ok) {
      // The older route words its failures itself: a folder that is not there, a path that is not allowed.
      return { ok: false, code: old.code === 'offline' ? 'offline' : old.status === 403 ? (old.code === 'GUEST_FORBIDDEN' ? old.code : 'outside') : old.status === 400 ? 'gone' : 'failed' };
    }
    return fromLegacyListing(old);
  }

  async function search(root, query, signal) {
    await capabilities();
    if (caps.explorer) return request(`/api/explorer/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`, { signal });
    const old = await request(`/api/project-files?${new URLSearchParams({ path: root, search: query, recursive: '1' })}`, { signal });
    return old.ok ? fromLegacySearch(old) : old;
  }

  async function git(root) {
    await capabilities();
    if (caps.explorer) return request(`/api/explorer/git?root=${encodeURIComponent(root)}`);
    const old = await request(`/api/git/status?path=${encodeURIComponent(root)}`);
    if (!old.ok) return old;
    if (!old.isGit) return { ok: true, isGit: false };
    const changes = {};
    for (const change of old.changes || []) if (change?.path) changes[change.path] = change.status;
    return { ok: true, isGit: true, branch: old.branch || '', changes, ignored: [], legacy: true };
  }

  async function create(parent, name, type) {
    await capabilities();
    if (caps.explorer) return post('/create', { parent, name, type });
    // An older server: its own two routes. It would write over a file, or take a folder that is there for a new
    // one, so the folder is read first and a name that is taken is refused here.
    const there = await list(parent);
    if (!there.ok) return there;
    if (there.items.some((item) => item.name.toLowerCase() === name.toLowerCase())) return { ok: false, code: 'exists', name };
    const path = `${trimSlash(parent)}/${name}`;
    const made = type === 'dir'
      ? await request('/api/file-mkdir', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ path }) })
      : await request('/api/file-content', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ path, content: '', create: true, expectAbsent: true }) });
    if (made.ok) return { ok: true, path, type };
    return { ok: false, code: made.status === 409 ? 'exists' : made.status === 403 ? 'denied' : made.code === 'offline' ? 'offline' : 'failed', name };
  }

  async function remove(paths, { permanent = false } = {}) {
    await capabilities();
    if (caps.explorer) return post('/delete', { paths, permanent });
    // An older server deletes for good, one entry at a time, and a folder only when it is empty.
    if (!permanent) return { ok: false, code: 'no-trash' };
    const deleted = [];
    for (const path of paths) {
      const done = await request(`/api/file-content?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      if (done.ok || done.status === 404) { deleted.push(path); continue; }
      const notEmpty = done.status === 400 && /not empty/i.test(String(done.error || ''));
      return { ok: false, code: notEmpty ? 'not-empty' : done.status === 403 ? 'denied' : done.code === 'offline' ? 'offline' : 'failed', deleted, failed: path };
    }
    return { ok: true, deleted, trashed: false };
  }

  const guarded = (call) => async (...args) => { await capabilities(); return caps.explorer ? call(...args) : unsupported(); };

  /**
   * Follow a project on disk. `onChange({ dirs, git })` names the shown folders that changed; `onReady(again)` says
   * the stream is up (`again`: after it was down, so anything may have changed meanwhile). A stream is not a watch
   * that works: `onState({ live, scope })` says what the server really watches, at the start and when it changes
   * (`live`: 'full', 'partial' when some folders could not be watched, 'none' when the project is not watched at
   * all; `scope`: 'tree', or 'folders' where only the shown folders are watched). `onResync()`: the server lost
   * its watch on the project; it tries for it again by itself, and nothing is sent back for the report (what is
   * shown may be stale, the folders that are shown are the ones it was told). Null on a server that has no
   * watch. The connection is tried again by itself, ever more slowly, until `close()`.
   */
  function watch(root, { onChange, onReady = () => {}, onDown = () => {}, onState = () => {}, onResync = () => {} }) {
    if (!caps.explorer || typeof EventSourceImpl !== 'function') return null;
    let source = null; let id = null; let dirs = []; let closed = false; let attempt = 0; let timer = 0; let pushTimer = 0; let wasUp = false;
    const push = () => {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => { if (id && !closed) post(`/watch/${id}`, { dirs }); }, 120);
    };
    const connect = () => {
      if (closed) return;
      source = new EventSourceImpl(`/api/explorer/watch?root=${encodeURIComponent(root)}`);
      const say = (data) => onState({ live: ['partial', 'none'].includes(data?.live) ? data.live : 'full', scope: data?.scope === 'folders' ? 'folders' : 'tree' });
      source.addEventListener('ready', (event) => {
        let said = null;
        try { said = JSON.parse(event.data); } catch { said = null; }
        id = said?.id || null;
        attempt = 0;
        push();
        say(said);
        onReady(wasUp);
        wasUp = true;
      });
      source.addEventListener('state', (event) => { try { say(JSON.parse(event.data)); } catch { /* skipped, as below */ } });
      source.addEventListener('change', (event) => { try { onChange(JSON.parse(event.data)); } catch { /* a report that cannot be read is skipped */ } });
      source.addEventListener('resync', () => onResync());
      source.onerror = () => {
        // The browser would try again every three seconds for as long as the page lives: tried here, more slowly.
        try { source.close(); } catch { /* closed */ }
        id = null;
        if (closed) return;
        onDown();
        timer = setTimeout(connect, RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)]);
      };
    };
    connect();
    return {
      setDirs(list) { dirs = [...list]; push(); },
      close() { closed = true; clearTimeout(timer); clearTimeout(pushTimer); try { source?.close(); } catch { /* closed */ } },
    };
  }

  return {
    serverSays,
    capabilities,
    abilities,
    list,
    search,
    git,
    create,
    remove,
    rename: guarded((path, name) => post('/rename', { path, name })),
    // `permanent`: what a replace clears may be removed for good when the Trash cannot take it (the user was asked).
    // `replace`: the names that may be replaced (the ones the user was asked about), or false.
    move: guarded((paths, into, { replace = false, permanent = false } = {}) => post('/move', { paths, into, replace, permanent })),
    copy: guarded((paths, into, { replace = false, permanent = false } = {}) => post('/copy', { paths, into, replace, permanent })),
    reveal: guarded((path) => post('/reveal', { path })),
    upload: guarded((file, into, { name = file.name, rel = '', replace = false, permanent = false } = {}) => request(
      `/api/explorer/upload?${new URLSearchParams({ into, name, ...(rel ? { rel } : {}), ...(replace ? { replace: '1' } : {}), ...(replace && permanent ? { permanent: '1' } : {}) })}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
    )),
    /** Where the bytes of an image are (null on a server that has no preview). */
    rawUrl: (path) => (caps.explorer ? `/api/explorer/raw?path=${encodeURIComponent(path)}` : null),
    watch,
  };
}
