// ═══════════════════════════════════════════
// SynaBun Neural Interface — the public address: the page side
// ═══════════════════════════════════════════
//
// What the two cards that start the Cloudflare tunnel share (the Share menu's
// Connection block in ui-invite.js, Settings → Automations → Online access in
// ui-settings.js): asking the server, starting and stopping, asking again
// while something is on its way (a download, the wait for an address), and
// the reading of each answer in the page's language. What an answer means is
// tunnel-view.js; how it is drawn is each card's own.
//
// The requests are sent with fetch as they are: same origin, no body. The
// server takes a start or a stop from the app's own pages only
// (lib/http-guards.js ownerRouteGuard), and a refusal is shown in the card
// like any other failure, not as the app-wide "forbidden" notice.

import { getLocale, t } from './i18n.js';
import { tunnelView } from './tunnel-view.js';

const POLL_MS = 1000;
/** How long a card keeps asking by itself. A download or a start that takes longer is shown again on the next look. */
const POLL_LIMIT_MS = 20 * 60 * 1000;

const translate = (key, params) => t(`tunnel.${key}`, params);
function number(value, digits) {
  try { return value.toLocaleString(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }); } catch { return value.toFixed(digits); }
}

/** tunnel-view.js tunnelView() in the page's language. */
export function readTunnel(status) {
  return tunnelView(status, { t: translate, number });
}

/** The sentence a card shows where it offers the remote MCP address and no access key exists. */
export function mcpKeyNeededText() {
  return translate('mcpKeyNeeded');
}

async function ask(path, method = 'GET') {
  const res = await fetch(path, { method });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, ok: res.ok, body };
}

/**
 * One card's hold on the tunnel.
 *
 * @param {object} [o]
 * @param {(view: object, status: object | null) => void} [o.onChange] called with every new reading
 * @param {() => boolean} [o.alive] false once the card is gone: the asking-again stops
 * @returns {{ view: () => object, status: () => (object | null), show: (status: object) => object,
 *   refresh: () => Promise<object>, start: () => Promise<object>, stop: () => Promise<object>, dispose: () => void }}
 */
export function createTunnelCard({ onChange = () => {}, alive = () => true } = {}) {
  let status = null;
  let timer = null;
  let since = 0;
  let disposed = false;

  function schedule(view) {
    clearTimeout(timer);
    timer = null;
    if (disposed || !view.poll || !alive()) { since = 0; return; }
    if (!since) since = Date.now();
    if (Date.now() - since > POLL_LIMIT_MS) return;
    timer = setTimeout(refresh, POLL_MS);
  }

  /** Take an answer as the state of things, tell the card, and ask again later when it will change by itself. */
  function show(next) {
    status = next && typeof next === 'object' ? next : null;
    const view = readTunnel(status);
    if (!disposed) { try { onChange(view, status); } catch (error) { console.warn('[tunnel] The card could not be drawn:', error); } }
    schedule(view);
    return view;
  }

  async function refresh() {
    if (disposed) return readTunnel(status);
    try {
      const got = await ask('/api/tunnel/status');
      if (got.ok && got.body) return show(got.body);
    } catch { /* the server is away for a moment: what is shown stays, and the next look asks again */ }
    const view = readTunnel(status);
    schedule(view);
    return view;
  }

  /** A start or a stop that the server did not take: shown in the card, with what the card knew before. */
  function refused(got, error) {
    // A server from before the tunnel program came with SynaBun answers a start with 400 when no cloudflared is
    // installed, and its words tell the user to install one. What is missing is a restart: the card says that.
    if (got?.status === 400 && !status?.cloudflared) return show({ ok: true, available: false, running: false, starting: false, url: null });
    const failure = got?.status === 403
      ? { code: 'refused', message: got.body?.error || '' }
      : { code: 'unknown', message: got?.body?.error || error?.message || '' };
    return show({ ...(status || {}), ok: true, running: false, starting: false, url: null, state: 'failed', error: failure, cloudflared: status?.cloudflared || { state: 'missing' } });
  }

  async function send(path) {
    let got = null;
    try { got = await ask(path, 'POST'); } catch (error) { return refused(null, error); }
    if (!got.ok || got.body?.ok === false) return refused(got);
    return refresh();
  }

  return {
    view: () => readTunnel(status),
    status: () => status,
    show,
    refresh,
    start: () => send('/api/tunnel/start'),
    stop: () => send('/api/tunnel/stop'),
    dispose() { disposed = true; clearTimeout(timer); timer = null; },
  };
}

/**
 * Put new markup into a card's block without disturbing the person using it: nothing happens when the markup is
 * what is there already, and a button that had the keyboard's focus has it again afterwards (by its id).
 */
export function drawInto(container, html) {
  if (!container || container.__tunnelHtml === html) return false;
  const focused = container.contains(document.activeElement) ? document.activeElement?.id : '';
  container.innerHTML = html;
  container.__tunnelHtml = html;
  if (focused) { try { container.querySelector(`#${CSS.escape(focused)}`)?.focus({ preventScroll: true }); } catch { /* the button is gone with its state */ } }
  return true;
}
