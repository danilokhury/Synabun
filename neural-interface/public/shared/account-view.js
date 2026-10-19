// Claude and Codex accounts as every surface shows them: each side panel's
// header account menu (public/shared/account-menu.js), its sign-in screen, the
// Assistant's brain picker and accounts manager. The rows come from the server
// (lib/claude-accounts.js and lib/codex-accounts.js describe(): provider, mode,
// signedIn, identity, subscription, apiKey); this module only decides the words
// and what a choice does. No imports and no DOM: node --test loads it.
//
// ACCOUNT_COPY is the English; `accounts.*` in i18n/en.json must equal it and
// i18n/pt-BR.json translates it. A page hands its translator in once
// (setAccountTranslator); without one (a test, a detached window before i18n
// loads) the English is used.

export const ACCOUNT_COPY = Object.freeze({
  subscriptionBadge: '{service} account',
  apiKeyBadge: 'API key',
  apiShort: 'API',
  signedOut: 'Signed out',
  checking: 'Checking…',
  keyUnreadable: 'Key unreadable',
  defaultName: 'Default',
  current: 'This tab',
  nowNote: 'Applies now: the next message runs under {label}.',
  nextNote: 'This chat stays on {current}. {label} opens in a new chat.',
  sameNote: 'This tab already uses {label}.',
  missingNote: 'That account is no longer set up. Choose another one.',
  menuNoteNow: 'The account you pick applies from the next message.',
  menuNoteChat: 'This chat stays on {label}. Picking another account opens a new chat.',
  newChatUnder: 'This chat runs under {label}.',
  tooManyTabs: 'Close a tab first: the most tabs are open.',
  menuTitle: '{provider} accounts',
  triggerLabel: '{provider} account: {summary}',
  manage: 'Manage {label}',
  back: 'All accounts',
  addAccount: 'Add account',
  refresh: 'Refresh',
  subscriptionShort: 'Subscription',
  emptyAccounts: 'No accounts yet.',
  usageLeft: '{percent}% left',
  usageLimited: 'Limit reached',
  usageResets: 'Resets {time}',
  reading: 'Reading the accounts…',
  readFailed: 'Could not read the accounts. Try again.',
  needsServer: 'Choosing an account needs a newer SynaBun server: restart it to enable this.',
  otherAccounts: 'Other accounts…',
  uses: 'Uses',
  usesGroup: 'What {label} uses',
  credSubscription: '{service} subscription',
  credApiKey: 'API key',
  inUse: 'in use',
  signedIn: 'Signed in',
  notSignedIn: 'Not signed in',
  notChecked: 'Not checked yet',
  noKey: 'None',
  savedKey: 'Saved',
  keyUnreadableLong: 'Saved key cannot be read: save it again',
  keyKeptBy: '{hint}, kept by {cli}',
  signIn: 'Sign in with {service}',
  useApiKey: 'Use an API key',
  signOut: 'Sign out',
  removeKey: 'Remove key',
  rename: 'Rename',
  remove: 'Remove account',
  save: 'Save',
  cancel: 'Cancel',
  keyPlaceholder: 'Paste API key',
  keyLabel: 'API key for {label}',
  nameLabel: 'Account name',
  freshPrompt: 'Sign {label} in: with {service} (a terminal opens) or with an API key.',
  signInPending: 'Finish signing in in the terminal. This menu updates when {cli} confirms it.',
  checkingKey: 'Checking the key with {vendor}…',
  keySavedNote: '{label} now uses its API key.',
  modeSetApiKey: '{label} now uses its API key, from the next message.',
  modeSetSubscription: '{label} now uses its {service} account, from the next message.',
  signedOutNote: '{label} is signed out of {service}.',
  keyRemovedNote: 'The API key of {label} was removed.',
  confirmSignOut: 'Sign {label} out of {service}? {cli} removes the subscription login from this account.',
  confirmRemoveKey: 'Remove the API key saved for {label}?',
  confirmRemove: 'Remove {label}? Its folder, its sign-in and its saved key are deleted.',
  busyTurn: 'Finish or stop the current turn first.',
  failed: 'That did not work. Try again.',
  errInvalidKey: "That doesn't look like an {vendor} API key.",
  errOauthToken: "That's a Claude sign-in token. Use Sign in with Claude.",
  errKeyRejected: '{vendor} rejected that key.',
  errPermission: 'Saving keys requires the owner’s SynaBun window. Reload and try again.',
  errAccountUnavailable: 'This account is no longer available. Select an account again.',
  errAccountBusy: 'Finish this account’s work, then try again.',
  errUnreachable: "Couldn't reach {vendor} to check the key. Try again.",
  errUnavailable: "{vendor} couldn't check the key. Try again shortly.",
  errServer: "Couldn't reach SynaBun. Check the connection and try again.",
  errStorage: "Couldn't save the key for this account.",
});

// The names each provider's sentences use.
const PROVIDER_WORDS = Object.freeze({
  claude: Object.freeze({ provider: 'Claude', service: 'Claude', cli: 'Claude Code', vendor: 'Anthropic' }),
  codex: Object.freeze({ provider: 'Codex', service: 'ChatGPT', cli: 'Codex', vendor: 'OpenAI' }),
});

let _translate = null;
/** A page's translator: (key, params) => the `accounts.<key>` sentence, or null/undefined/the key itself when it has none. */
export function setAccountTranslator(fn) { _translate = typeof fn === 'function' ? fn : null; }

const fill = (text, params = {}) => String(text).replace(/\{(\w+)\}/g, (whole, key) => (params[key] != null ? params[key] : whole));

/** The provider of a row ('claude' when it does not say: Claude rows came first). */
export function rowProvider(row, provider = null) {
  const value = provider || row?.provider;
  return value === 'codex' ? 'codex' : 'claude';
}
/** The names a provider's sentences use: { provider, service, cli, vendor }. */
export function providerWords(provider) {
  return PROVIDER_WORDS[provider === 'codex' ? 'codex' : 'claude'];
}

/** One ACCOUNT_COPY sentence in the page's language, with the provider's names and `params` filled in. */
export function accountText(key, params = {}, provider = 'claude') {
  const values = { ...providerWords(provider), ...params };
  if (_translate) {
    try {
      const translated = _translate(key, values);
      if (typeof translated === 'string' && translated && translated !== key && translated !== `accounts.${key}`) return fill(translated, values);
    } catch { /* the English below */ }
  }
  return fill(Object.hasOwn(ACCOUNT_COPY, key) ? ACCOUNT_COPY[key] : key, values);
}

/** The id a Claude tab stores for an account ('' is Default, as Claude tabs have always stored it). */
export function tabAccountId(id) {
  return !id || id === 'default' ? '' : String(id);
}
/** The id the server names an account by ('default' for Default). */
export function serverAccountId(id) {
  return id ? String(id) : 'default';
}

/** What an account runs on now, as a short badge: { text, tone: ok | warn | muted, mode }. */
export function accountBadge(row, provider = null) {
  const p = rowProvider(row, provider);
  if (!row) return { text: accountText('signedOut', {}, p), tone: 'warn', mode: null };
  if (row.signedIn === false) {
    return { text: accountText(row.apiKey?.error ? 'keyUnreadable' : 'signedOut', {}, p), tone: 'warn', mode: null };
  }
  if (row.mode === 'apiKey') return { text: accountText('apiKeyBadge', {}, p), tone: 'ok', mode: 'apiKey' };
  if (row.mode === 'subscription' && row.signedIn === true) return { text: accountText('subscriptionBadge', {}, p), tone: 'ok', mode: 'subscription' };
  return { text: accountText('checking', {}, p), tone: 'muted', mode: row.mode || null };
}

function planName(plan) {
  const value = String(plan || '').trim();
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

/** Who the account is: an email (with its plan), a masked key ("…abcd"), or ''. Never a key. */
export function accountIdentity(row) {
  if (!row || row.signedIn === false) return '';
  if (row.mode === 'apiKey') return row.apiKey?.hint || row.identity || '';
  const email = row.subscription?.email || row.identity || '';
  const plan = row.subscription?.plan ? planName(row.subscription.plan) : '';
  return [email, plan].filter(Boolean).join(' · ');
}

/** The account's name: the one it was given, Default's in the page's language. */
export function accountName(row, provider = null) {
  if (!row) return '';
  if (row.isDefault || row.id === 'default') return accountText('defaultName', {}, rowProvider(row, provider));
  return row.label || row.id;
}

/** One line for a menu or a tooltip: "Work · API key · …abcd". */
export function accountSummary(row, provider = null) {
  if (!row) return '';
  return [accountName(row, provider), accountBadge(row, provider).text, accountIdentity(row)].filter(Boolean).join(' · ');
}

/** A compact credential label where the full account summary is available in a tooltip. */
export function accountCompactMode(row, provider = null) {
  const p = rowProvider(row, provider);
  if (row?.signedIn !== false && row?.mode === 'apiKey') return accountText('apiShort', {}, p);
  if (row?.signedIn === true && row?.mode === 'subscription') return providerWords(p).service;
  return accountBadge(row, p).text;
}

/** Whether a session can be started under the account now (false only when it is known that it cannot). */
export function accountUsable(row) {
  return !!row && row.signedIn !== false;
}

/** The two modes of an account that holds both credentials, for a switch; [] otherwise. */
export function modeChoices(row, provider = null) {
  if (!row?.switchable) return [];
  const p = rowProvider(row, provider);
  return [
    { mode: 'subscription', label: accountText('subscriptionBadge', {}, p), detail: row.subscription?.email || '', current: row.mode === 'subscription' },
    { mode: 'apiKey', label: accountText('apiKeyBadge', {}, p), detail: row.apiKey?.hint || '', current: row.mode === 'apiKey' },
  ];
}

/**
 * The credentials of an account, each with what can be done about it:
 * [{ kind: 'subscription' | 'apiKey', name, present, text, action: 'signIn' | 'signOut' | 'addKey' | 'removeKey', actionText, inUse }].
 */
export function credentialRows(row, provider = null) {
  if (!row) return [];
  const p = rowProvider(row, provider);
  const sub = row.subscription || {};
  const key = row.apiKey || {};
  const subText = sub.signedIn === true
    ? [sub.email || accountText('signedIn', {}, p), sub.plan ? planName(sub.plan) : ''].filter(Boolean).join(' · ')
    : accountText(sub.signedIn === false ? 'notSignedIn' : 'notChecked', {}, p);
  let keyText = key.present ? (key.hint || accountText('savedKey', {}, p)) : key.error ? accountText('keyUnreadableLong', {}, p) : accountText('noKey', {}, p);
  // A key Codex itself holds (an older `codex login --with-api-key`): said, so its sign-out is understood.
  if (key.present && key.source === 'codex') keyText = accountText('keyKeptBy', { hint: key.hint || accountText('savedKey', {}, p) }, p);
  const subAction = sub.signedIn === true ? 'signOut' : 'signIn';
  const keyAction = key.present || key.error ? 'removeKey' : 'addKey';
  const actionText = { signIn: accountText('signIn', {}, p), signOut: accountText('signOut', {}, p), addKey: accountText('useApiKey', {}, p), removeKey: accountText('removeKey', {}, p) };
  return [
    { kind: 'subscription', name: accountText('credSubscription', {}, p), present: sub.signedIn === true, text: subText, action: subAction, actionText: actionText[subAction], inUse: row.mode === 'subscription' && row.signedIn === true },
    { kind: 'apiKey', name: accountText('credApiKey', {}, p), present: !!key.present, text: keyText, action: keyAction, actionText: actionText[keyAction], inUse: row.mode === 'apiKey' },
  ];
}

/**
 * What picking an account in a tab does. A conversation belongs to the account
 * it started under (its transcript lives in that account's folder), so a tab
 * that has one opens the new account in a new chat.
 * → { effect: 'same' | 'now' | 'next-chat' | 'missing', message }
 */
export function accountSwitchPlan({ rows = [], currentId = '', targetId = '', hasConversation = false, provider = null } = {}) {
  const current = rows.find((row) => row.id === serverAccountId(currentId));
  const target = rows.find((row) => row.id === serverAccountId(targetId));
  const p = rowProvider(target || current || rows[0], provider);
  if (!target) return { effect: 'missing', message: accountText('missingNote', {}, p) };
  const label = accountName(target, p);
  if (serverAccountId(currentId) === target.id) return { effect: 'same', message: accountText('sameNote', { label }, p) };
  if (hasConversation) return { effect: 'next-chat', message: accountText('nextNote', { label, current: current ? accountName(current, p) : accountText('defaultName', {}, p) }, p) };
  return { effect: 'now', message: accountText('nowNote', { label }, p) };
}

/** The account menu's rows: every account, the current one marked, a signed-out one still choosable (it shows its sign-in). */
export function accountMenuRows(rows = [], currentId = '', nextId = null, provider = null) {
  return rows.map((row) => {
    const badge = accountBadge(row, provider);
    return {
      id: row.id,
      label: accountName(row, provider),
      badge: badge.text,
      tone: badge.tone,
      identity: accountIdentity(row),
      current: row.id === serverAccountId(currentId),
      next: nextId !== null && row.id === serverAccountId(nextId) && row.id !== serverAccountId(currentId),
      usable: accountUsable(row),
      isDefault: !!row.isDefault || row.id === 'default',
    };
  });
}

/** The menu's trigger: the tab's account and what it runs on. A pending next-chat account is shown after an arrow. */
export function accountChip(rows = [], currentId = '', nextId = null, provider = null) {
  const current = rows.find((row) => row.id === serverAccountId(currentId));
  const next = nextId !== null ? rows.find((row) => row.id === serverAccountId(nextId)) : null;
  const p = rowProvider(current || rows[0], provider);
  const name = current ? accountName(current, p) : (serverAccountId(currentId) === 'default' ? accountText('defaultName', {}, p) : serverAccountId(currentId));
  const badge = current ? accountBadge(current, p) : { text: '', tone: 'muted' };
  const text = next && next.id !== current?.id ? `${name} → ${accountName(next, p)}` : name;
  return { text, badge: badge.text, tone: badge.tone, tooltip: [current ? accountSummary(current, p) : name, next && next.id !== current?.id ? accountText('nextNote', { label: accountName(next, p), current: name }, p) : ''].filter(Boolean).join('\n') };
}

/**
 * The header account menu, as one model both panels render (account-menu.js):
 * { title, trigger: { name, badge, tone, label }, note, rows }. `hasConversation`:
 * the tab has a conversation, so another account opens in a new chat.
 */
export function accountMenuModel({ provider = 'claude', rows = [], currentId = '', hasConversation = false } = {}) {
  const p = provider === 'codex' ? 'codex' : 'claude';
  const chip = accountChip(rows, currentId, null, p);
  const current = rows.find((row) => row.id === serverAccountId(currentId));
  const summary = current ? accountSummary(current, p) : chip.text;
  // The header has little room: the trigger's badge is the short form (the service's name for a
  // subscription); the full words are its label and tooltip.
  const short = current?.mode === 'subscription' && current.signedIn === true ? providerWords(p).service : chip.badge;
  return {
    title: accountText('menuTitle', {}, p),
    trigger: { name: chip.text, badge: chip.badge, short, tone: chip.tone, label: accountText('triggerLabel', { summary }, p) },
    note: hasConversation ? accountText('menuNoteChat', { label: chip.text }, p) : accountText('menuNoteNow', {}, p),
    rows: accountMenuRows(rows, currentId, null, p),
  };
}

/**
 * One account's management view: its name, what it runs on, the mode switch
 * (both credentials only), each credential with its action, rename and remove
 * (never for Default).
 */
export function accountManageModel(row, provider = null) {
  if (!row) return null;
  const p = rowProvider(row, provider);
  const badge = accountBadge(row, p);
  return {
    id: row.id,
    title: accountName(row, p),
    badge: badge.text,
    tone: badge.tone,
    identity: accountIdentity(row),
    usesLabel: accountText('usesGroup', { label: accountName(row, p) }, p),
    modes: modeChoices(row, p),
    credentials: credentialRows(row, p),
    canRename: !(row.isDefault || row.id === 'default'),
    canRemove: !(row.isDefault || row.id === 'default'),
  };
}

const API_KEY_ERROR_KEYS = Object.freeze({
  invalid_key: 'errInvalidKey', oauth_token: 'errOauthToken', key_rejected: 'errKeyRejected', permission_denied: 'errPermission',
  account_unavailable: 'errAccountUnavailable', account_busy: 'errAccountBusy', verification_unreachable: 'errUnreachable',
  verification_unavailable: 'errUnavailable', server_unreachable: 'errServer', storage_failed: 'errStorage',
});
/** The sentence for an API-key save error code: only local, allowlisted words, never a provider's error text. */
export function apiKeyErrorText(provider, code) {
  // An untrusted code never selects an inherited property ("constructor", "__proto__").
  const key = typeof code === 'string' && Object.hasOwn(API_KEY_ERROR_KEYS, code) ? API_KEY_ERROR_KEYS[code] : 'errStorage';
  return accountText(key, {}, provider === 'codex' ? 'codex' : 'claude');
}

// The Claude-only names the first callers imported (claude-account-view.js re-exports them).
export const CLAUDE_ACCOUNT_COPY = Object.freeze({
  subscription: 'Claude account',
  apiKey: ACCOUNT_COPY.apiKeyBadge,
  signedOut: ACCOUNT_COPY.signedOut,
  checking: ACCOUNT_COPY.checking,
  keyUnreadable: ACCOUNT_COPY.keyUnreadable,
  defaultName: ACCOUNT_COPY.defaultName,
  current: ACCOUNT_COPY.current,
  signInClaude: 'Sign in with Claude',
  useApiKey: ACCOUNT_COPY.useApiKey,
});
