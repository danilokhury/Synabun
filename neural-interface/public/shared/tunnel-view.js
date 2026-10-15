// ═══════════════════════════════════════════
// SynaBun Neural Interface — the public address: what the cards say
// ═══════════════════════════════════════════
//
// What the two places that start the Cloudflare tunnel show for an answer of
// GET /api/tunnel/status: the Share menu's Connection block (ui-invite.js) and
// Settings → Automations → Online access (ui-settings.js). One reading for
// both, so they never disagree: the state as a word, one sentence about it,
// the progress of a download, the action that fits, and whether to ask again.
//
// No imports and no DOM: `node --test` loads this file as it is
// (tests/tunnel-view.test.mjs). TUNNEL_COPY is the English of every sentence;
// `tunnel.*` in i18n/en.json must equal it and i18n/pt-BR.json must have the
// same keys (the test checks both). The page side is ui-tunnel.js.
//
// A server that was started before SynaBun brought its own tunnel program
// answers without the `cloudflared` part: the cards then work as they did (a
// tunnel starts when a cloudflared is installed), and where none is, they say
// that a restart is what is missing. Nothing here ever tells the user to
// install anything, except on a system Cloudflare publishes no file for.

export const TUNNEL_COPY = Object.freeze({
  stateOff: 'Off',
  stateDownloading: 'Getting the tunnel program',
  stateStarting: 'Starting',
  stateRunning: 'On',
  stateFailed: 'Did not start',
  stateUnsupported: 'Not available',
  stateRestart: 'Restart needed',
  idle: 'A public address through Cloudflare, for invite links and remote MCP.',
  idleDownload: 'A public address through Cloudflare, for invite links and remote MCP. The first start downloads the tunnel program ({size} MB).',
  downloading: 'Downloading the tunnel program: {received} of {total} MB',
  starting: 'Waiting for Cloudflare to give an address…',
  restart: 'Restart SynaBun to use the public address: the server that is running was started before it could download the tunnel program.',
  unsupported: 'Cloudflare publishes no tunnel program for this system. If you install cloudflared yourself, SynaBun uses it.',
  errorOffline: 'The tunnel program could not be downloaded: the download server was not reached. Check the connection and try again.',
  errorHttp: 'The tunnel program could not be downloaded: the download server answered with an error. Try again in a moment.',
  errorInterrupted: 'The download stopped before it was complete. Nothing was kept. Try again.',
  errorTimeout: 'The download stalled. Nothing was kept. Try again.',
  errorChecksum: 'The download was not the file SynaBun expects, so it was removed and never run. Try again; if it happens again, something on the network is changing the file.',
  errorUnpack: 'The downloaded file could not be unpacked, so it was removed. Try again.',
  errorDisk: 'The tunnel program could not be saved in SynaBun\'s data folder. Check free space and permissions, then try again.',
  errorLaunch: 'The tunnel program could not be started on this computer. Try again.',
  errorExited: 'Cloudflare gave no address. The tunnel program said: {reason}',
  errorExitedNoReason: 'The tunnel program stopped before Cloudflare gave an address. Try again.',
  errorNoAddress: 'Cloudflare gave no address in time. Try again.',
  errorEnded: 'The tunnel stopped. Start it again for a new address.',
  errorRefused: 'SynaBun refused this request. Start the tunnel from SynaBun on this computer.',
  errorUnknown: 'The tunnel did not start: {reason}',
  errorUnknownNoReason: 'The tunnel did not start. Try again.',
  start: 'Start tunnel',
  stop: 'Stop',
  cancel: 'Cancel',
  retry: 'Try again',
  copyBundled: 'cloudflared {version}, included with SynaBun',
  copyDownloaded: 'cloudflared {version}, downloaded by SynaBun',
  copySystem: 'cloudflared {version}, installed on this computer',
  copySystemWhy: 'SynaBun could not download its own copy, so the one installed on this computer is used.',
  mcpKeyNeeded: 'Remote MCP needs an access key. Create one below; the address to connect is then this one followed by /mcp/ and the key.',
});

const ERROR_COPY = Object.freeze({
  offline: 'errorOffline', http: 'errorHttp', interrupted: 'errorInterrupted', timeout: 'errorTimeout', checksum: 'errorChecksum',
  unpack: 'errorUnpack', disk: 'errorDisk', launch: 'errorLaunch', no_address: 'errorNoAddress', ended: 'errorEnded',
  unsupported: 'unsupported', refused: 'errorRefused',
});

/** A TUNNEL_COPY sentence with its `{params}` filled in: the translator when the page gives none. */
export function fillTunnelCopy(key, params = {}) {
  return String(TUNNEL_COPY[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? params[name] : whole));
}

const megabytes = (bytes) => Math.max(0, Number(bytes) || 0) / (1024 * 1024);

/**
 * What a card shows for a status.
 *
 * @param {object | null} status the answer of GET /api/tunnel/status (or of the start / stop that came last)
 * @param {object} [o]
 * @param {(key: string, params?: object) => string} [o.t] a key of TUNNEL_COPY → the sentence in the page's language
 * @param {(value: number, digits: number) => string} [o.number] a number as the page's language writes it
 * @returns {{
 *   kind: 'restart' | 'unsupported' | 'idle' | 'downloading' | 'starting' | 'running' | 'failed',
 *   tone: 'off' | 'busy' | 'ok' | 'warn' | 'err',
 *   on: boolean,
 *   label: string, detail: string,
 *   progress: { percent: number, text: string } | null,
 *   url: string | null,
 *   action: 'start' | 'stop' | 'cancel' | 'retry' | null, actionLabel: string,
 *   copy: string, copyNote: string,
 *   poll: boolean,
 * }}
 *   `on`: the switch stands on (something runs or is on its way). `action`: what a press does ("cancel" and
 *   "stop" are both POST /api/tunnel/stop; "start" and "retry" both POST /api/tunnel/start). `copy`: which
 *   cloudflared runs, when one does. `poll`: the state will change by itself, ask again.
 */
export function tunnelView(status, { t = fillTunnelCopy, number = (value, digits) => value.toFixed(digits) } = {}) {
  const s = status && typeof status === 'object' ? status : {};
  const tool = s.cloudflared && typeof s.cloudflared === 'object' ? s.cloudflared : null;
  const view = {
    kind: 'idle', tone: 'off', on: false, label: t('stateOff'), detail: t('idle'), progress: null,
    url: typeof s.url === 'string' && s.url ? s.url : null,
    action: 'start', actionLabel: t('start'), copy: '', copyNote: '', poll: false,
  };
  const as = (kind, tone, labelKey, detail, action) => Object.assign(view, {
    kind, tone, label: t(labelKey), detail, action, actionLabel: action ? t(action) : '',
    on: kind === 'downloading' || kind === 'starting' || kind === 'running', poll: kind === 'downloading' || kind === 'starting',
  });
  const running = () => {
    as('running', 'ok', 'stateRunning', view.url, 'stop');
    const source = { bundled: 'copyBundled', downloaded: 'copyDownloaded', system: 'copySystem' }[tool?.source];
    if (source && tool.version) {
      view.copy = t(source, { version: tool.version });
      if (tool.source === 'system' && tool.fallback && tool.fallback.code !== 'unsupported') view.copyNote = t('copySystemWhy');
    }
    return view;
  };

  // Nothing is known yet (the answer has not arrived): the card as it stands before a first start.
  if (!status || typeof status !== 'object') return view;

  // A server from before the tunnel program came with SynaBun: no `cloudflared` part in its answer.
  if (!tool) {
    if (view.url) return running();
    if (s.starting || s.running) return as('starting', 'busy', 'stateStarting', t('starting'), 'cancel');
    if (s.available) return as('idle', 'off', 'stateOff', t('idle'), 'start');
    return as('restart', 'warn', 'stateRestart', t('restart'), null);
  }

  const state = typeof s.state === 'string' ? s.state : 'idle';
  if (state === 'running' && view.url) return running();
  if (state === 'downloading') {
    const total = Number(tool.progress?.total) || Number(tool.download?.size) || 0;
    const received = Math.min(Number(tool.progress?.received) || 0, total || Infinity);
    const percent = total ? Math.max(0, Math.min(100, Math.floor((received / total) * 100))) : 0;
    as('downloading', 'busy', 'stateDownloading', t('downloading', { received: number(megabytes(received), 1), total: number(megabytes(total), 1) }), 'cancel');
    view.progress = { percent, text: `${percent}%` };
    return view;
  }
  if (state === 'starting' || state === 'running') return as('starting', 'busy', 'stateStarting', t('starting'), 'cancel');
  if (state === 'failed') {
    const error = s.error && typeof s.error === 'object' ? s.error : {};
    if (error.code === 'unsupported') return as('unsupported', 'off', 'stateUnsupported', t('unsupported'), null);
    const reason = typeof error.reason === 'string' && error.reason.trim() ? error.reason.trim() : '';
    let detail;
    if (error.code === 'exited') detail = reason ? t('errorExited', { reason }) : t('errorExitedNoReason');
    else if (ERROR_COPY[error.code]) detail = t(ERROR_COPY[error.code]);
    else detail = typeof error.message === 'string' && error.message.trim() ? t('errorUnknown', { reason: error.message.trim() }) : t('errorUnknownNoReason');
    return as('failed', 'err', 'stateFailed', detail, 'retry');
  }
  // idle
  if (tool.state === 'unsupported') return as('unsupported', 'off', 'stateUnsupported', t('unsupported'), null);
  if (tool.state === 'ready') return as('idle', 'off', 'stateOff', t('idle'), 'start');
  const size = Number(tool.download?.size) || 0;
  return as('idle', 'off', 'stateOff', size ? t('idleDownload', { size: number(megabytes(size), 0) }) : t('idle'), 'start');
}

/**
 * The address an assistant outside connects to, or null while there is none to give: the public address
 * followed by /mcp/ and the access key. Without a key there is no such address: the server refuses /mcp from
 * outside (lib/request-gate.js mcpWithoutKey), so the cards offer nothing to copy and say what is missing.
 */
export function remoteMcpAddress(url, key) {
  const base = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  const secret = typeof key === 'string' ? key.trim() : '';
  return base && secret ? `${base}/mcp/${secret}` : null;
}
