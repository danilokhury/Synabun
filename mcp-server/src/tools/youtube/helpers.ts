/**
 * YouTube Studio — shared helpers.
 *
 * Studio (studio.youtube.com) is a Polymer / web-component app with heavy
 * shadow DOM, so these tools prefer Playwright-native interactions
 * (ni.click/fill/type/upload — Playwright's CSS engine pierces open shadow
 * roots) over raw `document.querySelector` walking. Selectors favour stable,
 * locale-independent Studio ids (`#create-icon`, `#title-textarea`,
 * `#next-button`, `#done-button`, `tp-yt-paper-radio-button[name="PUBLIC"]`)
 * with a `textHint` fallback for auto-heal.
 */

import * as ni from '../../services/neural-interface.js';

export const STUDIO_BASE = 'https://studio.youtube.com';
export const WATCH_BASE = 'https://www.youtube.com';

export type Resolved = { sessionId: string; tabId?: string };

export async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function resolve(
  sessionId?: string,
  tabId?: string,
  autoCreate = true,
): Promise<Resolved | { error: string }> {
  const r = await ni.resolveSession(sessionId, autoCreate ? { url: STUDIO_BASE } : undefined, tabId);
  if ('error' in r) return r;
  return { sessionId: r.sessionId, tabId: r.tabId };
}

/** Returns an error string if the session is bounced to a Google sign-in page. */
export async function ensureAuth(r: Resolved): Promise<string | null> {
  const res = await ni.evaluate(r.sessionId, `location.href`, r.tabId);
  const url = String(res.result || '');
  if (/accounts\.google\.com|\/signin|ServiceLogin/i.test(url)) {
    return 'Not authenticated. Sign into the YouTube/Google account that owns the channel in the open browser panel, then retry.';
  }
  return null;
}

/**
 * Poll a JS predicate every `interval` ms until truthy. `script` MUST evaluate
 * to a JSON-serializable value; truthy → success, falsy → keep polling.
 */
export async function pollFor<T = unknown>(
  r: Resolved,
  script: string,
  timeoutMs = 30000,
  interval = 400,
): Promise<T | null> {
  const start = Date.now();
  let last: T | null = null;
  while (Date.now() - start < timeoutMs) {
    const res = await ni.evaluate(r.sessionId, script, r.tabId);
    if (!res.error) {
      const v = res.result as T;
      if (v) return v;
      last = v;
    }
    await wait(interval);
  }
  return last;
}

/** Navigate with a one-time retry when the same browser session remains usable. */
export async function safeNavigate(
  r: Resolved,
  url: string,
): Promise<{ error?: string; sessionInvalidated?: boolean }> {
  let res = await ni.navigate(r.sessionId, url, r.tabId);
  if (res.error && !res.sessionInvalidated && /Timeout/i.test(res.error)) {
    await wait(600);
    res = await ni.navigate(r.sessionId, url, r.tabId);
  }
  return res;
}

/**
 * Shadow-DOM-piercing text reader. Returns the visible text of the whole
 * document (including open shadow roots) — used by pollFor predicates to detect
 * Studio state transitions ("Upload complete", "Checks complete", etc.) that a
 * plain `document.body.innerText` misses inside web components.
 */
export const DEEP_TEXT_SCRIPT = `(() => {
  const out = [];
  const walk = (root) => {
    if (!root) return;
    const els = root.querySelectorAll('*');
    for (const el of els) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
    const t = root.textContent;
    if (t) out.push(t);
  };
  try { walk(document); } catch {}
  return (document.body ? document.body.innerText : '') + ' ' + out.join(' ');
})()`;

/** Click a Studio element by Playwright selector, with a textHint auto-heal fallback. */
export async function clickStudio(
  r: Resolved,
  selector: string,
  textHint?: string,
  nthMatch?: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await ni.click(r.sessionId, selector, nthMatch, r.tabId, textHint);
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

/**
 * Fill a Studio text field. Playwright `fill` works on inputs, textareas AND
 * `[contenteditable]` (Studio title/description are contenteditable `#textbox`
 * nodes), clearing first. Falls back to click+type if fill rejects.
 */
export async function fillStudio(
  r: Resolved,
  selector: string,
  value: string,
  textHint?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await ni.fill(r.sessionId, selector, value, undefined, r.tabId, textHint);
  if (!res.error) return { ok: true };
  // Fallback: focus then type (some contenteditable wrappers reject fill()).
  const click = await ni.click(r.sessionId, selector, undefined, r.tabId, textHint);
  if (click.error) return { ok: false, error: res.error };
  const typed = await ni.type(r.sessionId, selector, value, undefined, r.tabId, textHint, 'insert');
  if (typed.error) return { ok: false, error: typed.error };
  return { ok: true };
}

/** Read the current video id from a Studio /video/<id>/edit URL, if present. */
export async function currentVideoId(r: Resolved): Promise<string | null> {
  const res = await ni.evaluate(
    r.sessionId,
    `(() => { const m = location.href.match(/\\/video\\/([A-Za-z0-9_-]{6,})\\//); return m ? m[1] : null; })()`,
    r.tabId,
  );
  if (res.error) return null;
  return (res.result as string | null) || null;
}

/**
 * Fallback video-id resolver: open the Studio content grid (newest upload first)
 * and return the top item's video id, piercing Studio's shadow DOM. Used by
 * youtube_upload when the post-publish share dialog doesn't expose the id — right
 * after an upload the just-published video is the most recent row, so the top id
 * is it. Navigates away from the upload dialog, so only call once publishing is
 * confirmed complete.
 */
export async function resolveLatestUploadedVideoId(r: Resolved): Promise<string | null> {
  const cidRes = await ni.evaluate(
    r.sessionId,
    `(() => { const m = location.href.match(/\\/channel\\/(UC[\\w-]+)/); return m ? m[1] : null; })()`,
    r.tabId,
  );
  const cid = (cidRes.result as string | null) || null;
  const url = cid ? `${STUDIO_BASE}/channel/${cid}/videos/upload` : `${STUDIO_BASE}/channel/videos/upload`;
  const nav = await safeNavigate(r, url);
  if (nav.error) return null;
  // Poll briefly — the grid lazy-loads.
  return await pollFor<string>(
    r,
    `(() => {
      const ids = [];
      const walk = (root) => {
        if (!root) return;
        root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
        root.querySelectorAll('a[href*="/video/"]').forEach((a) => {
          const m = (a.getAttribute('href') || '').match(/\\/video\\/([A-Za-z0-9_-]{6,})\\//);
          if (m) ids.push(m[1]);
        });
      };
      try { walk(document); } catch {}
      return ids[0] || null;
    })()`,
    8000,
    600,
  );
}
