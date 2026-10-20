// ═══════════════════════════════════════════
// SynaBun — Admin sandbox: what it means for each agent (pure)
// ═══════════════════════════════════════════
//
// One global setting (lib/agent-sandbox-setting.js, the Assistant's permission
// menu) decides whether an agent SynaBun starts may use a sandbox whose setup
// needs Windows administrator approval (a UAC prompt). Off is the default:
// then nothing SynaBun starts can ask for one. Each provider says here what
// the setting means for it; a launcher asks this module and never decides by
// itself. A provider SynaBun can start must have an entry
// (tests/agent-sandbox-elevation.test.mjs fails otherwise).
//
// The setting never changes a provider's sandbox policy (read-only,
// workspace-write, full access): only which implementation of it may need an
// administrator. It is a launch override, never written into a config file.

export const ADMIN_SANDBOX_DEFAULT = false;

const CODEX_SETTING = 'windows.sandbox';

export const SANDBOX_ELEVATION = Object.freeze({
  // `windows.sandbox` (Codex 0.163: "elevated" | "unelevated" | "mxc"): "elevated"
  // provisions two local sandbox accounts with codex-windows-sandbox-setup.exe, a
  // UAC prompt once per CODEX_HOME (SynaBun's accounts each have one);
  // "unelevated" is Codex's restricted-token sandbox: no administrator, weaker isolation.
  codex: Object.freeze({
    changes: true,
    setting: CODEX_SETTING,
    off: 'unelevated',
    on: 'elevated',
    reason: 'Codex picks its Windows sandbox with windows.sandbox: "elevated" needs a one-time administrator setup per account, "unelevated" needs none.',
  }),
  // Claude Code 2.1.303 has a Windows sandbox whose one-time install asks for
  // administrator approval, but only `claude sandbox install` or `/sandbox install`
  // starts it: a session never does, and SynaBun never runs either command.
  'claude-code': Object.freeze({
    changes: false,
    reason: 'Claude Code installs its Windows sandbox only through `claude sandbox install` or `/sandbox install`, which SynaBun never runs; a session never asks for administrator approval by itself.',
  }),
  // OpenCode has no operating-system sandbox: permission rules only (its
  // "sandboxes" are worktree folders).
  opencode: Object.freeze({
    changes: false,
    reason: 'OpenCode has no operating-system sandbox, only permission rules, so nothing it starts needs administrator approval.',
  }),
});

/** Only `true` turns it on: anything else (missing, a string, null) is the default, off. */
export function normalizeAdminSandbox(value) {
  return value === true;
}

/** Providers the setting changes (['codex']): what the panel's copy may name. */
export function adminSandboxProviders() {
  return Object.keys(SANDBOX_ELEVATION).filter((provider) => SANDBOX_ELEVATION[provider].changes);
}

/**
 * What a launcher of `provider` adds for the setting: `args` (CLI words, before
 * the subcommand or anywhere an override is taken), `config` (the same as an
 * SDK config object) and `value`. A provider the setting does not change gets
 * nothing to add and its reason. An unknown provider throws: it must declare
 * its mapping in SANDBOX_ELEVATION first.
 */
export function sandboxElevationFor(provider, adminSandbox) {
  const entry = SANDBOX_ELEVATION[provider];
  if (!entry) throw new Error(`No admin sandbox mapping for provider "${provider}": add it to SANDBOX_ELEVATION.`);
  const on = normalizeAdminSandbox(adminSandbox);
  if (!entry.changes) return { provider, changes: false, adminSandbox: on, value: null, args: [], config: {}, reason: entry.reason };
  const value = on ? entry.on : entry.off;
  return { provider, changes: true, adminSandbox: on, value, args: ['-c', `${entry.setting}=${JSON.stringify(value)}`], config: configAt(entry.setting, value), reason: entry.reason };
}

function configAt(dotted, value) {
  const keys = dotted.split('.');
  const out = {};
  let node = out;
  keys.forEach((key, index) => { node[key] = index === keys.length - 1 ? value : {}; node = node[key]; });
  return out;
}

/** 'elevated' when the setting is on, else 'unelevated'. */
export function codexWindowsSandbox(adminSandbox) {
  return sandboxElevationFor('codex', adminSandbox).value;
}

/** ['-c', 'windows.sandbox="unelevated"'] (or "elevated"): a Codex launch override. */
export function codexWindowsSandboxArgs(adminSandbox) {
  return sandboxElevationFor('codex', adminSandbox).args;
}

/** { windows: { sandbox: 'unelevated' } } (or 'elevated'): the same for the Codex SDK's `config`. */
export function codexWindowsSandboxConfig(adminSandbox) {
  return sandboxElevationFor('codex', adminSandbox).config;
}

/**
 * A Codex process that runs no command and no turn (a probe in a throwaway
 * home: hooks, settings schema, feature switches) needs no sandbox at all: it
 * is always started with the one that needs no administrator, whatever the setting.
 */
export const CODEX_PROBE_SANDBOX_ARGS = Object.freeze([...codexWindowsSandboxArgs(false)]);
