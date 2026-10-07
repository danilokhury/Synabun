// ═══════════════════════════════════════════
// SETTINGS — SynaBun rules, in words
// ═══════════════════════════════════════════
//
// What the rules status (GET /api/setup/rules, lib/rulesets/installer.js) says about a tool: the name of its
// state, the action that state calls for, the sentence next to it, and what an install answered. Pure: no DOM
// and no import, so node runs it (tests/rulesets-rules-view.test.mjs).
//
// Two surfaces render the status, Settings → AI connections (ui-settings.js) and the onboarding wizard
// (onboarding.html). Both ask this module, so a state reads the same and offers the same action in both.
//
//   describeRulesHost(info, { label, version, tx })     one tool: badge, path, action, note
//   describeRulesInstall(result, state, { label, tx })  what Install / Update / Replace answered
//   describeRulesInstallAll(result, { tx, labels })     what "install for all" answered, and where the rules live
//   rulesInstallPlan(status)                            what "install for all" would find to do
//   describeRulesInPlace(status, { tx, labels })        the same report for rules that are already there
//   catalogueTranslator(messages)                       `tx` for a page that does not run the app's i18n
//
// `tx(key, params)` is the caller's translate function over the settings.redesign.setup.* strings (the kit's
// `tx` in Settings; the wizard reads the same catalogue, i18n/en.json).

/** The tools SynaBun installs rules for, in the order both surfaces list them. Cursor is copy-only. */
export const RULES_INSTALL_HOSTS = Object.freeze(['claude', 'gemini', 'codex', 'opencode']);

export const RULES_HOST_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini', cursor: 'Cursor', coexistence: 'coexistence' });

/** The states that count as "the rules are in place". `shadowed` is installed too, only not loaded (Codex's override file). */
export const RULES_IN_PLACE = Object.freeze(['installed', 'newer', 'shadowed']);

/**
 * One tool's rules as both surfaces show them.
 *
 * `info` is `status.hosts[host]`, or nothing when the status could not be read (a server that was not restarted
 * after the update answers 404): then the badge says "Unavailable", the path line says what to do and no action
 * is offered, because none could work.
 *
 * @returns {{ known: boolean, state: string, badge: string, good: boolean, path: string, pathText: string,
 *   action: ''|'install'|'update'|'replace', actionLabel: string, force: boolean, removable: boolean, note: string }}
 */
export function describeRulesHost(info, { label, version = null, tx }) {
  if (!info) {
    return {
      known: false, state: '', badge: tx('settings.redesign.setup.unavailable'), good: false, path: '',
      pathText: tx('settings.redesign.setup.restartSynabunToFinishThisUpdate'), action: '', actionLabel: '', force: false, removable: false, note: '',
    };
  }
  const badges = {
    installed: [tx('settings.redesign.setup.installed'), true], newer: [tx('settings.redesign.setup.newer'), true], outdated: [tx('settings.redesign.setup.updateAvailable'), false], modified: [tx('settings.redesign.setup.edited2'), false],
    conflict: [tx('settings.redesign.setup.conflict'), false], error: [tx('settings.redesign.setup.error'), false], shadowed: [tx('settings.redesign.setup.shadowed'), false],
    'not-installed': [tx('settings.redesign.setup.notInstalled'), false], manual: [tx('settings.redesign.setup.copyOnly'), false],
  };
  const [badge, good] = badges[info.state] || [info.state || tx('settings.redesign.setup.unknown'), false];
  // The action the state calls for; conflict, error and shadowed only explain themselves.
  const actions = { 'not-installed': ['install', tx('settings.redesign.setup.install')], outdated: ['update', tx('settings.redesign.setup.update')], modified: ['replace', tx('settings.redesign.setup.replace')] };
  const [action, actionLabel] = info.detected === false ? ['', ''] : (actions[info.state] || ['', '']);
  // A file without SynaBun's markers is the user's own: the server refuses to replace it, so no button.
  const canAct = !!action && info.replaceable !== false;
  // An edited copy is the user's: nothing replaces or removes it without the confirm behind each button.
  const editedNote = tx('settings.redesign.setup.thisCopyWasEditedSoSynabun');
  const stateNote = info.detected === false ? tx('settings.redesign.setup.wasNotFoundOnThisMachine', { label })
    : info.state === 'modified' ? (info.replaceable === false ? (info.detail || '') : editedNote)
    : info.state === 'outdated' ? (version ? tx('settings.redesign.setup.versionOfTheRulesIsAvailable', { version }) : tx('settings.redesign.setup.aNewerVersionOfTheRules'))
    : ['conflict', 'error', 'shadowed', 'newer'].includes(info.state) ? (info.error || info.detail || '')
    : '';
  // A removal that could not finish left rules behind: say which, until a remove or an install completes.
  const partial = info.partialRemoval?.error ? tx('settings.redesign.setup.theLastRemovalDidNotFinish', { error: info.partialRemoval.error }) : '';
  const note = partial && stateNote && !partial.includes(stateNote) ? `${partial} ${stateNote}` : (partial || stateNote);
  return {
    known: true,
    state: info.state || '',
    badge,
    good,
    path: info.path || '',
    pathText: info.installedVersion ? `${info.path} (v${info.installedVersion})` : (info.path || ''),
    action: canAct ? action : '',
    actionLabel: canAct ? actionLabel : '',
    // Replace sends force, and only after the confirm that says the edited copy is backed up first.
    force: canAct && action === 'replace',
    removable: ['installed', 'newer', 'outdated', 'modified', 'shadowed'].includes(info.state),
    note,
  };
}

/** The sentence for what one tool's Install, Update or Replace answered. `state` is what the tool was in before. */
export function describeRulesInstall(result, state, { label, tx }) {
  if (!result?.changed) return tx('settings.redesign.setup.rulesAreAlreadyCurrent', { label });
  return tx(state === 'not-installed' ? 'settings.redesign.setup.rulesInstalled2' : 'settings.redesign.setup.rulesUpdated2', { label });
}

/**
 * What "install for all" answered: `message` is the result in one sentence, `note` says which file each tool
 * reads ('' when nothing was written or found), `failed` lists the tools that were refused.
 * The rules are global, so a project's own CLAUDE.md and AGENTS.md stay as they are; the note says so.
 */
export function describeRulesInstallAll(result, { tx, labels = RULES_HOST_LABELS }) {
  const name = (host) => labels[host] || RULES_HOST_LABELS[host] || host;
  const rows = Object.entries(result?.results || {});
  if (!rows.length) return { message: tx('settings.redesign.setup.noConnectedToolNeedsRules'), note: '', failed: [] };
  const where = rows.filter(([, row]) => row.ok !== false && row.path).map(([host, row]) => `${name(host)}: ${row.path}`).join(' · ');
  const note = where ? tx('settings.redesign.setup.rulesInstalledAt', { where }) : '';
  const failed = rows.filter(([, row]) => row.ok === false);
  if (failed.length) {
    return {
      message: tx('settings.redesign.setup.installedWithFailure', { count: rows.length - failed.length, host: name(failed[0][0]), error: failed[0][1].error || failed[0][1].state }),
      note,
      failed: failed.map(([host]) => host),
    };
  }
  const map = rows.map(([host]) => name(host)).join(', ');
  return { message: tx(rows.some(([, row]) => row.changed) ? 'settings.redesign.setup.rulesInstalledFor' : 'settings.redesign.setup.rulesAlreadyCurrentFor', { map }), note, failed: [] };
}

/**
 * What "install for all" would find to do, by the installer's own rule (installAll in lib/rulesets/installer.js):
 * it takes a tool that is on this machine, connected to SynaBun (or already managed), not opted out and not in
 * the middle of a removal.
 *
 *   pending    tools it would install or update
 *   inPlace    tools whose rules are there already
 *   attention  tools it would be refused for (an edited copy, damaged markers, an error): each needs its own answer
 *   skipped    connected tools it leaves alone because the user took their rules out
 *   connected  every tool above
 */
export function rulesInstallPlan(status) {
  const plan = { pending: [], inPlace: [], attention: [], skipped: [], connected: [] };
  for (const host of RULES_INSTALL_HOSTS) {
    const info = status?.hosts?.[host];
    if (!info || info.detected === false) continue;
    if (info.managed !== true && info.mcp !== true) continue;
    plan.connected.push(host);
    if (RULES_IN_PLACE.includes(info.state)) plan.inPlace.push(host);
    else if (info.managed === false || info.partialRemoval) plan.skipped.push(host);
    else if (info.state === 'not-installed' || info.state === 'outdated') plan.pending.push(host);
    else plan.attention.push(host);
  }
  return plan;
}

/**
 * The same report for rules that are in place already: the wizard reaches its rules step after its own toggles
 * installed them, and says what Settings says after "install for all". Null when no connected tool has rules.
 */
export function describeRulesInPlace(status, { tx, labels = RULES_HOST_LABELS }) {
  const results = {};
  for (const host of rulesInstallPlan(status).inPlace) results[host] = { ok: true, changed: true, path: status.hosts[host].path };
  return Object.keys(results).length ? describeRulesInstallAll({ results }, { tx, labels }) : null;
}

/**
 * `tx` over a loaded catalogue (the parsed i18n/en.json), for a page that does not run the app's i18n: the
 * onboarding wizard is English only and must not wait for the app's storage. Same rules as t() in i18n.js:
 * a missing key comes back as the key, `{name}` is filled from `params`.
 */
export function catalogueTranslator(messages) {
  return (key, params) => {
    const value = String(key).split('.').reduce((node, part) => node?.[part], messages);
    if (typeof value !== 'string') return key;
    return params ? value.replace(/\{(\w+)\}/g, (_, name) => (params[name] != null ? params[name] : `{${name}}`)) : value;
  };
}
