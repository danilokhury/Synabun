import { capabilityAvailability, flattenNativeCatalog, reviewTarget } from './cdx-commands.js';
import { knownCodexCapabilities } from './cdx-capabilities.js';
import { codexReadableValue, parseCodexAttachmentPayload, codexGatewayState, codexVerificationState, codexHttpsHandoff } from './cdx-protocol.js';

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = String(text);
  return el;
}

function dialog(host, title) {
  host.querySelector('.cxp-feature-overlay')?.remove();
  const overlay = element('div', 'cxp-settings-overlay cxp-feature-overlay');
  const panel = element('div', 'cxp-settings-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);
  const header = element('div', 'cxp-settings-header');
  const close = element('button', 'cxp-settings-close', '×');
  close.setAttribute('aria-label', 'Close');
  const previousFocus = document.activeElement;
  const dismiss = () => { overlay.remove(); if (previousFocus?.isConnected) previousFocus.focus(); };
  close.addEventListener('click', dismiss);
  header.append(element('span', '', title), close);
  const body = element('div', 'cxp-settings-body');
  const error = element('div', 'cxp-settings-hint');
  error.setAttribute('role', 'alert');
  panel.append(header, body, error);
  overlay.append(panel);
  host.append(overlay);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
    if (event.key !== 'Tab') return;
    const inputs = [...panel.querySelectorAll('button, input, select, textarea, a[href]')].filter((el) => !el.disabled && !el.hidden);
    const first = inputs[0]; const last = inputs.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  close.focus();
  return { body, overlay, close: dismiss, error: (message) => { error.textContent = message; } };
}

function button(label, action, view, availability = { supported: true }) {
  const btn = element('button', 'cxp-btn cxp-btn-sm', label);
  btn.type = 'button';
  btn.disabled = !availability.supported;
  if (!availability.supported) btn.title = availability.reason || 'Unavailable in this runtime';
  if (availability.experimental && availability.supported) btn.title = 'Experimental';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    view.error('');
    try { await action(); } catch (error) { view.error(error.message || String(error)); }
    finally { if (btn.isConnected) btn.disabled = !availability.supported; }
  });
  return btn;
}

function inputField(body, labelText, value = '', multiline = false) {
  const label = element('label', 'cxp-config-row');
  label.append(element('span', 'cxp-config-label', labelText));
  const input = element(multiline ? 'textarea' : 'input', 'cxp-config-input');
  input.value = value;
  if (multiline) input.rows = 6;
  label.append(input); body.append(label);
  return input;
}

export async function openCodexReview({ host, request, tab, onStarted }) {
  const view = dialog(host, 'Review changes');
  const select = element('select', 'cxp-config-input');
  select.setAttribute('aria-label', 'Review target');
  for (const [value, label] of [['uncommittedChanges', 'Working tree'], ['baseBranch', 'Base branch'], ['commit', 'Commit'], ['custom', 'Custom instructions']]) {
    const option = element('option', '', label); option.value = value; select.append(option);
  }
  view.body.append(select);
  const value = inputField(view.body, 'Branch, commit or instructions', '', true);
  value.parentElement.hidden = true;
  select.addEventListener('change', () => { value.parentElement.hidden = select.value === 'uncommittedChanges'; });
  view.body.append(button('Start review', async () => {
    if (tab.closed || tab.running || tab.startingThread) throw new Error('Wait for the active turn to finish before starting a review.');
    const result = await request('review_start', { threadId: tab.threadId, target: reviewTarget(select.value, value.value), delivery: 'inline' });
    onStarted?.(result); view.close();
  }, view));
}

const diffViews = new WeakMap();

export function refreshCodexDiff(tab) {
  diffViews.get(tab)?.();
}

export async function openCodexDiff({ host, tab, workingTree, openFile }) {
  const view = dialog(host, 'Changes');
  const source = element('select', 'cxp-config-input');
  source.setAttribute('aria-label', 'Diff source');
  for (const [value, label] of [['turn', 'Current turn'], ['working', 'Working tree']]) {
    const option = element('option', '', label); option.value = value; source.append(option);
  }
  source.value = tab.latestTurnDiff?.diff ? 'turn' : 'working';
  const files = element('div', 'cxp-config-row');
  const output = element('pre', 'cxp-settings-hint');
  output.style.whiteSpace = 'pre'; output.style.overflow = 'auto';
  const note = element('div', 'cxp-settings-hint');
  view.body.append(source, note, files, output);
  let cachedWorking = null;
  let generation = 0;
  const render = async () => {
    if (!view.overlay.isConnected || tab.closed) { diffViews.delete(tab); return; }
    const current = ++generation;
    let diff = '';
    try {
      if (source.value === 'turn') {
        diff = tab.latestTurnDiff?.diff || '';
        note.textContent = diff ? 'Updates as Codex changes files.' : 'No turn diff has been reported yet.';
      } else {
        cachedWorking ||= await workingTree();
        diff = [cachedWorking.diff, cachedWorking.stagedDiff].filter(Boolean).join('\n');
        note.textContent = cachedWorking.untrackedFiles?.length ? `Untracked: ${cachedWorking.untrackedFiles.join(', ')}` : 'Working tree and staged changes';
      }
      if (current !== generation || !view.overlay.isConnected) return;
      output.textContent = diff || 'No changes.';
      files.replaceChildren();
      const paths = [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]))];
      for (const path of paths) files.append(button(path, () => openFile(path), view));
    } catch (error) { view.error(error.message); }
  };
  diffViews.set(tab, render);
  source.addEventListener('change', render);
  view.body.append(button('Refresh working tree', () => { cachedWorking = null; return render(); }, view));
  await render();
}

export async function openCodexFeedback({ host, request, tab, initialReason = '' }) {
  const view = dialog(host, 'Send feedback');
  view.body.append(element('p', 'cxp-settings-hint', 'Feedback is sent to OpenAI. Review the message and included details below before sending.'));
  const classification = element('select', 'cxp-config-input');
  classification.setAttribute('aria-label', 'Feedback type');
  for (const name of ['bug', 'feature', 'other']) { const option = element('option', '', name); option.value = name; classification.append(option); }
  view.body.append(classification);
  const reason = inputField(view.body, 'Message', initialReason, true);
  const logsLabel = element('label', 'cxp-config-row');
  const logs = element('input', 'cxp-config-checkbox'); logs.type = 'checkbox';
  logsLabel.append(logs, element('span', '', 'Include diagnostic logs')); view.body.append(logsLabel);
  const threadLabel = element('label', 'cxp-config-row');
  const includeThread = element('input', 'cxp-config-checkbox'); includeThread.type = 'checkbox';
  includeThread.disabled = !tab.threadId;
  threadLabel.append(includeThread, element('span', '', 'Include current thread identifier')); view.body.append(threadLabel);
  const preview = element('pre', 'cxp-settings-hint');
  let reviewed = '';
  const payload = () => ({ classification: classification.value, reason: reason.value.trim(), includeLogs: logs.checked, threadId: includeThread.checked ? tab.threadId : null, tags: { client: 'synabun' } });
  const send = button('Send feedback', async () => {
    if (reviewed !== JSON.stringify(payload())) throw new Error('Preview your updated feedback before sending.');
    await request('feedback_upload', payload()); view.close();
  }, view);
  send.hidden = true;
  view.body.append(button('Preview feedback', () => {
    if (!reason.value.trim()) throw new Error('Enter a feedback message.');
    reviewed = JSON.stringify(payload()); preview.textContent = JSON.stringify(payload(), null, 2); send.hidden = false;
  }, view), preview, send);
  for (const control of [classification, reason, logs, includeThread]) control.addEventListener('input', () => { reviewed = ''; send.hidden = true; });
}

export async function openCodexGoal({ host, request, tab, capabilities }) {
  const view = dialog(host, `Thread goal${capabilityAvailability(capabilities, 'goal_get').experimental ? ' · Experimental' : ''}`);
  try {
    const response = await request('goal_get', { threadId: tab.threadId });
    if (tab.closed || !view.overlay.isConnected) return;
    const goal = response.goal?.goal || response.goal || {};
    const objective = inputField(view.body, 'Objective', goal.objective || '', true);
    const budget = inputField(view.body, 'Token budget (optional)', goal.tokenBudget || ''); budget.type = 'number'; budget.min = '1'; budget.step = '1';
    const status = element('select', 'cxp-config-input'); status.setAttribute('aria-label', 'Goal status');
    for (const name of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']) {
      const option = element('option', '', name); option.value = name; option.selected = goal.status === name; status.append(option);
    }
    view.body.append(status);
    if (goal.tokensUsed != null) view.body.append(element('p', 'cxp-settings-hint', `Tokens used: ${goal.tokensUsed}`));
    view.body.append(button('Save goal', async () => {
      if (!objective.value.trim()) throw new Error('Enter a goal objective.');
      const tokenBudget = budget.value ? Number(budget.value) : null;
      if (tokenBudget != null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) throw new Error('Token budget must be a positive whole number.');
      await request('goal_set', { threadId: tab.threadId, objective: objective.value.trim(), status: status.value, tokenBudget }); view.close();
    }, view, capabilityAvailability(capabilities, 'goal_set')));
    if (goal.objective) view.body.append(button('Clear goal', async () => {
      await request('goal_clear', { threadId: tab.threadId }); view.close();
    }, view, capabilityAvailability(capabilities, 'goal_clear')));
  } catch (error) { view.error(error.message); }
}

const attachmentViews = new WeakMap();
export function refreshCodexAttachments(tab) { attachmentViews.get(tab)?.(); }

const CATALOGS = {
  attachments: { title: 'Thread attachments', method: 'attachment_list', key: 'attachments' },
  skills: { title: 'Skills', method: 'skills_list', key: 'skills' },
  mcp: { title: 'MCP servers', method: 'mcp_status', key: 'servers' },
  apps: { title: 'Apps', method: 'app_list', key: 'apps' },
  plugins: { title: 'Plugins', method: 'plugin_list', key: 'plugins' },
  hooks: { title: 'Hooks', method: 'hooks_list', key: 'hooks' },
  ps: { title: 'Background terminals', method: 'background_list', key: 'terminals' },
  experimental: { title: 'Experimental features', method: 'experimental_features', key: 'features' },
  agent: { title: 'Loaded agent threads', method: 'thread_loaded_list', key: 'threads' },
};

export async function openCodexCatalog({ host, request, tab, kind, capabilities, authenticate, openThread, onChanged }) {
  const catalog = CATALOGS[kind];
  if (!catalog) throw new Error('Unknown Codex catalog.');
  const availability = capabilityAvailability(capabilities, catalog.method);
  const view = dialog(host, `${catalog.title}${availability.experimental ? ' · Experimental' : ''}`);
  if (!availability.supported) { view.error(availability.reason || 'Unavailable in this runtime.'); return; }
  const search = element('input', 'cxp-config-input'); search.type = 'search'; search.placeholder = `Search ${catalog.title.toLowerCase()}`;
  search.setAttribute('aria-label', search.placeholder);
  const list = element('div', 'cxp-settings-section');
  const controls = element('div', 'cxp-config-row');
  view.body.append(search, controls, list);
  let entries = [];
  let nextCursor = null;
  let busy = false;
  let refreshPending = false;
  let typeSuggestions = null;
  if (kind === 'attachments') {
    const form = element('form', 'cxp-settings-section');
    const type = inputField(form, 'Attachment type');
    const identity = inputField(form, 'Identity key');
    const payload = inputField(form, 'Payload (JSON)', '{}', true);
    typeSuggestions = element('datalist'); typeSuggestions.id = `cxp-attachment-types-${crypto.randomUUID()}`;
    type.setAttribute('list', typeSuggestions.id);
    const addAvailability = tab.threadId ? capabilityAvailability(capabilities, 'attachment_add') : { supported: false, reason: 'Start a thread before adding attachments.' };
    const note = element('p', 'cxp-settings-hint', 'JSON payload limit: 64 KiB.');
    const error = element('p', 'cxp-settings-hint'); error.setAttribute('role', 'alert');
    const add = element('button', 'cxp-request-btn', 'Add attachment'); add.type = 'submit';
    add.disabled = !addAvailability.supported;
    if (!addAvailability.supported) note.textContent += ` ${addAvailability.reason}`;
    for (const field of [type, identity, payload]) field.disabled = !addAvailability.supported;
    form.append(typeSuggestions, note, error, add); view.body.prepend(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (add.disabled) return;
      error.textContent = '';
      try {
        const parsed = parseCodexAttachmentPayload(payload.value);
        if (!type.value.trim() || !identity.value.trim()) throw new Error('Enter an attachment type and identity key.');
        add.disabled = true;
        for (const field of [type, identity, payload]) field.disabled = true;
        await request('attachment_add', { threadId: tab.threadId, attachmentType: type.value.trim(), identityKey: identity.value.trim(), payload: parsed });
        identity.value = ''; payload.value = '{}'; onChanged?.(); await load();
      } catch (failure) { error.textContent = failure.message || String(failure); }
      finally {
        add.disabled = !capabilityAvailability(knownCodexCapabilities(tab) || capabilities, 'attachment_add').supported || !tab.threadId;
        for (const field of [type, identity, payload]) field.disabled = add.disabled;
        if (add.disabled) note.textContent = `JSON payload limit: 64 KiB. ${capabilityAvailability(knownCodexCapabilities(tab) || capabilities, 'attachment_add').reason || 'Start a thread before adding attachments.'}`;
      }
    });
    attachmentViews.set(tab, () => { if (busy) refreshPending = true; else void load(); });
  }
  const params = () => ({ threadId: tab.threadId || null, cwds: tab.project ? [tab.project] : undefined });
  const mutate = async (method, payload) => { await request(method, payload); onChanged?.(); await load(); };
  function render() {
    list.replaceChildren();
    if (typeSuggestions) {
      typeSuggestions.replaceChildren();
      for (const name of new Set(entries.map(entry => entry.attachmentType).filter(Boolean))) {
        const option = element('option'); option.value = name; typeSuggestions.append(option);
      }
    }
    const query = search.value.toLowerCase();
    const filtered = entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(query));
    if (!filtered.length) list.append(element('p', 'cxp-settings-hint', entries.length ? 'No matching entries.' : 'No entries reported.'));
    for (const rawEntry of filtered) {
      const entry = typeof rawEntry === 'string' ? { id: rawEntry } : rawEntry;
      const row = element('details', 'cxp-settings-section');
      const name = entry.interface?.displayName || entry.name || entry.command || entry.objective || entry.eventName || entry.identityKey || entry.threadId || entry.id || entry.key || 'Entry';
      row.append(element('summary', 'cxp-settings-value', `${name}${entry.enabled === false || entry.isEnabled === false ? ' · Disabled' : ''}${entry.stage ? ` · ${entry.stage}` : ''}`));
      if (entry.description) row.append(element('p', 'cxp-settings-hint', entry.description));
      if (entry.error || entry.disabledReason) row.append(element('p', 'cxp-settings-hint', entry.error || entry.disabledReason));
      const details = element('pre', 'cxp-settings-hint'); details.textContent = JSON.stringify(entry, null, 2); row.append(details);
      if (kind === 'attachments') {
        details.textContent = codexReadableValue({ attachmentType: entry.attachmentType, payload: entry.payload });
        row.append(button('Remove attachment', () => mutate('attachment_remove', { threadId: tab.threadId, attachmentType: entry.attachmentType, identityKey: entry.identityKey }), view, capabilityAvailability(capabilities, 'attachment_remove')));
      }
      if (kind === 'skills') row.append(button(entry.enabled === false ? 'Enable' : 'Disable', () => mutate('skills_config_write', { path: entry.path, enabled: entry.enabled === false }), view, capabilityAvailability(capabilities, 'skills_config_write')));
      if (kind === 'mcp') {
        const metadata = [entry.httpOrigin, entry.toolsError ? `Tools unavailable: ${entry.toolsError}` : '', entry.serverCapabilities ? `Capabilities: ${Object.keys(entry.serverCapabilities).join(', ')}` : ''].filter(Boolean).join(' · ');
        if (metadata) row.append(element('p', 'cxp-settings-hint', metadata));
        row.append(button('Refresh', () => mutate('mcp_refresh', { name: entry.name }), view, capabilityAvailability(capabilities, 'mcp_refresh')));
        if (entry.requiresOAuth) row.append(button('Authenticate', () => authenticate(entry.name), view, capabilityAvailability(capabilities, 'mcp_oauth_login')));
      }
      if (kind === 'apps') row.append(button('Load tool details', async () => {
        const result = await request('app_read', { appIds: [entry.id], includeTools: true, threadId: tab.threadId || null });
        const apps = flattenNativeCatalog(result, 'apps');
        details.textContent = JSON.stringify(apps.length ? apps : result.apps, null, 2);
      }, view, capabilityAvailability(capabilities, 'app_read')));
      if (kind === 'ps') row.append(button('Stop process', () => mutate('background_terminate', { threadId: tab.threadId, processId: entry.processId }), view, capabilityAvailability(capabilities, 'background_terminate')));
      if (kind === 'experimental') row.append(button(entry.enabled ? 'Disable' : 'Enable', () => mutate('experimental_features_set', { enablement: { [entry.name]: !entry.enabled } }), view, capabilityAvailability(capabilities, 'experimental_features_set')));
      if (kind === 'agent') row.append(button('Open thread', () => { openThread(entry.threadId || entry.id); view.close(); }, view));
      list.append(row);
    }
    more.hidden = !nextCursor;
  }
  async function load(cursor = null) {
    if (busy || tab.closed || !view.overlay.isConnected) return;
    busy = true;
    try {
      const response = await request(catalog.method, { ...params(), ...(cursor ? { cursor } : {}), forceReload: !cursor });
      if (tab.closed || !view.overlay.isConnected) return;
      const value = response[catalog.key] || {};
      let incoming = flattenNativeCatalog(response, catalog.key);
      if (kind === 'agent') incoming = Array.isArray(value) ? value : (value.threadIds || value.data || value.threads || []);
      entries = cursor ? [...entries, ...incoming] : incoming;
      nextCursor = value.nextCursor || response.nextCursor || null;
      render();
      const errors = (value.data || []).flatMap((entry) => [...(entry.errors || []).map((error) => error.message || String(error)), ...(entry.warnings || [])]);
      view.error(errors.join('\n'));
    } catch (error) { view.error(error.message || String(error)); }
    finally {
      busy = false;
      if (refreshPending) { refreshPending = false; void load(); }
    }
  }
  const more = button('Load more', () => load(nextCursor), view); more.hidden = true;
  controls.append(button('Refresh', () => load(), view));
  if (kind === 'ps') controls.append(button('Stop all', () => mutate('background_clean', { threadId: tab.threadId }), view, capabilityAvailability(capabilities, 'background_clean')));
  view.body.append(more);
  search.addEventListener('input', render);
  if (kind !== 'attachments' || tab.threadId) await load();
}

const accountSecurityViews = new WeakMap();
export function updateCodexGateway(tab, value) {
  if (!tab) return;
  tab.gatewayOAuth = { ...(tab.gatewayOAuth || {}), ...value };
  accountSecurityViews.get(tab)?.();
}

export async function mountCodexAccountSecurity({ host, request, tab, capabilities }) {
  const view = { error: message => { error.textContent = message; } };
  const error = element('div', 'cxp-settings-hint'); error.setAttribute('role', 'alert');
  const gateway = element('div', 'cxp-settings-section');
  const verification = element('div', 'cxp-settings-section');
  host.append(gateway, verification, error);
  const available = name => capabilityAvailability(knownCodexCapabilities(tab) || capabilities, name);
  const renderGateway = () => {
    if (!host.isConnected || tab.closed) { accountSecurityViews.delete(tab); return; }
    gateway.replaceChildren();
    if (!available('gateway_oauth_read').supported) return;
    const value = tab.gatewayOAuth || {};
    const state = codexGatewayState(value);
    gateway.append(element('div', 'cxp-settings-section-title', 'Gateway OAuth'));
    gateway.append(element('div', 'cxp-settings-hint', `${value.providerName || value.providerId || 'Provider'} · ${state.label}`));
    const action = state.pending ? 'gateway_oauth_cancel' : 'gateway_oauth_login';
    gateway.append(button(state.pending ? 'Cancel' : 'Sign in', async () => {
      if (!available(action).supported) throw new Error(available(action).reason);
      await request(action, {});
      // Notification is authoritative; do not overwrite a completed login with a stale optimistic state.
      if (action === 'gateway_oauth_cancel') await readGateway();
      else if (!tab.gatewayOAuth?.status || tab.gatewayOAuth.status === 'notReady') {
        updateCodexGateway(tab, { status: 'started' });
      }
    }, view, available(action)));
    if (!available(action).supported) gateway.append(element('div', 'cxp-settings-hint', available(action).reason));
    const handoff = codexHttpsHandoff(value.authUrl);
    if (value.authUrl && !handoff) gateway.append(element('div', 'cxp-settings-hint', 'Authorization URL is unavailable: HTTPS is required.'));
    if (handoff && state.pending) {
      gateway.append(element('div', 'cxp-settings-hint', `Continue sign-in at ${handoff.host}`));
      gateway.append(button(`Open ${handoff.host}`, () => {
        window.open(handoff.url, '_blank', 'noopener,noreferrer');
      }, view));
    }
  };
  accountSecurityViews.set(tab, renderGateway);
  async function readGateway() {
    if (!available('gateway_oauth_read').supported) { renderGateway(); return; }
    try {
      const response = await request('gateway_oauth_read', {});
      if (!tab.closed && host.isConnected) updateCodexGateway(tab, response.gateway || {});
    } catch (failure) {
      renderGateway();
      if (available('gateway_oauth_read').supported) view.error(failure.message);
    }
  }
  async function readVerification() {
    verification.replaceChildren();
    if (!available('verification_status').supported || !host.isConnected || tab.closed) return;
    try {
      const response = await request('verification_status', {});
      if (!host.isConnected || tab.closed) return;
      const state = codexVerificationState(response.verification);
      verification.append(element('div', 'cxp-settings-section-title', 'User verification · Experimental'));
      verification.append(element('div', 'cxp-settings-hint', state.label));
      verification.append(element('div', 'cxp-settings-hint', 'Local device credential only; backend registration is managed by the verifier.'));
      const action = state.enrolled ? 'verification_delete' : 'verification_enroll';
      const control = button(state.enrolled ? 'Remove' : 'Enroll', async () => {
        if (state.enrolled && !window.confirm('Remove the local user verification credential?')) return;
        await request(action, {}); await readVerification();
      }, view, available(action));
      if (state.enrolled) control.style.color = 'var(--cxp-danger)';
      verification.append(control);
      if (!available(action).supported) verification.append(element('div', 'cxp-settings-hint', available(action).reason));
    } catch (failure) {
      if (available('verification_status').supported) {
        verification.append(element('div', 'cxp-settings-hint', `User verification unavailable: ${failure.message}`));
      }
    }
  }
  await readGateway();
  await readVerification();
}
