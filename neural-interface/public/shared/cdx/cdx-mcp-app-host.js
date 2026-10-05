import {
  APP_OUTER_SANDBOX, APP_PROTOCOL_VERSION, APP_MESSAGE_LIMIT, plainObject,
  appProxyOrigin, acceptAppResource, approvedAppCsp, validAppEvent, validAppResponse, appMethodRoute,
  createAppCallGate, validateAppResources, appToolOutcome, appArgumentDisplay,
} from './cdx-mcp-app.js';

const controllers = new WeakMap();
const mounted = new Set();
const live = new Set();
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
};
const button = (text, action, primary = false) => {
  const el = node('button', `cxp-request-btn${primary ? '' : ' secondary'}`, text);
  el.type = 'button'; el.addEventListener('click', action); return el;
};
const rpcError = (code, message) => Object.assign(new Error(message), { code });

// Host geometry, including scrolling and transcript changes, must be stable for
// 800 ms. Check synchronously on activation too, before the next animation tick.
function armPrompt(box, controls, frameNode) {
  let active = true, timer = null, geometry = '', armedAt = Infinity;
  const measure = () => [box, ...controls, frameNode()].filter(Boolean).map(el => {
    const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(',');
  }).join(';');
  const check = () => {
    const next = measure();
    if (next !== geometry) { geometry = next; armedAt = performance.now() + 800; }
    const armed = performance.now() >= armedAt;
    controls.forEach(el => { el.disabled = !armed; });
    return armed;
  };
  controls.forEach(el => {
    el.disabled = true;
    el.addEventListener('click', event => {
      if (!active || !check() || event.detail > 1) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
  });
  const tick = () => { if (!active) return; check(); timer = requestAnimationFrame(tick); };
  tick();
  return () => { active = false; cancelAnimationFrame(timer); controls.forEach(el => { el.disabled = true; }); };
}

function promptText(text) {
  const pre = node('pre', 'cxp-card-pre', text);
  pre.style.cssText = 'max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--cxp-fs-md);';
  pre.tabIndex = 0; return pre;
}
const capability = tab => tab?.role !== 'assistant' && !tab?.assistantSession
  && tab?.codexCapabilities?.mcp_app_resource_read?.supported === true
  && tab?.codexCapabilities?.mcp_app_tool_call?.supported === true;

function hostContext(card, mode) {
  const computed = getComputedStyle(card);
  const variables = {};
  for (const [standard, token] of Object.entries({
    '--color-background-primary': '--cxp-shell', '--color-background-secondary': '--cxp-pop',
    '--color-text-primary': '--cxp-text', '--color-text-secondary': '--cxp-text-2',
    '--color-text-tertiary': '--cxp-text-3', '--color-border-primary': '--cxp-border',
    '--font-sans': '--cxp-font', '--font-mono': '--cxp-mono',
    '--color-ring-primary': '--cxp-focus', '--border-radius-sm': '--cxp-radius-sm',
    '--border-radius-md': '--cxp-radius-md', '--border-radius-lg': '--cxp-radius-lg',
  })) {
    const value = computed.getPropertyValue(token).trim(); if (value) variables[standard] = value;
  }
  return { theme: 'dark', displayMode: mode, availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: { width: card.getBoundingClientRect().width, maxHeight: 600 },
    locale: navigator.language, platform: 'web', userAgent: navigator.userAgent, styles: { variables } };
}

export function mountMcpAppCard({ card, item, tab, request, draft, host = card?.closest('.codex-panel') }) {
  if (!card || !item || item.type !== 'mcpToolCall') return;
  let controller = controllers.get(card);
  if (controller) {
    if (!capability(tab)) { controller.dispose(); return; }
    controller.update(item); return controller;
  }
  const uri = item.mcpAppUi?.resourceUri || item.mcpAppResourceUri;
  if (!uri || !item.server || !capability(tab)) {
    const saved = card.querySelector('[data-mcp-app]'); if (saved) saved.replaceChildren(); return;
  }
  const body = card.querySelector(':scope > .cxp-card-body'); if (!body) return;
  // Snapshot HTML contains only call data, never the downloaded view or frame.
  card.querySelector('[data-mcp-app]')?.remove();
  const section = node('section', 'cxp-card-section'); section.dataset.mcpApp = '1';
  const actions = node('div', 'cxp-request-actions');
  const status = node('div', 'cxp-request-note'); status.setAttribute('role', 'status');
  const viewSlot = node('div', 'cxp-card-section');
  const approvals = node('div', 'cxp-card-section');
  const proxyOrigin = appProxyOrigin(location.origin);
  const threadId = tab.threadId;
  const server = item.server;
  const originCallId = item.id;
  let fullscreen = item.mcpAppUi?.preferredModelDisplayMode === 'fullscreen';
  let currentItem = item, frame = null, initialized = false, initializing = false, outcomeSent = false;
  let closing = false, opening = false, epoch = 0, overlay = null, displayMode = 'inline', teardownId = null, finishTeardown = null, constrainFocus = null;
  let approvedCsp = { connectDomains: [], resourceDomains: [] };
  const callGate = createAppCallGate();
  const resourceGate = createAppCallGate();
  const prompts = new Map();
  let pendingLink = false, pendingDraft = false;
  const current = () => !closing && !tab.closed && tab.threadId === threadId && capability(tab);
  const send = packet => frame?.contentWindow?.postMessage({ jsonrpc: '2.0', ...packet }, proxyOrigin);
  const replyForView = (message, result, error) => {
    if (!current() || !('id' in message)) return;
    send({ id: message.id, ...(error ? { error: { code: error.code || -32000, message: error.message || 'App request failed.' } } : { result }) });
  };
  const notify = (method, params) => { if (initialized && current()) send({ method, params }); };
  const outcome = () => {
    const result = appToolOutcome(currentItem);
    if (initialized && !outcomeSent && result) { outcomeSent = true; notify(result.method, result.params); }
  };
  const bridge = (type, params) => {
    if (!current()) return Promise.reject(rpcError(-32000, 'App view is closed.'));
    return request(tab, type, { ...params, threadId, server, originCallId }, { timeoutMs: 30000 });
  };
  const setMode = mode => {
    if (prompts.size) return;
    if (!['inline', 'fullscreen'].includes(mode)) throw rpcError(-32601, 'Unsupported display mode.');
    if (!frame) throw rpcError(-32000, 'Open the app first.');
    if (mode === 'fullscreen' && !overlay) {
      if (typeof frame.showPopover !== 'function') throw rpcError(-32601, 'Display expansion is unavailable in this browser.');
      const previousFocus = document.activeElement;
      overlay = node('div', 'cxp-settings-overlay');
      const panel = node('div', 'cxp-settings-panel'); panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', 'Embedded MCP app');
      const header = node('div', 'cxp-settings-header');
      const close = button('Back to card', () => { setMode('inline'); previousFocus?.focus(); });
      const dismiss = button('Close app', () => { void controller.close(); previousFocus?.focus(); });
      const contents = node('div', 'cxp-settings-body');
      header.append(node('span', '', 'Embedded MCP app'), close, dismiss); panel.append(header, contents); overlay.append(panel);
      (host || card).append(overlay);
      // Reparenting reloads an iframe. A manual popover promotes this exact
      // iframe to the top layer, escaping transcript containment and clipping
      // while preserving its browsing context and the two-frame isolation.
      frame.setAttribute('popover', 'manual'); frame.showPopover();
      const bounds = panel.getBoundingClientRect();
      contents.style.minHeight = `${Math.min(600, Math.max(80, innerHeight - header.getBoundingClientRect().bottom))}px`;
      frame.style.position = 'fixed'; frame.style.left = `${bounds.left}px`;
      frame.style.top = `${header.getBoundingClientRect().bottom}px`; frame.style.width = `${bounds.width}px`;
      frame.style.height = '600px'; frame.style.maxHeight = `calc(100vh - ${header.getBoundingClientRect().bottom}px)`;
      frame.style.margin = '0'; frame.style.padding = '0'; frame.style.background = 'var(--cxp-pop)';
      frame.style.zIndex = String((Number.parseInt(getComputedStyle(overlay).zIndex, 10) || 0) + 1);
      overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); setMode('inline'); previousFocus?.focus(); }
        // The iframe is a focus stop; the opaque view manages its own controls.
        if (event.key === 'Tab' && event.shiftKey && document.activeElement === close) { event.preventDefault(); frame.focus(); }
      });
      constrainFocus = event => { if (overlay && event.target !== frame && !overlay.contains(event.target)) close.focus(); };
      (host || card).addEventListener('focusin', constrainFocus);
      close.focus();
    } else if (mode === 'inline' && overlay) {
      frame.hidePopover(); frame.removeAttribute('popover');
      (host || card).removeEventListener('focusin', constrainFocus); constrainFocus = null;
      for (const key of ['position', 'left', 'top', 'maxHeight', 'zIndex']) frame.style[key] = '';
      frame.style.background = ''; frame.style.width = '100%'; frame.style.height = '320px'; overlay.remove(); overlay = null;
    }
    displayMode = mode; notify('ui/notifications/host-context-changed', hostContext(card, mode));
  };
  const removePrompt = box => { prompts.get(box)?.(); prompts.delete(box); box.remove(); };
  const addPrompt = (box, choices) => {
    if (displayMode === 'fullscreen') setMode('inline');
    box.append(choices); approvals.append(box);
    prompts.set(box, armPrompt(box, [...choices.querySelectorAll('button')], () => frame));
  };
  const clearPending = () => {
    callGate.decline(); prompts.forEach(stop => stop()); prompts.clear();
    pendingLink = false; pendingDraft = false; approvals.replaceChildren();
  };
  let closePromise = null;
  const closeView = async (reason = 'View closed') => {
    if (closing) return;
    closing = true; epoch++; opening = false; live.delete(controller); clearPending();
    window.removeEventListener('message', readyListener);
    readyListener = null;
    const oldFrame = frame;
    if (oldFrame && initialized) {
      teardownId = `teardown-${crypto.randomUUID()}`;
      const settled = new Promise(resolve => { finishTeardown = resolve; });
      send({ id: teardownId, method: 'ui/resource-teardown', params: { reason } });
      await Promise.race([settled, new Promise(resolve => setTimeout(resolve, 150))]);
    }
    window.removeEventListener('message', onMessage);
    (host || card).removeEventListener('focusin', constrainFocus); constrainFocus = null;
    oldFrame?.remove(); frame = null; overlay?.remove(); overlay = null;
    initialized = false; initializing = false; outcomeSent = false; displayMode = 'inline';
    viewSlot.replaceChildren(); status.textContent = ''; actions.replaceChildren(openButton);
    openButton.disabled = !proxyOrigin; closing = false;
  };
  const close = reason => {
    if (!closePromise) closePromise = closeView(reason).finally(() => { closePromise = null; });
    return closePromise;
  };
  const onMessage = async event => {
    if (event.source !== frame?.contentWindow || event.origin !== proxyOrigin) return;
    const message = event.data;
    if (closing) {
      if (validAppResponse(message) && message.id === teardownId && plainObject(message.result)) finishTeardown?.();
      return;
    }
    if (!current() || !validAppEvent(event, frame.contentWindow, proxyOrigin)) return;
    const messageEpoch = epoch;
    const reply = (message, result, error) => { if (epoch === messageEpoch) replyForView(message, result, error); };
    if (message.method === 'ui/notifications/sandbox-navigation-blocked') {
      await close('App attempted navigation');
      status.textContent = 'App closed after a navigation attempt.'; return;
    }
    if (message.method.startsWith('ui/notifications/sandbox-')) return;
    const route = appMethodRoute(message.method);
    // All requests except initialize require a completed initialize handshake.
    if (!initialized && !['initialize', 'initialized'].includes(route)) return;
    try {
      const params = message.params ?? {};
      if (!plainObject(params)) throw rpcError(-32602, 'Object params required.');
      switch (route) {
        case 'initialize':
          if (!('id' in message) || initializing || initialized) throw rpcError(-32600, 'Already initialized.');
          initializing = true;
          reply(message, { protocolVersion: APP_PROTOCOL_VERSION, hostInfo: { name: 'SynaBun Codex panel', version: '1' },
            hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, message: { text: true }, sandbox: { csp: approvedCsp, permissions: {} } },
            hostContext: hostContext(card, displayMode) });
          break;
        case 'initialized':
          if (!initializing || initialized || 'id' in message) return;
          initialized = true;
          notify('ui/notifications/tool-input', { arguments: plainObject(currentItem.arguments) ? currentItem.arguments : {} }); outcome();
          break;
        case 'approve-tool': {
          if (!('id' in message) || typeof params.name !== 'string' || !params.name.trim() || params.name.length > 256
            || (params.arguments != null && !plainObject(params.arguments)) || (params.server != null && params.server !== server)) throw rpcError(-32602, 'Invalid tool request.');
          let display; try { display = appArgumentDisplay(params.arguments ?? {}); }
          catch (error) { throw rpcError(-32602, error.message); }
          const approvedCall = { ...message, params: { ...params, arguments: display.arguments } };
          if (!callGate.offer(approvedCall)) throw rpcError(-32000, 'A tool approval or call is pending, or the rate limit was reached.');
          const box = node('div', 'cxp-card-section');
          box.append(node('div', 'cxp-request-note', `${server} · ${params.name}`),
            node('div', 'cxp-request-note', `Complete arguments: ${display.size.toLocaleString()} UTF-8 bytes (64 KiB maximum).`), promptText(display.text));
          const choices = node('div', 'cxp-request-actions');
          choices.append(button('Allow once', async () => {
            if (epoch !== messageEpoch || !current()) return;
            prompts.get(box)?.();
            try {
              const result = await callGate.allow(call => bridge('mcp_app_tool_call', { tool: call.params.name, arguments: call.params.arguments || {}, approved: true }));
              reply(message, result.result);
            } catch (error) { reply(message, null, rpcError(error.code || -32000, 'App tool call failed.')); }
            finally { removePrompt(box); }
          }, true), button('Decline', () => { callGate.decline(); reply(message, null, rpcError(-32000, 'Tool call declined.')); removePrompt(box); }));
          addPrompt(box, choices); break;
        }
        case 'read-resource': {
          if (!('id' in message) || typeof params.uri !== 'string' || params.uri.length > 4096
            || (params.server != null && params.server !== server)) throw rpcError(-32602, 'Invalid resource request.');
          if (!resourceGate.offer(message)) throw rpcError(-32000, 'Resource call or rate limit reached.');
          try {
            const result = await resourceGate.allow(call => bridge('mcp_app_resource_read', { uri: call.params.uri }));
            reply(message, validateAppResources(result.resource));
          } catch { reply(message, null, rpcError(-32000, 'Resource read failed or exceeded 2 MB.')); }
          break;
        }
        case 'approve-link': {
          if (!('id' in message) || pendingLink || !callGate.rate()) throw rpcError(-32000, 'A link prompt is pending, or the rate limit was reached.');
          if (typeof params.url !== 'string' || params.url.length > 4096) throw rpcError(-32602, 'Invalid link.');
          let url; try { url = new URL(params.url); } catch { throw rpcError(-32602, 'Invalid link.'); }
          if (url.protocol !== 'https:' || url.username || url.password) throw rpcError(-32602, 'HTTPS links only.');
          pendingLink = true;
          const box = node('div', 'cxp-card-section'); box.append(promptText(url.href));
          const choices = node('div', 'cxp-request-actions');
          choices.append(button(`Open ${url.host}`, () => { if (epoch !== messageEpoch || !current()) return; window.open(url.href, '_blank', 'noopener,noreferrer'); reply(message, {}); pendingLink = false; removePrompt(box); }, true),
            button('Decline', () => { reply(message, null, rpcError(-32000, 'Link declined.')); pendingLink = false; removePrompt(box); }));
          addPrompt(box, choices); break;
        }
        case 'draft': {
          if (params.role !== 'user' || params.content?.type !== 'text' || typeof params.content.text !== 'string'
            || params.content.text.length > 32000 || !resourceGate.rate()) throw rpcError(-32602, 'A bounded text draft is required.');
          if (!('id' in message) || pendingDraft) throw rpcError(-32000, 'A draft prompt is already pending or a request id is missing.');
          pendingDraft = true;
          const text = params.content.text;
          const box = node('div', 'cxp-card-section'); box.append(node('div', 'cxp-request-note', 'Insert this text into your draft?'), promptText(text));
          const choices = node('div', 'cxp-request-actions');
          choices.append(button('Insert draft', () => {
            if (epoch !== messageEpoch || !current()) return;
            draft?.(tab, text); reply(message, {}); pendingDraft = false; removePrompt(box);
          }, true), button('Decline', () => { reply(message, null, rpcError(-32000, 'Draft declined.')); pendingDraft = false; removePrompt(box); }));
          addPrompt(box, choices); break;
        }
        case 'resize':
          if (!prompts.size && Number.isFinite(params.height)) frame.style.height = `${Math.min(600, Math.max(80, params.height))}px`;
          break;
        case 'teardown': void close('App requested teardown'); break;
        case 'log':
          // Count and level only. Never log resource bodies, arguments or results.
          if (resourceGate.rate()) { tab.mcpAppDebugLog ||= []; tab.mcpAppDebugLog.push({ at: Date.now(), level: ['debug', 'info', 'warning', 'error'].includes(params.level) ? params.level : 'info' }); tab.mcpAppDebugLog = tab.mcpAppDebugLog.slice(-20); }
          break;
        case 'ping': reply(message, {}); break;
        case 'display-mode': reply(message, { mode: displayMode }); break;
        default: reply(message, null, rpcError(-32601, 'Unsupported app method.'));
      }
    } catch (error) { reply(message, null, rpcError(error.code || -32000, error.code ? error.message : 'App request failed.')); }
  };
  const open = async () => {
    if (!proxyOrigin || !current() || opening || frame) return;
    const peers = [...live].filter(entry => entry.tab === tab);
    live.add(controller); opening = true; const ticket = ++epoch;
    openButton.disabled = true; status.textContent = 'Loading app…';
    try {
      // Reserve before yielding: simultaneous opens count opening views too.
      if (peers.length >= 3) await peers[0].close('View limit reached');
      if (!current() || ticket !== epoch) return;
      const result = await bridge('mcp_app_resource_read', { uri, appResource: true });
      if (!current() || ticket !== epoch) return;
      const resource = acceptAppResource(result.resource, uri);
      approvedCsp = approvedAppCsp(resource.meta, [location.origin, proxyOrigin]);
      const domains = [...new Set([...approvedCsp.connectDomains, ...approvedCsp.resourceDomains])];
      const declarations = ['connectDomains', 'resourceDomains'].flatMap(key => {
        const values = resource.meta?.csp?.[key];
        return (Array.isArray(values) ? values : []).filter(value => {
          try { return typeof value !== 'string' || !approvedCsp[key].includes(new URL(value).origin); } catch { return true; }
        }).map(value => `${key}: ${String(value)}`);
      });
      const load = () => {
        if (!current() || ticket !== epoch || frame) return;
        frame = node('iframe'); frame.title = `App · ${server} · ${currentItem.tool || 'tool'}`;
        frame.setAttribute('sandbox', APP_OUTER_SANDBOX); frame.setAttribute('allow', ''); frame.referrerPolicy = 'no-referrer';
        frame.style.cssText = 'display:block;width:100%;height:320px;border:1px solid var(--cxp-border);';
        frame.src = `${proxyOrigin}/shared/cdx/cdx-mcp-app-proxy.html`;
        const ready = event => {
          if (!current() || ticket !== epoch || !validAppEvent(event, frame?.contentWindow, proxyOrigin)
            || event.data.method !== 'ui/notifications/sandbox-proxy-ready') return;
          window.removeEventListener('message', ready);
          readyListener = null;
          send({ method: 'ui/notifications/sandbox-resource-ready', params: { html: resource.html, csp: approvedCsp } });
        };
        readyListener = ready; window.addEventListener('message', ready); window.addEventListener('message', onMessage);
        viewSlot.append(frame); status.textContent = '';
        actions.replaceChildren(button('Close app', () => { void close(); }));
        if (fullscreen) { const expand = button('Expand', () => setMode('fullscreen')); expand.dataset.mcpExpand = '1'; actions.append(expand); }
      };
      if (domains.length || declarations.length) {
        status.style.cssText = 'max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;';
        status.textContent = `Scripts, styles and resources: ${approvedCsp.resourceDomains.join(', ') || 'none'}\nConnections only: ${approvedCsp.connectDomains.join(', ') || 'none'}\nIgnored declarations: ${declarations.join(', ') || 'none'}`;
        actions.replaceChildren(button('Allow domains and open', load, true), button('Cancel', () => { void close(); }));
      } else load();
    } catch (error) {
      if (ticket === epoch && current()) {
        live.delete(controller); status.textContent = 'App unavailable or resource rejected.'; openButton.disabled = false;
        if (error.category === 'unsupported') { actions.replaceChildren(); status.textContent = 'Embedded apps are unsupported by this Codex CLI.'; }
      }
    } finally { if (ticket === epoch) opening = false; }
  };
  let readyListener = null;
  const openButton = button(proxyOrigin ? 'Open app' : 'Embedded apps need the app opened on localhost', () => { void open(); });
  openButton.disabled = !proxyOrigin;
  actions.append(openButton); section.append(actions, status, viewSlot, approvals); body.append(section);
  controller = { tab, card, close: async reason => { window.removeEventListener('message', readyListener); await close(reason); },
    update(next) {
      currentItem = { ...currentItem, ...next };
      fullscreen = currentItem.mcpAppUi?.preferredModelDisplayMode === 'fullscreen';
      if (frame && !closing) {
        const expand = actions.querySelector('[data-mcp-expand]');
        if (fullscreen && !expand) { const control = button('Expand', () => setMode('fullscreen')); control.dataset.mcpExpand = '1'; actions.append(control); }
        else if (!fullscreen) expand?.remove();
      }
      const saved = JSON.stringify(currentItem);
      // Bound snapshot metadata, excluding any downloaded resource.
      if (new TextEncoder().encode(saved).length <= APP_MESSAGE_LIMIT) section.dataset.appItem = saved;
      outcome();
    }, dispose() { void controller.close('Card removed').then(() => section.remove()); mounted.delete(controller); controllers.delete(card); },
  };
  controllers.set(card, controller); mounted.add(controller); controller.update(item);
  return controller;
}

export function restoreMcpAppCards(root, context) {
  for (const section of root?.querySelectorAll('[data-mcp-app]') || []) {
    if (section.closest('[data-mcp-retired]')) continue;
    let item; try { item = JSON.parse(section.dataset.appItem || 'null'); } catch { /* Invalid snapshot. */ }
    const card = section.closest('.cxp-card');
    if (item && item.id === card?.dataset.itemId) mountMcpAppCard({ ...context, card, item });
    else section.remove();
  }
  for (const state of context.items?.values?.() || []) {
    if (state._lastItem?.type === 'mcpToolCall') mountMcpAppCard({ ...context, card: state.el, item: state._lastItem });
  }
}

export function teardownMcpApps(tab = null, reason = 'Panel closed') {
  for (const controller of mounted) if (!tab || controller.tab === tab) void controller.close(reason);
}

export function disposeMcpApps(tab) {
  for (const controller of mounted) if (controller.tab === tab) controller.dispose();
}

// DOM owners can synchronously retire cards while leaving their iframe in
// place for the bounded teardown handshake. Never reparent an active iframe.
export function retireMcpAppNode(node, remove) {
  const entries = [...mounted].filter(controller => node === controller.card || node.contains(controller.card));
  if (!entries.length) { remove(); return; }
  node.hidden = true; node.dataset.mcpRetired = '1';
  void Promise.all(entries.map(async controller => {
    await controller.close('Transcript removed'); controller.dispose();
  })).then(remove);
}

// Snapshot serialization omits runtime frames and transient approvals entirely.
export function stripMcpAppRuntime(root) {
  root.querySelectorAll('[data-mcp-retired]').forEach(node => node.remove());
  for (const section of root.querySelectorAll('[data-mcp-app]')) {
    section.replaceChildren();
  }
}
