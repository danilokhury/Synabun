import test from 'node:test';
import assert from 'node:assert/strict';
import {
  waView, formatCountdown, levelLabel, TAB_STATES, ERROR_TEXT, INSTALL_ERRORS, LOGOUT_TEXT, MODE_CARDS, LEVEL_CARDS, COMMANDS, HELP, STAGE_TEXT,
  chooseNote, connectorSize,
} from '../public/shared/whatsapp/wa-view.js';

const NOW = 1_700_000_000_000;
const SAMPLES = {
  unavailable: [{}, { reason: 'env' }, { reason: 'starting' }, { reason: 'error' }],
  not_installed: [{}],
  installing: [{ stage: 'checking' }, { stage: 'downloading', connector: { approxSizeMB: 29 } }, { stage: 'verifying' }, { stage: 'activating' }],
  install_failed: Object.keys(INSTALL_ERRORS).map((code) => ({ code })),
  ready: [{}],
  linking: [{ method: 'qr', phase: 'starting' }, { method: 'qr', phase: 'waiting' }, { method: 'code', phase: 'waiting' }, { method: 'qr', phase: 'scanned' }],
  link_expired: [{}],
  confirm_owner: [{ confirm: { kind: 'self', expiresAt: NOW + 600_000 }, account: { masked: '••••1234', name: 'Ana' } }, { mode: 'dedicated', confirm: { kind: 'code' } }],
  connected: [{ mode: 'self', level: 'ask', account: { masked: '••••1234', name: 'Ana' } }, { mode: 'dedicated', level: 'autonomous', levelExpiresAt: NOW + 3600e3 }],
  reconnecting: [{ connection: { attempt: 2, nextRetryAt: NOW + 5000 } }, {}],
  paused: [{ pausedBy: 'desktop', enabled: true }, { pausedBy: 'phone', enabled: true }, { enabled: false }],
  logged_out: [{ reason: 'removed' }, { reason: 'inactive' }, { reason: 'banned' }],
  error: [...Object.keys(ERROR_TEXT).map((code) => ({ code })), { code: 'SOMETHING_NEW' }],
};

test('every tab state has a complete view', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...TAB_STATES].sort());
  for (const [state, variants] of Object.entries(SAMPLES)) {
    for (const extra of variants) {
      const v = waView({ ok: true, state, ...extra }, { now: NOW });
      const label = `${state} ${JSON.stringify(extra)}`;
      assert.ok(['ok', 'warn', 'err', 'dim'].includes(v.dot), label);
      assert.ok(typeof v.title === 'string' && v.title.length > 2, label);
      assert.ok(typeof v.sub === 'string' && v.sub.length > 2, label);
      assert.ok(typeof v.pane === 'string' && v.pane, label);
      assert.ok(['connected', 'disconnected'].includes(v.nav), label);
      for (const b of [v.primary, v.secondary]) if (b !== null) assert.ok(b.id && b.label, label);
      assert.doesNotMatch(`${v.title} ${v.sub} ${v.primary?.label || ''} ${v.secondary?.label || ''}`, /undefined|null|NaN|\[object/, label);
    }
  }
});

test('the states that matter read right', () => {
  const connected = waView({ state: 'connected', mode: 'self', level: 'ask', account: { masked: '••••1234', name: 'Ana' } }, { now: NOW });
  assert.deepEqual([connected.dot, connected.nav, connected.primary.id, connected.pane], ['ok', 'connected', 'open-conversation', 'connected']);
  assert.equal(connected.sub, 'Message yourself · Ana · ••••1234 · Ask on my phone');
  assert.match(waView({ state: 'connected', mode: 'dedicated', level: 'autonomous', levelExpiresAt: NOW + 3600e3 }, { now: NOW }).sub, /^Second number · Autonomous until \d\d:\d\d$/);
  assert.equal(waView({ state: 'not_installed' }).primary.id, 'setup');
  assert.equal(waView({ state: 'linking', method: 'qr', phase: 'waiting' }).pane, 'qr');
  assert.equal(waView({ state: 'linking', method: 'code', phase: 'waiting' }).pane, 'code');
  const self = waView({ state: 'confirm_owner', confirm: { kind: 'self', expiresAt: NOW + 125_000 }, account: { masked: '••••1234', name: 'Ana' } }, { now: NOW });
  assert.deepEqual([self.primary.label, self.secondary.label, self.pane], ['This is me — start', 'Not me? Unlink', 'confirm_self']);
  assert.match(self.sub, /Linked as Ana · ••••1234\. Confirm within 2:05/);
  assert.equal(waView({ state: 'confirm_owner', mode: 'dedicated', confirm: { kind: 'code' } }).pane, 'claim');
  assert.equal(waView({ state: 'logged_out', reason: 'banned' }).primary, null);
  assert.equal(waView({ state: 'logged_out', reason: 'removed' }).primary.id, 'relink');
  assert.equal(waView({ state: 'error', code: 'OWNER_ANOMALY', mode: 'dedicated' }).primary.id, 'reset-owner');
  assert.equal(waView({ state: 'error', code: 'OWNER_ANOMALY', mode: 'self' }).primary.id, 'unlink', 'self mode has no owner reset');
  assert.match(waView({ state: 'reconnecting', connection: { attempt: 3, nextRetryAt: NOW + 65_000 } }, { now: NOW }).sub, /Attempt 3; trying again in 1:05/);
  assert.match(waView({ state: 'installing', stage: 'downloading', connector: { approxSizeMB: 29 } }).sub, /about 29 MB/);
  assert.equal(waView({ state: 'install_failed', code: 'NPM_NOT_FOUND' }).sub, INSTALL_ERRORS.NPM_NOT_FOUND);
  assert.equal(waView(null).pane, 'loading');
  assert.equal(waView({ ok: false, status: 404 }).pane, 'unavailable');
  // While the server boots (server.js answers GET /status itself) the tab says so instead of "turned off".
  assert.equal(waView({ state: 'unavailable', reason: 'starting' }).title, 'WhatsApp is starting');
  assert.equal(waView({ state: 'unavailable', reason: 'error' }).dot, 'err');
  assert.match(waView({ state: 'unavailable', reason: 'env' }).sub, /SYNABUN_WHATSAPP=off/);
  // A pairing name of "~" (Baileys' placeholder) is not a name.
  assert.equal(waView({ state: 'connected', account: { masked: '••••1', name: '~' } }).sub.includes('~'), false);
});

test('the connector size comes from its manifest, never from the copy', () => {
  assert.equal(connectorSize({ connector: { approxSizeMB: 29 } }), 'about 29 MB');
  assert.equal(connectorSize({ connector: {} }), '');
  assert.equal(chooseNote({ connector: { approxSizeMB: 29 } }), 'The first time, SynaBun downloads a small connector for WhatsApp (about 29 MB, a few seconds) into its own folder.');
  assert.equal(chooseNote(null), 'The first time, SynaBun downloads a small connector for WhatsApp (a few seconds) into its own folder.');
  assert.match(waView({ state: 'installing', stage: 'downloading', connector: { approxSizeMB: 31 } }).sub, /\(about 31 MB, once\)/);
  assert.doesNotMatch(JSON.stringify(HELP), /\d+ MB/, 'no size written into the help text');
});

test('helpers and the string tables', () => {
  assert.equal(formatCountdown(125_000), '2:05');
  assert.equal(formatCountdown(-5), '0:00');
  assert.equal(formatCountdown(3_725_000), '1:02:05');
  assert.equal(levelLabel('read-only'), 'Read-only');
  assert.equal(levelLabel('bogus'), 'Ask on my phone');
  assert.deepEqual(MODE_CARDS.map((c) => c.id), ['self', 'dedicated']);
  assert.equal(MODE_CARDS[0].title, 'Message yourself');
  assert.equal(MODE_CARDS[0].badge, 'free, one scan');
  assert.equal(MODE_CARDS[1].badge, 'Safer');
  assert.deepEqual(LEVEL_CARDS.map((c) => c.id), ['read-only', 'ask', 'autonomous']);
  assert.match(LEVEL_CARDS[2].body, /ALLOW code/);
  assert.match(LEVEL_CARDS[2].body, /8 hours/);
  assert.deepEqual(COMMANDS.slice(0, 7).map((c) => c.name), ['/status', '/stop', '/new', '/pause', '/resume', '/cards', '/help']);
  assert.match(HELP.unofficial, /may result in a temporary or permanent account ban/);
  assert.match(HELP.downloads, /baileys \(MIT\).*libsignal \(GPL-3\.0\)/);
  assert.match(HELP.downloads, /baileys 7\.0\.0-rc14.*CVE-2026-48063/);
  assert.match(MODE_CARDS[0].notes.join(' '), /WhatsApp Web or Desktop is ignored/);
  assert.match(HELP.browserTools, /whatsapp MCP profile/);
  assert.deepEqual(Object.keys(STAGE_TEXT), ['checking', 'downloading', 'verifying', 'activating']);
  assert.deepEqual(Object.keys(LOGOUT_TEXT), ['removed', 'inactive', 'banned']);
  // Every string is plain text: the tab escapes what it inserts, but none of these carry markup.
  const all = JSON.stringify([MODE_CARDS, LEVEL_CARDS, COMMANDS, HELP, STAGE_TEXT, INSTALL_ERRORS, ERROR_TEXT, LOGOUT_TEXT]);
  assert.doesNotMatch(all, /<[a-z]/i);
});

test('review fixes: the brain warning, the honest Autonomous copy, and the session-files error', async () => {
  const view = await import('../public/shared/whatsapp/wa-view.js');
  const status = { ok: true, state: 'connected', mode: 'self', level: 'ask', brainLimit: { provider: 'codex', label: 'Codex' } };
  assert.equal(view.brainLimitText(status), 'This conversation runs read-only because its brain is Codex; switch the WhatsApp brain to Claude for Ask/Autonomous.');
  assert.equal(view.brainLimitText({ ok: true, state: 'connected', level: 'ask' }), '');
  assert.match(waView(status, { now: NOW }).sub, /Read-only \(Codex brain\)/, 'the header says what applies');
  const auto = LEVEL_CARDS.find((card) => card.id === 'autonomous');
  assert.match(auto.body, /Autonomous can read any file your computer account can, including SynaBun's WhatsApp login\. Use it only with a locked phone, ideally on a second number\./);
  assert.match(ERROR_TEXT.AUTH_PERMS, /session files/);
  assert.match(waView({ ok: true, state: 'error', code: 'AUTH_PERMS' }, { now: NOW }).sub, /permissions/);
});

test('the model selector: default "Same as the Assistant", a choice by provider and model, the notes; a status without the field reads as the default', async () => {
  const view = await import('../public/shared/whatsapp/wa-view.js');
  // An older server (no brainChoice, no config.brain), a status still loading, an error: the default, no note, no throw.
  for (const status of [null, undefined, {}, { ok: false, status: 404 }, { ok: true, state: 'connected', config: { level: 'ask' } }, { brainChoice: null }, { brainChoice: 'x', config: { brain: 'opus' } }]) {
    assert.equal(view.brainChoiceOf(status), null, JSON.stringify(status));
    assert.equal(view.brainChoiceInUse(status), null);
    assert.equal(view.brainChoiceLabel(status), 'Same as the Assistant');
    assert.deepEqual(view.brainChoiceNotes(status), []);
  }
  assert.equal(view.BRAIN_COPY.same, 'Same as the Assistant');
  // The default, with the brain it is right now.
  const same = { brainChoice: { choice: null, source: 'assistant', effective: { provider: 'claude-code', providerLabel: 'Claude', model: 'opus', modelLabel: 'Opus 5.5', effort: null }, fallback: null, readOnly: null } };
  assert.equal(view.brainChoiceLabel(same), 'Same as the Assistant (Claude · Opus 5.5)');
  assert.deepEqual(view.brainChoiceNotes(same), []);
  // A Claude choice: no note.
  const claude = { brainChoice: { choice: { provider: 'claude-code', model: 'sonnet', effort: 'high' }, source: 'choice', effective: { provider: 'claude-code', providerLabel: 'Claude', model: 'sonnet', modelLabel: 'Sonnet 5', effort: 'high' }, fallback: null, readOnly: null } };
  assert.deepEqual(view.brainChoiceOf(claude), { provider: 'claude-code', model: 'sonnet', effort: 'high' });
  assert.equal(view.brainChoiceLabel(claude), 'Claude · Sonnet 5');
  assert.equal(view.brainChoiceLabel(claude, { modelLabel: 'Sonnet 5 (picker)' }), 'Claude · Sonnet 5 (picker)', 'the picker\'s own name for the model wins');
  assert.deepEqual(view.brainChoiceNotes(claude), []);
  // Not a Claude model: shown, never hidden, with the existing rule next to it.
  for (const [provider, label] of [['codex', 'Codex'], ['opencode', 'OpenCode']]) {
    const other = { brainChoice: { choice: { provider, model: 'm', effort: null }, source: 'choice', effective: { provider, providerLabel: label, model: 'm', modelLabel: 'M' }, fallback: null, readOnly: { provider, label } } };
    assert.equal(view.brainChoiceLabel(other), `${label} · M`);
    assert.deepEqual(view.brainChoiceNotes(other), [`On ${label}, a WhatsApp conversation runs read-only whatever the level: only a Claude model can ask on your phone before it acts. Pick a Claude model for Ask on my phone or Autonomous.`]);
  }
  // A stored choice that was disabled or removed: the default is in use, and the tab says why.
  const disabled = { brainChoice: { choice: { provider: 'codex', model: 'gpt-6', effort: null }, source: 'assistant', effective: { provider: 'claude-code', providerLabel: 'Claude', model: 'opus', modelLabel: 'Opus' }, fallback: { reason: 'disabled', provider: 'codex', model: 'gpt-6', providerLabel: 'Codex' }, readOnly: null } };
  assert.equal(view.brainChoiceInUse(disabled), null);
  assert.equal(view.brainChoiceLabel(disabled), 'Same as the Assistant (Claude · Opus)');
  assert.deepEqual(view.brainChoiceNotes(disabled), ['gpt-6 is switched off in the Assistant\'s Models list, so WhatsApp runs on the same brain as the Assistant. Pick another model here, or switch it back on.']);
  const gone = { brainChoice: { ...disabled.brainChoice, fallback: { reason: 'unknown', provider: 'codex', model: 'gpt-6', providerLabel: 'Codex' } } };
  assert.deepEqual(view.brainChoiceNotes(gone), ['Codex no longer lists gpt-6, so WhatsApp runs on the same brain as the Assistant. Pick another model here.']);
  // A server that only sends config.brain (no brainChoice view) still shows the choice.
  assert.equal(view.brainChoiceLabel({ config: { brain: { provider: 'codex', model: 'gpt-6', effort: null } } }), 'Codex · gpt-6');
  // The copy says how approvals work now: a yes, never a number.
  const ask = LEVEL_CARDS.find((card) => card.id === 'ask');
  assert.match(ask.body, /acts only on your yes\. Any other message approves nothing: the conversation just carries on\./);
  assert.doesNotMatch(JSON.stringify([LEVEL_CARDS, COMMANDS]), /1 to allow|reply with its number|\(1, 2/);
  assert.equal(Object.keys(view.localizedCopy().BRAIN_COPY).join(), 'label,same,menuTitle,hint,effort,effortDefault,saved');
});
