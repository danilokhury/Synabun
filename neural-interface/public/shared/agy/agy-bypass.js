// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: a tab's Bypass (no DOM)
// ═══════════════════════════════════════════
//
// Bypass is a tab's choice, like the Claude Code panel's: off by default, turned on only by the owner in the
// permissions picker (after one confirm each time), saved with the tab, and stated to the bridge with every session
// the tab opens (`bypass` on session:new / load / resume) and at once for a running one (session:bypass). The bridge
// answers each permission request of that session "allow once" itself, except what SynaBun's hard rails refuse
// (lib/antigravity/bypass.js: the browser policy and the protected folders). A server without the `bypass`
// capability cannot run it: the pick waits there, shown as unavailable, and the tab asks as before.

export const PERMISSION_DEFAULT = 'default';
export const PERMISSION_BYPASS = 'bypass';

/** The permissions picker of a tab: its entries, the state the control is styled by and its tooltip. */
export function bypassControl({ bypass = false, supported = true } = {}, T = (key) => key) {
  const on = bypass === true;
  const entries = [
    { value: PERMISSION_DEFAULT, label: T('permDefault'), title: T('permDefaultHint'), selected: !on },
    { value: PERMISSION_BYPASS, label: T('permBypass'), title: supported ? T('permBypassHint') : T('permBypassRestart'), selected: on, disabled: !supported && !on },
  ];
  if (on && !supported) return { entries, state: 'bypass', waiting: true, title: T('permBypassWaiting') };
  if (on) return { entries, state: 'bypass', waiting: false, title: T('permBypassOnTitle') };
  return { entries, state: '', waiting: false, title: supported ? T('permDefaultHint') : T('permBypassRestart') };
}

/** What a pick in the picker does: { confirm: true } to ask first, { set: boolean } to apply, or null for no change. */
export function pickPermission(value, { bypass = false, supported = true } = {}) {
  const want = value === PERMISSION_BYPASS;
  if (want === (bypass === true)) return null;
  if (want && !supported) return null;
  return want ? { confirm: true } : { set: false };
}

/** A saved tab's Bypass: only a literal true counts (anything else in storage is off). */
export function restoredBypass(value) {
  return value === true;
}

/** A permission:auto event as one transcript row: { severity, text }. */
export function autoAnswerRow(message, T = (key) => key) {
  const tool = String(message?.toolCall?.title || message?.toolCall?.kind || T('permTool')).slice(0, 160);
  if (message?.decision === 'refused') {
    return { severity: 'error', text: T('permAutoRefused', { tool, reason: String(message.reason || '').slice(0, 400) }) };
  }
  return { severity: 'info', text: T('permAutoAllowed', { tool }) };
}
