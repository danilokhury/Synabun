import { t, getLocale } from '../i18n.js';
import { accountSummary } from '../account-view.js';
import { configChanges, configRestriction, configValue, SESSION_CONFIG_FIELDS, sessionSettings, modelServiceTiers, capabilityAvailability } from './cdx-commands.js';
import { mountCodexAccountSecurity } from './cdx-features.js';

const overrideValue = (field, value) => field === 'sandboxPolicy' && value ? ({ readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' })[value.type] ?? null : value;
const tr = (key, params) => t(`codexSettings.${key}`, params);
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
const metadata = [
  ['model', 'model', 'models'], ['review_model', 'reviewModel', 'models'],
  ['model_reasoning_effort', 'effort', 'models'], ['model_reasoning_summary', 'summary', 'models'],
  ['service_tier', 'serviceTier', 'models'], ['personality', 'personality', 'models'],
  ['approval_policy', 'approval', 'permissions'], ['sandbox_mode', 'sandbox', 'permissions'],
  ['web_search', 'webSearch', 'tools'], ['model_provider', 'provider', 'advanced'],
  ['model_verbosity', 'verbosity', 'advanced'], ['model_context_window', 'contextWindow', 'advanced'],
  ['model_auto_compact_token_limit', 'autoCompact', 'advanced'],
];
export function codexSettingsDefinitions(schema, models, cfg) {
  const model = models.find(m => (m.model || m.id) === cfg.model) || models.find(m => m.isDefault) || models[0];
  const modelOptions = models.map(m => ({ value: m.model || m.id, label: m.displayName || m.label || m.model || m.id }));
  return metadata.flatMap(([key, label, section]) => {
    const field = schema.fields?.[key]; if (!field) return [];
    if (key === 'service_tier' && cfg.model_provider && cfg.model_provider !== 'openai') return [];
    let options = (field.values || []).map(value => ({ value, label: tr(`values.${value}`) === `codexSettings.values.${value}` ? value : tr(`values.${value}`) }));
    if (key === 'model' || key === 'review_model') options = modelOptions;
    if (key === 'model_reasoning_effort') options = (model?.supportedReasoningEfforts || []).map(e => ({ value: e.reasoningEffort, label: e.reasoningEffort }));
    if (key === 'service_tier') options = modelServiceTiers(model);
    if (key === 'personality' && !model?.supportsPersonality) return [];
    // The provider list is configured locally. Built-in OpenAI plus named providers.
    if (key === 'model_provider') options = [...new Set(['openai', ...Object.keys(cfg.model_providers || {}), cfg.model_provider].filter(Boolean))].map(value => ({ value, label: value }));
    if (field.type !== 'number' && !options.length) return [];
    return [{ key, label: tr(label), section, type: field.type, options: [{ value: '', label: tr('default') }, ...options] }];
  });
}

export async function mountCodexSettings({ host, tab, request, capabilities, account, models, normalizeConfig, manageAccount, authenticate, onSaved }) {
  if (host.querySelector('.cxp-settings-overlay')) return;
  const previousFocus = document.activeElement;
  const overlay = el('div', 'cxp-settings-overlay');
  const panel = el('div', 'cxp-settings-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', tr('title'));
  const header = el('div', 'cxp-settings-header');
  const close = el('button', 'cxp-settings-close', '×'); close.setAttribute('aria-label', tr('close'));
  const dismiss = () => { overlay.remove(); if (previousFocus?.isConnected) previousFocus.focus(); };
  close.onclick = dismiss; header.append(el('span', '', tr('title')), close);
  const body = el('div', 'cxp-settings-body'); const sections = {};
  for (const key of ['account', 'models', 'permissions', 'tools', 'advanced']) {
    const group = el(key === 'advanced' ? 'details' : 'section', 'cxp-settings-section'); group.dataset.section = key;
    group.append(el(key === 'advanced' ? 'summary' : 'h3', 'cxp-settings-section-title', tr(key)));
    const content = el('div', 'cxp-settings-group'); group.append(content); sections[key] = content; body.append(group);
  }
  const result = el('div', 'cxp-settings-result'); result.setAttribute('role', 'status');
  const footer = el('div', 'cxp-settings-footer');
  panel.append(header, body, footer); overlay.append(panel); host.append(overlay);
  const error = message => { result.textContent = tr('error', { message }); result.dataset.error = 'true'; };
  overlay.onclick = event => { if (event.target === overlay) dismiss(); };
  overlay.onkeydown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
    if (event.key === 'Tab') {
      const controls = [...panel.querySelectorAll('button,select,input,summary,a[href]')].filter(n => !n.disabled && n.getClientRects().length);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }
  };
  close.focus();
  footer.append(result);
  const action = (label, fn) => {
    const button = el('button', 'cxp-btn cxp-btn-sm', label); button.type = 'button';
    button.onclick = async () => { button.disabled = true; try { await fn(); } catch (failure) { error(failure.message); } finally { if (button.isConnected) button.disabled = false; } };
    return button;
  };
  sections.account.append(el('div', 'cxp-settings-loading', tr('loading')));
  try {
    const [configData, mcpData, permissions, limits, requirements, accountData] = await Promise.allSettled([
      request('config_read', { cwd: tab.project || null, threadId: tab.threadId || null }), request('mcp_status'),
      request('permission_roots_list'), request('rate_limits_read'), request('config_requirements'),
      request('account_read'),
    ]);
    if (!overlay.isConnected || tab.closed) return;
    sections.account.replaceChildren();
    const details = el('div', 'cxp-settings-account-details'); details.dataset.codexAccountDetails = 'true';
    const currentAccount = accountData.status === 'fulfilled' ? (accountData.value?.accountState || account) : account;
    details.append(el('div', 'cxp-settings-value', currentAccount ? accountSummary(currentAccount, 'codex') : tr('defaultAccount')));
    const rateLimits = limits.status === 'fulfilled' ? limits.value?.rateLimits : null;
    const buckets = Object.values(rateLimits?.rateLimitsByLimitId || {});
    if (!buckets.length && rateLimits?.rateLimits) buckets.push(rateLimits.rateLimits);
    for (const bucket of buckets) {
      const percent = bucket.primary?.usedPercent;
      if (!Number.isFinite(percent)) continue;
      const time = bucket.primary?.resetsAt ? new Date(bucket.primary.resetsAt * 1000).toLocaleString(getLocale()) : tr('unknown');
      details.append(el('div', 'cxp-settings-hint', tr('usage', { name: bucket.limitName || bucket.limitId || 'Codex', percent: Math.round(percent), time })));
    }
    details.append(action(tr('manage'), () => { dismiss(); manageAccount(); })); sections.account.append(details);
    await mountCodexAccountSecurity({ host: sections.account, experimentalHost: sections.advanced, request, tab, capabilities });
    const runtime = tab.codexRuntime || {};
    sections.advanced.append(el('div', 'cxp-settings-hint cxp-settings-runtime', tr('runtime', { cli: runtime.cliVersion || tr('unknown'), sdk: runtime.sdkVersion || tr('unknown'), protocol: runtime.protocolBaseline || tr('unknown') })));
    if (runtime.codexBin) sections.advanced.append(el('div', 'cxp-settings-hint', runtime.codexBin));
    const mcp = el('div', ''); mcp.id = 'cxp-settings-mcp'; sections.tools.append(el('h4', 'cxp-settings-subtitle', tr('mcp')), mcp);
    async function renderMcp(data) {
      if (data.error) throw new Error(data.error);
      mcp.replaceChildren();
      for (const server of data.servers || []) {
        const row = el('div', 'cxp-mcp-row');
        const statusKey = server.requiresOAuth ? 'loginRequired' : server.status === 'running' ? 'running' : 'configured';
        const status = el('span', 'cxp-mcp-status', tr(statusKey)); status.dataset.status = server.status;
        row.append(el('span', 'cxp-mcp-name', server.name), status);
        if (server.alwaysAllowed) row.append(el('span', 'cxp-mcp-status', tr('alwaysAllowed')));
        row.append(
          action(tr('refresh'), async () => { await request('mcp_refresh', { name: server.name }); await renderMcp(await request('mcp_status')); }));
        if (server.alwaysAllowed) row.append(action(tr('revoke'), async () => {
          await request('mcp_approval_set', { name: server.name, approvalMode: 'prompt' }); await renderMcp(await request('mcp_status'));
        }));
        if (server.requiresOAuth) row.append(action(tr('authenticate'), () => authenticate(server.name)));
        mcp.append(row);
      }
      if (!mcp.childElementCount) mcp.append(el('div', 'cxp-settings-hint', tr('noMcp')));
    }
    if (mcpData.status === 'fulfilled') await renderMcp(mcpData.value); else error(mcpData.reason.message);
    const roots = el('div', ''); roots.id = 'cxp-settings-permissions';
    sections.permissions.append(el('h4', 'cxp-settings-subtitle', tr('folders')), roots);
    async function renderRoots(data) {
      if (data.error) throw new Error(data.error);
      roots.replaceChildren(); const fs = data.permissions?.filesystem || {};
      for (const access of ['write', 'read']) for (const path of fs[access] || []) {
        const row = el('div', 'cxp-mcp-row'); const name = el('span', 'cxp-mcp-name cxp-permission-root-path', path); name.title = path;
        row.append(name, el('span', 'cxp-mcp-status', tr(access)), action(tr('revoke'), async () => {
          await request('permission_root_remove', { access, path }); await renderRoots(await request('permission_roots_list'));
        })); roots.append(row);
      }
      if (!roots.childElementCount) roots.append(el('div', 'cxp-settings-hint', tr('none')));
    }
    if (permissions.status === 'fulfilled') await renderRoots(permissions.value); else error(permissions.reason.message);
    if (configData.status !== 'fulfilled' || configData.value.error) throw new Error(configData.value?.error || configData.reason.message);
    let cfg = normalizeConfig(configData.value.config).effective;
    let overrides = Object.fromEntries(Object.entries(SESSION_CONFIG_FIELDS).filter(([, field]) => Object.hasOwn(configData.value.sessionOverrides || {}, field)).map(([key, field]) => [key, overrideValue(field, configData.value.sessionOverrides[field])]));
    const schema = configData.value.settingsSchema;
    if (!schema?.fields) throw new Error(tr('noSchema'));
    const modelList = await models();
    let defs = [], inputs = {}, restrictions = {};
    const fields = {};
    for (const key of ['models', 'permissions', 'tools', 'advanced']) { fields[key] = el('div', 'cxp-config-form'); sections[key].prepend(fields[key]); }
    const scopeRow = el('label', 'cxp-config-row cxp-settings-scope'); scopeRow.append(el('span', '', tr('applyTo')));
    const scope = el('select', 'cxp-config-input'); scope.id = 'cxp-settings-scope'; scope.setAttribute('aria-label', tr('applyTo'));
    for (const [value, label] of [['saved', 'savedDefaults'], ['session', 'currentThread']]) { const o = el('option', '', tr(label)); o.value = value; o.disabled = value === 'session' && (!tab.threadId || !capabilityAvailability(capabilities, 'thread_settings_update').supported); scope.append(o); }
    scopeRow.append(scope); body.prepend(scopeRow);
    const scopeHint = el('div', 'cxp-settings-hint cxp-settings-scope-hint', tr('scopeHint')); scopeRow.after(scopeHint);
    const featureHost = el('details', 'cxp-settings-features'); featureHost.append(el('summary', 'cxp-settings-subtitle', tr('features'))); sections.tools.append(featureHost);
    const featureInputs = {};
    for (const feature of schema.features || []) {
      if (!['stable', 'beta'].includes(feature.stage) || feature.configurable === false) continue;
      const row = el('label', 'cxp-config-row'); row.append(el('span', 'cxp-config-label', feature.name));
      const input = el('button', 'cxp-settings-toggle'); input.type = 'button'; input.setAttribute('role', 'switch'); input.setAttribute('aria-label', feature.name); input.dataset.feature = feature.name;
      const restriction = configRestriction(requirements.status === 'fulfilled' ? requirements.value : {}, `features.${feature.name}`);
      input.dataset.fixed = String(typeof restriction.fixed === 'boolean');
      const set = value => { input.dataset.enabled = String(value); input.setAttribute('aria-checked', String(value)); input.textContent = tr(value ? 'on' : 'off'); };
      set(typeof restriction.fixed === 'boolean' ? restriction.fixed : feature.enabled);
      input.onclick = () => set(input.dataset.enabled !== 'true'); row.append(input); featureHost.append(row); featureInputs[feature.name] = { input, feature, set };
    }
    const save = action(tr('saveDefaults'), async () => {
      result.textContent = tr('saving'); delete result.dataset.error;
      const current = scope.value === 'session' ? { ...cfg, ...overrides } : cfg;
      const patch = configChanges(defs, inputs, current);
      let featureEdits = {};
      if (scope.value === 'session') {
        if (tab.running) throw new Error(tr('busy'));
        if (Object.keys(patch).length) await request('thread_settings_update', { threadId: tab.threadId, cwd: tab.project || null, ...sessionSettings(patch) });
      } else {
        const enablement = Object.fromEntries(Object.values(featureInputs).filter(({ input, feature }) => !input.disabled && (input.dataset.enabled === 'true') !== feature.enabled).map(({ input, feature }) => [feature.name, input.dataset.enabled === 'true']));
        featureEdits = enablement;
        const config = { ...patch, ...Object.fromEntries(Object.entries(enablement).map(([key, value]) => [`features.${key}`, value])) };
        if (Object.keys(config).length) await request('config_write', { config, cwd: tab.project || null });
      }
      // Always re-read the runtime. Never report success from an optimistic UI copy.
      const read = await request('config_read', { cwd: tab.project || null, threadId: tab.threadId || null });
      if (read.error) throw new Error(read.error);
      cfg = normalizeConfig(read.config).effective;
      overrides = Object.fromEntries(Object.entries(SESSION_CONFIG_FIELDS).filter(([, field]) => Object.hasOwn(read.sessionOverrides || {}, field)).map(([key, field]) => [key, overrideValue(field, read.sessionOverrides[field])]));
      for (const { input, feature, set } of Object.values(featureInputs)) {
        const actual = read.settingsSchema?.features?.find(f => f.name === feature.name);
        if (actual) { feature.enabled = actual.enabled; set(actual.enabled); }
      }
      renderFields(); onSaved({ scope: scope.value, patch, overrides });
      const effective = scope.value === 'session' ? { ...cfg, ...overrides } : cfg;
      const unapplied = Object.entries(patch).filter(([key, value]) => JSON.stringify(configValue(effective, key) ?? null) !== JSON.stringify(value));
      for (const [key, value] of Object.entries(featureEdits)) if (featureInputs[key]?.feature.enabled !== value) unapplied.push([key]);
      if (unapplied.length) throw new Error(tr('notApplied', { keys: unapplied.map(([key]) => key).join(', ') }));
      result.textContent = tr('saved');
    }); save.classList.add('cxp-config-save'); footer.prepend(save);
    function renderFields(selection) {
      const visible = scope.value === 'session' ? { ...cfg, ...overrides } : cfg;
      const values = selection || visible;
      defs = codexSettingsDefinitions(schema, modelList, values); inputs = {}; restrictions = {};
      for (const node of Object.values(fields)) node.replaceChildren();
      for (const def of defs) {
        if (scope.value === 'session' && !SESSION_CONFIG_FIELDS[def.key]) continue;
        const row = el('div', 'cxp-config-row'); const label = el('label', 'cxp-config-label', def.label);
        const input = el(def.type === 'number' ? 'input' : 'select', 'cxp-config-input');
        input.id = `cxp-setting-${def.key}`; input.dataset.configKey = def.key; label.htmlFor = input.id;
        const value = configValue(values, def.key);
        if (def.type === 'number') { input.type = 'number'; input.min = '1'; input.step = '1'; input.placeholder = tr('default'); }
        else {
          for (const option of def.options) { const o = el('option', '', option.label); o.value = option.value; input.append(o); }
          if (value != null && !def.options.some(o => o.value === String(value))) {
            const o = el('option', '', tr('configured', { value: typeof value === 'object' ? JSON.stringify(value) : value })); o.value = typeof value === 'object' ? JSON.stringify(value) : String(value); input.append(o); input.dataset.originalValue = JSON.stringify(value);
          }
        }
        input.value = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        const restriction = configRestriction(requirements.status === 'fulfilled' ? requirements.value : {}, def.key);
        restrictions[def.key] = restriction;
        input.disabled = Object.hasOwn(restriction, 'fixed');
        for (const o of input.options || []) if (o.value && restriction.allowed && !restriction.allowed.some(v => JSON.stringify(v) === JSON.stringify(o.value))) o.disabled = true;
        const layer = normalizeConfig(configData.value.config).layers[def.key];
        if (layer || restriction.reason) input.title = tr(restriction.reason ? 'managed' : 'source', { layer });
        inputs[def.key] = input; row.append(label, input);
        if (def.type === 'number') row.append(el('span', 'cxp-settings-unit', tr('tokens')));
        fields[def.section].append(row);
      }
      const modelInput = inputs.model;
      if (modelInput) modelInput.onchange = () => {
        const draft = { ...values };
        for (const def of defs) if (inputs[def.key]) draft[def.key] = inputs[def.key].value || null;
        draft.model_reasoning_effort = null; draft.service_tier = null; renderFields(draft);
      };
      for (const { input } of Object.values(featureInputs)) input.disabled = scope.value === 'session' || input.dataset.fixed === 'true';
      featureHost.hidden = scope.value === 'session';
      for (const key of ['models', 'permissions', 'tools', 'advanced']) sections[key].closest('.cxp-settings-section').hidden = scope.value === 'session' && !fields[key].childElementCount;
      save.textContent = tr(scope.value === 'session' ? 'applyThread' : 'saveDefaults');
    }
    scope.onchange = () => renderFields(); renderFields();
  } catch (failure) { error(failure.message); }
  return { overlay, sections };
}
