// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: loading CodeMirror
// ═══════════════════════════════════════════
//
// CodeMirror is vendored (public/vendor/codemirror/, built by
// scripts/build-vendor.mjs): nothing comes from a CDN. The manifest names the
// entry file of the current build; it is imported once per page, the first
// time a file is opened. A failed load is reported to the caller, which shows
// it with a Retry; the next call tries again.

export const CODEMIRROR_BASE = '/vendor/codemirror/';
const ENTRY_NAME = /^codemirror-[A-Za-z0-9._-]+\.min\.js$/;

let _loading = null;
let _attempt = 0;

/**
 * The vendored CodeMirror bundle.
 * @param {{ fetchImpl?: typeof fetch, importModule?: (url: string) => Promise<object> }} [o] for tests
 * @returns {Promise<{ cm: object, manifest: { version: string, entry: string, packages: object } }>}
 *   Rejects with an Error when the manifest or the bundle cannot be loaded.
 */
export function loadCodeMirror({ fetchImpl = (...args) => fetch(...args), importModule = (url) => import(url) } = {}) {
  if (_loading) return _loading;
  const attempt = ++_attempt;
  const loading = (async () => {
    const res = await fetchImpl(`${CODEMIRROR_BASE}manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`CodeMirror manifest: HTTP ${res.status}`);
    const manifest = await res.json();
    if (typeof manifest?.entry !== 'string' || !ENTRY_NAME.test(manifest.entry)) {
      throw new Error('CodeMirror manifest names no entry file');
    }
    // A module that failed to load can stay failed under its address for the rest of the page:
    // a retry asks for it under another one.
    const retry = attempt > 1 ? `?retry=${attempt}` : '';
    const cm = await importModule(`${CODEMIRROR_BASE}${manifest.entry}${retry}`);
    if (typeof cm?.EditorView !== 'function' || typeof cm?.EditorState !== 'function') {
      throw new Error('CodeMirror bundle is incomplete');
    }
    return { cm, manifest };
  })();
  _loading = loading;
  loading.catch(() => { if (_loading === loading) _loading = null; });
  return loading;
}

/** Forget a load (tests). */
export function resetCodeMirrorLoader() {
  _loading = null;
  _attempt = 0;
}
