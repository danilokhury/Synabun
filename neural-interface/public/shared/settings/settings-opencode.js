// ═══════════════════════════════════════════
// SETTINGS — the OpenCode SynaBun found, in words
// ═══════════════════════════════════════════
//
// What `GET /api/opencode/status` (`installed`, server.js opencodeInstallState) and
// `POST /api/cli/detect/opencode` (`support`) say about the OpenCode binary: which version it is,
// or why SynaBun does not drive it and how to get OpenCode 2. The server decides
// (lib/opencode-protocol.js opencodeSupportFor gives `code`); the page words it in its own
// language. Pure: no DOM and no imports, so node runs it (tests/settings-opencode-view.test.mjs).
//
//   describeOpencodeInstall(installed, { th, tx })   → { tone, status, html, text }
//
// `installed` is `{ installed, version, supported, code, path, minimum, commands }`: `supported`
// is true for a version SynaBun drives, false for one it refuses (`code` says why: 'opencode1',
// 'outdated', 'newer'), null while the version is not known (a command line, a version that could
// not be read: the serve's own answer decides when it starts). `th(key, html)` and `tx(key, params)`
// are the kit's: `th` escapes the string and puts raw HTML in its `{names}` (every value here is
// escaped first), `tx` gives the plain text, for a toast.

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const code = (text) => `<code class="stg-code">${esc(text)}</code>`;

// Written out whole, so the key checks find every one (tests/settings-ia.test.mjs, build_en.py --used).
const REFUSAL_KEYS = {
  opencode1: 'settings.redesign.opencode.refusal.opencode1',
  outdated: 'settings.redesign.opencode.refusal.outdated',
  newer: 'settings.redesign.opencode.refusal.newer',
};
const UPDATE_COMMAND = 'opencode upgrade';

/** "2.1.4" from "opencode v2.1.4" (a prerelease kept whole), as the server's own sentence shows it. */
export function shownOpencodeVersion(version) {
  return String(version ?? '').trim().replace(/^opencode\s+/i, '').replace(/^v(?=\d)/i, '');
}

function commandList(commands) {
  return (Array.isArray(commands) ? commands : []).map((command) => String(command ?? '').trim()).filter(Boolean);
}

/** The install commands as one phrase: `a`, or `a or b` (each its own <code> in the HTML). */
export function opencodeCommandsPhrase(commands, { th, tx }) {
  const list = commandList(commands);
  const join = (words, wrap, translate) => words.slice(1).reduce(
    (phrase, command) => translate('settings.redesign.opencode.commandOr', { first: phrase, second: wrap(command) }),
    wrap(words[0]),
  );
  if (!list.length) return { html: '', text: '' };
  return { html: join(list, code, th), text: join(list, (command) => command, tx) };
}

/**
 * The note under the OpenCode service bar: `tone` '' | 'ok' | 'warn', `status` the short word for
 * the status bar when OpenCode cannot run ('notInstalled' | 'notSupported' | null), `html` the note
 * (empty: no note), `text` the same sentence as plain text.
 */
export function describeOpencodeInstall(installed, { th, tx }) {
  const none = { tone: '', status: null, html: '', text: '' };
  if (!installed || typeof installed !== 'object') return none;
  const commands = opencodeCommandsPhrase(installed.commands, { th, tx });
  if (installed.installed === false) {
    return {
      tone: 'warn',
      status: 'notInstalled',
      html: th('settings.redesign.opencode.notInstalled', { commands: commands.html }),
      text: tx('settings.redesign.opencode.notInstalled', { commands: commands.text }),
    };
  }
  const version = shownOpencodeVersion(installed.version);
  const path = String(installed.path || 'opencode');
  if (installed.supported === false && REFUSAL_KEYS[installed.code]) {
    const key = REFUSAL_KEYS[installed.code];
    const minimum = String(installed.minimum || '');
    return {
      tone: 'warn',
      status: 'notSupported',
      html: th(key, { path: code(path), version: esc(version), commands: commands.html, update: code(UPDATE_COMMAND), minimum: esc(minimum) }),
      text: tx(key, { path, version, commands: commands.text, update: UPDATE_COMMAND, minimum }),
    };
  }
  if (installed.supported === true && version) {
    return {
      tone: 'ok',
      status: null,
      html: th('settings.redesign.opencode.installedVersion', { version: esc(version), path: code(path) }),
      text: tx('settings.redesign.opencode.installedVersion', { version, path }),
    };
  }
  return none;
}
