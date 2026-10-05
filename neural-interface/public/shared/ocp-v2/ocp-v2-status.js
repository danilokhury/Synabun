// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — environment popover ("Manage" in the Context settings popover)
// What the session's OpenCode serve is running with: MCP servers (switch one,
// sign in to one, add one), language servers, formatters, references (attach
// one to the prompt), the version and an update notice. The notice is only a notice: nothing here upgrades the
// binary. Rows and texts are decided in ocp-v2-status-logic.js. It has no
// button of its own: the panel opens it through the controller it returns.
// ─────────────────────────────────────────────────────────────────────────────

import { api, supports, onEvent, capabilities } from './ocp-v2-ws.js';
import { getDefaultStore } from './ocp-v2-state.js';
import { replyFailed, replyError } from './ocp-v2-caps.js';
import {
  mcpRowView, updateNoticeText, isProviderCatalogEvent, addMcpServer, createSignInFailures,
} from './ocp-v2-status-logic.js';
import { openProviderSettings } from './ocp-v2-settings-link.js';
import { captureBinding, boundReader, onRebind } from './ocp-v2-binding.js';
import { createConfirmations } from './ocp-v2-confirm-logic.js';
import { syncConfirmRow } from './ocp-v2-confirm.js';

// Page-wide facts learned from events, shared by every panel.
let _updateAvailable = '';
const _listeners = new Set();
const notifyAll = () => { for (const fn of _listeners) { try { fn(); } catch { /* listener's problem */ } } };
/** The OpenCode version an update notice named, '' when there is none. */
export const updateAvailableVersion = () => _updateAvailable;
// Sign-in pages OpenCode could not open itself, each kept for the session and
// the server whose sign-in it is (never one global link for every popover),
// and only for as long as that sign-in's request is out: when a link goes
// (the request ended, expired, or another one for that server name began),
// every open popover is painted again.
const _signInFailures = createSignInFailures({ onChange: () => notifyAll() });

onEvent((eventType, ev) => {
  if (eventType === 'installation.update-available' && ev?.version) { _updateAvailable = String(ev.version); notifyAll(); }
  else if (eventType === 'installation.updated') { _updateAvailable = ''; notifyAll(); }
  else if (eventType === 'mcp.browser.open.failed' && ev?.url) { if (_signInFailures.record({ mcpName: ev.mcpName, url: ev.url })) notifyAll(); }
  else if (eventType === 'mcp.tools.changed' || eventType === 'lsp.updated') notifyAll();
  // The model catalog or a provider connection changed: every picker re-reads it.
  else if (isProviderCatalogEvent(eventType) && typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('ocp-providers-changed'));
  }
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * opts.onAttachPath(path)  attach a path to the prompt being written (a
 *                          reference's "Attach"); without it the link is absent.
 */
export function mountEnvironmentPopover(panelEl, store = getDefaultStore(), opts = {}) {
  if (!panelEl) return { element: null, open() {}, close() {}, toggle() {}, isOpen: () => false, destroy() {} };

  const pop = el('div', 'ocpv2-env-popover');
  pop.hidden = true;
  panelEl.appendChild(pop);

  // The MCP rows of the session on screen. They, the note under the add form
  // and its "Adding…" state belong to the binding they were read or started
  // on, and are dropped when the panel is bound to another session.
  let rows = [];
  let loading = false;
  // The "add a server" form survives the popover's re-renders.
  const addForm = { open: false, name: '', input: '', note: '', error: false, busy: false };
  // Starting a command is asked in the popover, in two steps
  // (ocp-v2-confirm-logic.js). The question sits under the form, also after
  // the popover was painted again.
  const confirms = createConfirmations({ store });
  let confirmHost = null;
  let confirmAnchor = null;
  confirms.onChange(() => syncConfirmRow(confirms, confirmHost, 'env', () => confirmAnchor));
  // One read of the environment at a time, for the binding it was asked on:
  // an answer for a session the panel has left paints nothing here.
  const readEnvironment = boundReader(store);

  function section(title) {
    const wrap = el('div', 'ocpv2-env-section');
    wrap.appendChild(el('div', 'ocpv2-session-menu-note', title));
    pop.appendChild(wrap);
    return wrap;
  }

  function line(parent, name, state, tone, note) {
    const row = el('div', 'ocpv2-env-row');
    row.appendChild(el('span', 'ocpv2-env-name', name));
    if (state) row.appendChild(el('span', `ocpv2-env-state ocpv2-env-${tone || 'muted'}`, state));
    parent.appendChild(row);
    if (note) parent.appendChild(el('div', 'ocpv2-env-note', note));
    return row;
  }

  async function switchMcp(row, view) {
    const at = captureBinding(store);
    const params = { sessionId: at.sessionId, name: row.name, cwd: at.cwd || undefined };
    // Connecting or signing in may need a browser page: should OpenCode fail
    // to open it, the link is this session's and this server's.
    // The attempt is open for as long as its request is out, and no longer.
    const attempt = view.action !== 'disconnect' ? _signInFailures.expect(at.sessionId, row.name) : null;
    const call = view.action === 'authenticate' ? api.mcpAuthenticate(params)
      : view.action === 'disconnect' ? api.mcpDisconnect(params)
      : api.mcpConnect(params);
    const res = await call.catch((err) => ({ ok: false, error: err?.message }));
    attempt?.done();
    // The answer is about that session's serve. On another binding the
    // popover already shows (or is reading) the new session's servers.
    if (!at.isCurrent()) return;
    if (replyFailed(res)) store.pushError({ message: replyError(res, `Could not ${view.action} ${row.name}`) });
    await render();
  }

  // "Add a server…": a name and a command line or a URL. SynaBun's own entry
  // is not editable here (the name is refused before anything is sent).
  function renderAddServer(parent, s) {
    if (!s.sessionId || !supports('mcp:add')) return;
    const toggle = el('button', 'ocpv2-permission-link', addForm.open ? 'Cancel' : 'Add a server…');
    toggle.type = 'button';
    toggle.addEventListener('click', () => { addForm.open = !addForm.open; addForm.note = ''; confirms.cancel(); render(); });
    parent.appendChild(toggle);
    if (addForm.note) parent.appendChild(el('div', `ocpv2-env-note${addForm.error ? ' ocpv2-env-error' : ''}`, addForm.note));
    if (!addForm.open) return;

    const form = el('div', 'ocpv2-permission-reason');
    const name = el('input', 'ocpv2-permission-reason-input');
    name.type = 'text';
    name.placeholder = 'Name';
    name.maxLength = 64;
    name.value = addForm.name;
    name.addEventListener('input', () => { addForm.name = name.value; });
    const input = el('input', 'ocpv2-permission-reason-input');
    input.type = 'text';
    input.placeholder = 'Command (npx -y some-mcp) or URL (https://…)';
    input.maxLength = 2000;
    input.value = addForm.input;
    input.addEventListener('input', () => { addForm.input = input.value; });
    const add = el('button', 'ocpv2-permission-btn ocpv2-perm-allow', addForm.busy ? 'Adding…' : 'Add');
    add.type = 'button';
    add.disabled = addForm.busy;
    const submit = async () => {
      if (addForm.busy) return;
      addForm.busy = true;
      addForm.note = '';
      add.disabled = true;
      add.textContent = 'Adding…';
      // Read once: the store hands out its live state, and the confirm is awaited.
      const at = captureBinding(store);
      const { sessionId: targetSessionId, cwd: targetCwd } = at;
      const result = await addMcpServer({
        name: addForm.name,
        input: addForm.input,
        rows,
        // A command-based server is a program on this machine: the exact
        // command and arguments are shown under the form, and it starts
        // only with the second click there (never a native dialog: an
        // automated browser accepts those by itself).
        confirm: (text) => confirms.ask({ key: 'mcp-start', surface: 'env', text, confirmLabel: 'Start this command' }),
        // One request registers it on this session's serve and saves it. The
        // Settings route is not used: it would start the server a second time
        // on the shared serve.
        canPersist: supports('feature:mcp-add-persist'),
        register: ({ name: serverName, config, persist }) => {
          // A remote server may ask for a sign-in as soon as it starts.
          const attempt = _signInFailures.expect(targetSessionId, serverName);
          return api.mcpAdd({
            sessionId: targetSessionId, name: serverName, config, persist, cwd: targetCwd || undefined,
          }).finally(() => attempt.done());
        },
      });
      // The server was added to (or refused by) the session the form was
      // submitted on. On another binding its note is not shown: the form
      // there was reset when the panel moved.
      if (!at.isCurrent()) return;
      addForm.busy = false;
      addForm.error = !result.ok && !result.cancelled;
      addForm.note = result.ok ? result.note : (result.cancelled ? '' : result.error);
      if (result.ok) { addForm.open = false; addForm.name = ''; addForm.input = ''; }
      render();
    };
    add.addEventListener('click', submit);
    for (const field of [name, input]) {
      field.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
    }
    form.append(name, input, add);
    parent.appendChild(form);
    // The question of a start that is waiting for its second click.
    confirmHost = parent;
    confirmAnchor = form;
    syncConfirmRow(confirms, confirmHost, 'env', () => confirmAnchor);
    parent.appendChild(el('div', 'ocpv2-env-note', supports('feature:mcp-add-persist')
      ? 'It starts in this session now and is saved to the OpenCode config for later ones. A command is confirmed before it runs. Leading KEY=value words set its environment.'
      : 'It starts in this session now. A command is confirmed before it runs. Leading KEY=value words set its environment.'));
  }

  async function render() {
    if (pop.hidden) return;
    const s = store.getState();
    pop.textContent = '';

    const version = section('OpenCode');
    line(version, s.serverVersion ? `Version ${s.serverVersion}` : 'Version unknown', s.serverStatus || '', s.serverStatus === 'ready' ? 'ok' : 'warn');
    const notice = updateNoticeText(_updateAvailable, s.serverVersion);
    if (notice) version.appendChild(el('div', 'ocpv2-env-note ocpv2-env-warn', notice));
    const providers = el('button', 'ocpv2-permission-link', 'Providers and sign-in (Settings)');
    providers.type = 'button';
    providers.addEventListener('click', () => { close(); openProviderSettings(); });
    version.appendChild(providers);

    if (!supports('mcp:status')) {
      pop.appendChild(el('div', 'ocpv2-session-menu-empty', 'Restart SynaBun to see MCP servers, language servers and formatters here.'));
      return;
    }

    const mcp = section('MCP servers');
    if (loading) mcp.appendChild(el('div', 'ocpv2-env-note', 'Loading…'));
    await readEnvironment(
      (at) => Promise.all([
        api.mcpStatus({ sessionId: at.sessionId, cwd: at.cwd || undefined }).catch((err) => ({ ok: false, error: err?.message })),
        supports('env:status') ? api.envStatus({ sessionId: at.sessionId, cwd: at.cwd || undefined }).catch(() => null) : null,
      ]),
      ([status, env], at) => paintEnvironment(mcp, status, env, at),
    );
  }

  // Runs only for the latest read, and only while the panel is still on the
  // binding (`at`) it was made for: rows, references and their Attach links
  // of another session never reach this popover.
  function paintEnvironment(mcp, status, env, at) {
    if (pop.hidden) return;
    mcp.textContent = '';
    mcp.appendChild(el('div', 'ocpv2-session-menu-note', 'MCP servers'));
    if (replyFailed(status)) {
      mcp.appendChild(el('div', 'ocpv2-env-note', replyError(status, 'Could not read the MCP servers')));
    } else {
      rows = Array.isArray(status.data) ? status.data : [];
      if (!rows.length) mcp.appendChild(el('div', 'ocpv2-env-note', 'None configured.'));
      for (const row of rows) {
        const view = mcpRowView(row);
        const node = line(mcp, view.name, view.label, view.tone, view.note);
        if (view.action && at.sessionId && supports(`mcp:${view.action}`)) {
          const action = el('button', 'ocpv2-permission-link', view.actionLabel);
          action.type = 'button';
          action.addEventListener('click', () => { action.disabled = true; switchMcp(row, view); });
          node.appendChild(action);
        }
      }
      // Only the sign-in pages of this session's own servers (`at` is the
      // binding these rows were read for).
      for (const failed of _signInFailures.forSession(at.sessionId, rows)) {
        const manual = el('div', 'ocpv2-env-note');
        manual.appendChild(document.createTextNode(`Open this page to sign in to ${failed.mcpName || 'the server'}: `));
        const link = el('a', 'ocpv2-inline-action', 'Open');
        if (/^https?:\/\//i.test(failed.url)) link.href = failed.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        manual.appendChild(link);
        mcp.appendChild(manual);
      }
      renderAddServer(mcp, at);
    }

    if (env && !replyFailed(env)) {
      const lsp = section('Language servers');
      if (!env.data.lsp?.length) lsp.appendChild(el('div', 'ocpv2-env-note', 'None running yet: they start when a file of their language is read.'));
      for (const server of env.data.lsp || []) line(lsp, server.name, server.status, server.status === 'connected' ? 'ok' : 'error', server.root);
      const fmt = section('Formatters');
      if (!env.data.formatter?.length) fmt.appendChild(el('div', 'ocpv2-env-note', 'None.'));
      for (const formatter of env.data.formatter || []) {
        line(fmt, formatter.name, formatter.enabled ? 'enabled' : 'disabled', formatter.enabled ? 'ok' : 'muted', formatter.extensions.join(' '));
      }
      if (env.data.references?.length) {
        const refs = section('References');
        for (const ref of env.data.references) {
          const row = line(refs, ref.name, '', 'muted', ref.description || ref.path);
          if (!ref.path || typeof opts.onAttachPath !== 'function') continue;
          // The reference goes to the prompt as a referenced path (a chip above the box).
          const attach = el('button', 'ocpv2-permission-link', 'Attach');
          attach.type = 'button';
          // (Painted only for the binding on screen: a rebinding repaints the
          // popover before anything in it can be clicked.)
          attach.addEventListener('click', () => { close(); opts.onAttachPath(ref.path); });
          row.appendChild(attach);
        }
      }
    }
  }

  // A popover that is closed asks nothing: the start that was waiting is off.
  function close() { pop.hidden = true; confirms.cancel(); }
  function open() {
    if (!pop.hidden) return;
    pop.hidden = false;
    loading = true;
    render().finally(() => { loading = false; });
  }
  function toggle() { if (pop.hidden) open(); else close(); }
  const onDocDown = (event) => {
    if (pop.hidden || event.target.closest('.ocpv2-env-popover')) return;
    close();
  };
  document.addEventListener('mousedown', onDocDown);

  const refresh = () => { if (!pop.hidden) render(); };
  _listeners.add(refresh);
  // Bound to another session: the rows, the form's note and its busy state
  // were the previous session's. (What was typed in the form is a draft and
  // stays.) The store's session:set event below re-reads an open popover.
  const unsubscribeRebind = onRebind(store, () => {
    rows = [];
    addForm.note = '';
    addForm.error = false;
    addForm.busy = false;
  });
  const unsubscribeStore = store.subscribe((event) => {
    if (event?.type === 'server:status' || event?.type === 'session:set') refresh();
  });
  const unsubscribeCaps = capabilities.subscribe(refresh);

  return {
    element: pop,
    open,
    close,
    toggle,
    isOpen: () => !pop.hidden,
    destroy() {
      _listeners.delete(refresh);
      try { unsubscribeRebind(); } catch {}
      try { unsubscribeStore(); } catch {}
      try { unsubscribeCaps(); } catch {}
      document.removeEventListener('mousedown', onDocDown);
      confirms.destroy();
      pop.remove();
    },
  };
}
