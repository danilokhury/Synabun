import { getCodexModelName, mergeCodexModelOptions } from '../agent-runtime-options.js';
import { codexModelAccessMetadata } from './cdx-protocol.js';

export const codexModelAccountKey = tab => String(tab?.accountId || 'default');

// Only successful live discovery supplies capabilities. Fallback choices are
// presentation data and must never turn a failed request into a cache hit.
export class CodexModelCatalog {
  constructor({ request, isReady, onChange = () => {} }) {
    this.requestModels = request;
    this.isReady = isReady;
    this.onChange = onChange;
    this.accounts = new Map();
  }

  state(tab) {
    const key = codexModelAccountKey(tab);
    if (!this.accounts.has(key)) {
      this.accounts.set(key, { status: 'idle', models: null, error: '', pending: null });
    }
    return this.accounts.get(key);
  }

  choices(tab) {
    return this.state(tab).models ?? mergeCodexModelOptions([]);
  }

  invalidate(tab) {
    const state = this.state(tab);
    const pending = state.pending;
    state.pending = null;
    state.status = 'idle';
    state.error = '';
    pending?.controller.abort();
    this.onChange(codexModelAccountKey(tab));
  }

  disconnect(tab) {
    // A different tab on the same account may still own a valid request.
    if (this.state(tab).pending?.tab === tab) this.invalidate(tab);
  }

  request(tab, { force = false } = {}) {
    if (!tab || tab.closed) return Promise.resolve([]);
    const account = codexModelAccountKey(tab);
    const state = this.state(tab);
    if (!this.isReady(tab)) {
      this.disconnect(tab);
      return Promise.resolve(this.choices(tab));
    }
    const previous = state.pending;
    if (previous?.isCurrent() && (!force || previous.tab === tab)) return previous.promise;
    if (!force && state.status === 'ready') return Promise.resolve(this.choices(tab));

    const epoch = tab.connectionEpoch;
    const socket = tab.ws;
    const pending = { tab, controller: new AbortController() };
    pending.isCurrent = () => state.pending === pending
      && codexModelAccountKey(tab) === account
      && tab.connectionEpoch === epoch && tab.ws === socket && this.isReady(tab);
    state.pending = pending;
    state.status = 'loading';
    state.error = '';
    previous?.controller.abort();
    // Register the transport request before the ready callback can release an
    // inactive tab's idle socket. The response still settles asynchronously.
    let response;
    try { response = this.requestModels(tab, pending.controller.signal); }
    catch (error) { response = Promise.reject(error); }
    pending.promise = Promise.resolve(response)
      .then(message => {
        if (!pending.isCurrent()) return;
        if (message?.error) throw new Error(message.error);
        if (!Array.isArray(message?.models)) throw new Error('Codex returned an invalid model list.');
        state.models = mergeCodexModelOptions(message.models, { fallback: false }).map(option => {
          const native = message.models.find(model => getCodexModelName(model) === option.id);
          return { ...option, availableAccessPrograms: native?.availableAccessPrograms || null,
            desc: [option.desc, codexModelAccessMetadata(native)].filter(Boolean).join(' · ') };
        });
        state.status = 'ready';
      })
      .catch(error => {
        if (!pending.isCurrent()) return;
        state.status = 'error';
        state.error = error?.message || 'Could not load model capabilities.';
      })
      .finally(() => {
        if (state.pending !== pending) return;
        state.pending = null;
        // A closed or replaced connection cannot leave the account loading.
        if (state.status === 'loading') state.status = 'idle';
        this.onChange(account);
      })
      .then(() => this.choices(tab));
    this.onChange(account);
    return pending.promise;
  }
}

export function codexContextAvailability({ tab, catalog, model, connected }) {
  if (!tab) return { supported: false, reason: 'Open a Codex conversation first.', retry: false };
  const baseline = Number(model?.contextWindow), maximum = Number(model?.maxContextWindow);
  const complete = Number.isFinite(baseline) && baseline > 0 && Number.isFinite(maximum) && maximum >= baseline;
  const supported = catalog.status === 'ready' && complete && maximum > baseline && model?.supportsExtendedContext === true;
  let reason = '', retry = false;
  if (!connected) reason = 'Waiting for the Codex connection to load model capabilities.';
  else if (catalog.status === 'idle' || catalog.status === 'loading') reason = 'Loading model capabilities…';
  else if (catalog.status === 'error') {
    reason = 'Could not load model capabilities. Retry to check extended context.';
    retry = true;
  } else if (!model) reason = 'The selected model is not in this account’s current model list.';
  else if (!complete) {
    reason = 'Codex has not reported context capabilities for this model. Retry to check again.';
    retry = true;
  } else if (!supported) reason = 'Extended context is not advertised for the selected model and account.';
  const busy = tab.compacting ? 'Wait for compaction to finish before changing context.'
    : tab.startingThread ? 'Wait for the conversation to start before changing context.'
      : tab.running ? 'Wait for the current reply to finish before changing context.' : '';
  return { supported: supported && connected, reason: busy || reason, retry, busy: !!busy };
}
