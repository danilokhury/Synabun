// ═══════════════════════════════════════════
// SynaBun — Desktop guards (pure)
// ═══════════════════════════════════════════
//
// Computer use is fully autonomous (no approval cards). What stays: the app
// blocklist, web browsers (guards.browserApps / browserAppPrefixes: web pages go
// through the SynaBun browser tools), protected windows and the password-field
// guard (enforced by the helper at act time, from the GuardSpec built here),
// plus NON-blocking warnings attached to tool results and the audit log:
// payment / publish / destructive targets (the browser risk lexicon),
// card-number-like typing and on-screen text that addresses the agent (prompt
// injection is data, never instructions).

const MODIFIERS = new Map([
  ['cmd', 'cmd'], ['command', 'cmd'], ['super', 'cmd'], ['meta', 'cmd'], ['win', 'cmd'],
  ['shift', 'shift'],
  ['alt', 'alt'], ['option', 'alt'], ['opt', 'alt'],
  ['ctrl', 'ctrl'], ['control', 'ctrl'],
  ['fn', 'fn'],
]);

/** "cmd+shift+t" / "ctrl+a" / "Return" → { modifiers:[...], key, printable } */
export function parseCombo(combo) {
  const parts = String(combo || '').split('+').map((part) => part.trim()).filter(Boolean);
  const modifiers = [];
  let key = null;
  for (const part of parts) {
    const mod = MODIFIERS.get(part.toLowerCase());
    if (mod) { if (!modifiers.includes(mod)) modifiers.push(mod); }
    else key = part;
  }
  const hasCommand = modifiers.includes('cmd') || modifiers.includes('ctrl');
  const single = !!key && [...key].length === 1;
  const paste = modifiers.includes('cmd') && /^v$/i.test(key || '');
  return { modifiers, key, printable: (single && !hasCommand) || paste, paste };
}

/** Modifier list for clicks (Anthropic passes held keys in `text`, e.g. "shift" or "cmd+shift"). */
export function clickModifiers(text) {
  if (!text) return [];
  return parseCombo(text).modifiers;
}

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** true when the text contains a 13-19 digit, Luhn-valid number (spaces/dashes allowed). */
export function looksLikeCardNumber(text) {
  const candidates = String(text || '').match(/\b(?:\d[ -]?){13,19}\b/g) || [];
  return candidates.some((candidate) => { const digits = candidate.replace(/\D/g, ''); return digits.length >= 13 && digits.length <= 19 && luhn(digits); });
}

/** Case-insensitive bundle-id prefix test (same as protocol.js hasBundlePrefix). */
function hasPrefix(bundleId, prefixes) {
  if (!bundleId || !Array.isArray(prefixes)) return false;
  const id = String(bundleId).toLowerCase();
  return prefixes.some((prefix) => typeof prefix === 'string' && prefix && id.startsWith(prefix.toLowerCase()));
}

export const BROWSER_RULE_ID = 'web-browsers';
export const BROWSER_RULE_REASON = 'a web browser: use the SynaBun browser tools (browser_navigate, browser_snapshot, browser_screenshot …) for web pages';

/**
 * The web browsers as one blocked-app rule, from guards.browserApps (bundle
 * ids) and guards.browserAppPrefixes (installed web apps): every click, key,
 * type, drag, scroll, AX action, open and focus whose target is one is refused
 * by the helper (BLOCKED_APP). By bundle id only: MoreLogin's profile windows
 * and its manager app share the name "MoreLogin". Null when both lists are empty.
 */
export function browserGuardRule(config = {}) {
  const guards = config.guards || {};
  const bundleIds = (Array.isArray(guards.browserApps) ? guards.browserApps : []).filter((id) => typeof id === 'string' && id);
  const bundlePrefixes = (Array.isArray(guards.browserAppPrefixes) ? guards.browserAppPrefixes : []).filter((prefix) => typeof prefix === 'string' && prefix);
  if (!bundleIds.length && !bundlePrefixes.length) return null;
  return { id: BROWSER_RULE_ID, bundleIds, bundlePrefixes, reason: BROWSER_RULE_REASON };
}

/**
 * GuardSpec for the helper's `configure` command. Protocol 2 fields pass
 * through: bundlePrefixes (both rule kinds) and appNameRe (protected windows).
 * A protected rule with neither titleRe nor appNameRe protects every window of
 * the apps it names ('.*'). The web browsers ride as the last blocked-app rule.
 */
export function guardSpec(config = {}) {
  const guards = config.guards || {};
  const list = (value) => (Array.isArray(value) ? value : []);
  const browsers = browserGuardRule(config);
  return {
    blockedApps: [
      ...list(guards.blockedApps).map((rule) => ({
        id: rule.id, bundleIds: rule.bundleIds || [], bundlePrefixes: list(rule.bundlePrefixes),
        nameRe: rule.nameRe || undefined, windowTitleRe: rule.windowTitleRe || undefined, reason: rule.reason || 'blocked',
      })),
      ...(browsers ? [browsers] : []),
    ],
    protectedWindows: list(guards.protectedWindows).map((rule) => ({
      id: rule.id, bundleIds: rule.bundleIds || [], bundlePrefixes: list(rule.bundlePrefixes),
      titleRe: rule.titleRe || (rule.appNameRe ? undefined : '.*'), appNameRe: rule.appNameRe || undefined,
      reason: rule.reason || 'protected',
    })),
    secureField: guards.secureField !== false,
    refuseWhenLocked: guards.refuseWhenLocked !== false,
  };
}

/** A web browser by bundle id (browserGuardRule), else false. */
export function isBrowserBundle(config = {}, bundleId = null) {
  const rule = bundleId ? browserGuardRule(config) : null;
  if (!rule) return false;
  const id = String(bundleId).toLowerCase();
  return rule.bundleIds.some((b) => b.toLowerCase() === id) || hasPrefix(id, rule.bundlePrefixes);
}

/**
 * Node-side mirror of the helper's app blocklist (open/focus requests are
 * refused before reaching it). The web browsers match by bundle id only; a
 * name ("Google Chrome") is refused by the helper once it resolves the app.
 */
export function blockedAppRule(config = {}, { bundleId = null, name = null } = {}) {
  const appName = name == null ? null : String(name).normalize('NFC');
  for (const rule of config.guards?.blockedApps || []) {
    if (bundleId && (rule.bundleIds || []).some((id) => id.toLowerCase() === String(bundleId).toLowerCase())) return rule;
    if (bundleId && hasPrefix(bundleId, rule.bundlePrefixes)) return rule;
    if (appName && rule.nameRe) { try { if (new RegExp(String(rule.nameRe).normalize('NFC'), 'i').test(appName)) return rule; } catch {} }
    if (appName && (rule.bundleIds || []).some((id) => id.toLowerCase().endsWith(`.${appName.toLowerCase().replace(/\s+/g, '')}`))) return rule;
  }
  return isBrowserBundle(config, bundleId) ? browserGuardRule(config) : null;
}

function targetLabel(probe = {}) {
  return [probe.title, probe.description, probe.valuePreview, probe.role === 'AXButton' ? 'button' : null].filter(Boolean).join(' ').slice(0, 200);
}

/**
 * Non-blocking warnings for one action.
 * @param {object} ctx { action, text, probe, config, lexicon: { lexiconClass, addressesAgent } }
 */
export function actionWarnings({ action = '', text = '', probe = null, config = {}, lexicon = null } = {}) {
  const warnings = [];
  const guards = config.guards || {};
  if (guards.moneyWarnings !== false) {
    if ((action === 'type' || action === 'key') && looksLikeCardNumber(text)) {
      warnings.push({ kind: 'card-number', label: 'The typed text looks like a card number. Only continue if the user explicitly asked for this payment.' });
    }
    const label = probe ? targetLabel(probe) : '';
    if (label && lexicon?.lexiconClass) {
      let cls = null;
      try { cls = lexicon.lexiconClass(label); } catch {}
      if (cls === 'payment') warnings.push({ kind: 'payment', label: `"${label.slice(0, 60)}" looks like a payment control. Never spend money unless the user explicitly asked.` });
      else if (cls === 'publish') warnings.push({ kind: 'publish', label: `"${label.slice(0, 60)}" looks like a publish/send control. Make sure the user asked for this.` });
      else if (cls === 'destructive') warnings.push({ kind: 'destructive', label: `"${label.slice(0, 60)}" looks destructive (delete/remove). Make sure the user asked for this.` });
    }
  }
  return warnings;
}

/** Flag accessibility text that addresses the agent (prompt injection). */
export function addressesAgentText(text, lexicon = null) {
  if (!text || !lexicon?.addressesAgent) return false;
  try { return !!lexicon.addressesAgent(String(text)); } catch { return false; }
}
