// Isolated world only. No page message relay, eval, cookies, storage or credential access.
(() => {
  if (globalThis.__synabunBridgeInstalled) return;
  globalThis.__synabunBridgeInstalled = true;
  let generation = crypto.randomUUID().replaceAll('-', ''), documentUrl = location.href;
  const uploadParts = new Map();
  const refs = new Map(), ids = new WeakMap(); let serial = 0, navigation = null;
  function invalidate() { refs.clear(); generation = crypto.randomUUID().replaceAll('-', ''); documentUrl = location.href; }
  globalThis.addEventListener?.('pageshow', event => { if (event.persisted) invalidate(); });
  const error = code => { throw Object.assign(new Error(code), { code }); };
  const removed = records => {
    for (const r of records) for (const node of r.removedNodes) {
      for (const [ref, el] of refs) if (el === node || node.contains?.(el)) refs.delete(ref);
    }
  };
  const observer = new MutationObserver(removed);
  observer.observe(document, { childList: true, subtree: true });
  function target(args, active = false) {
    removed(observer.takeRecords());
    if (args.ref) {
      const el = refs.get(args.ref);
      if (!args.ref.startsWith(`e${generation}_`) || !el?.isConnected) error('STALE_REF');
      return el;
    }
    if (!args.selector && active) return document.activeElement;
    const found = [...document.querySelectorAll(args.selector || 'body')];
    if (!found.length) error('NO_MATCH');
    if (found.length > 1 && args.nthMatch === undefined) error('AMBIGUOUS_TARGET');
    const el = found[args.nthMatch || 0]; if (!el) error('NO_MATCH'); return el;
  }
  function safeNode(el) {
    if (el?.matches('input[type=password],input[autocomplete=current-password],input[autocomplete=new-password],input[autocomplete=one-time-code]')) error('UNSUPPORTED_IN_EXTENSION_MODE');
  }
  // SynaBun's own addresses (protocol.js controlSurface, repeated here: a content script cannot import). A loopback or
  // unspecified address, localhost, or one of this computer's names, on one of SynaBun's ports; or a public alias.
  const bare = h => String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  function synabunAddress(u, blocked = {}) {
    const host = bare(u.hostname), port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if ((blocked.blockedHosts || []).some(x => bare(x) === host)) return true;
    if (!(blocked.blockedPorts || []).includes(port)) return false;
    return host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1'
      || /^127\.\d+\.\d+\.\d+$/.test(host) || /^::ffff:(127\.|0\.0\.0\.0$)/.test(host) || /^::ffff:7f[0-9a-f]{2}:/.test(host)
      || (blocked.selfHosts || []).some(x => bare(x) === host);
  }
  // Where a link or a form may lead. Restricted mode: an approved site only. Full control (`sites` null): any http(s)
  // page but SynaBun's own, and the page's own script links (javascript:, mailto:, tel:); never a browser page.
  function checkedUrl(url, sites, blocked) {
    const u = new URL(url, location.href);
    if (sites === null) {
      if (['javascript:', 'mailto:', 'tel:'].includes(u.protocol)) return;
      if (!['http:', 'https:'].includes(u.protocol)) error('RESTRICTED_PAGE');
      if (synabunAddress(u, blocked)) error('SYNABUN_PAGE_BLOCKED');
      return;
    }
    if (!['http:', 'https:'].includes(u.protocol) || !sites.includes(u.origin) || u.username || u.password) error('SITE_NOT_APPROVED');
  }
  // The page this command runs on is one the mode allows.
  function pageAllowed(sites, blocked) {
    if (sites === null) { if (synabunAddress(new URL(location.href), blocked)) error('SYNABUN_PAGE_BLOCKED'); }
    else if (!sites.includes(location.origin)) error('SITE_NOT_APPROVED');
  }
  const event = (el, name) => el.dispatchEvent(new Event(name, { bubbles: true }));
  function setValue(el, value) {
    safeNode(el);
    if (el.isContentEditable) el.textContent = value;
    else {
      const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) error('UNSUPPORTED_IN_EXTENSION_MODE'); setter.call(el, value);
    }
    event(el, 'input'); event(el, 'change');
  }
  async function execute({ op, args, sites, blocked, downloads, nav, until }) {
    // A message from before full control carries a site list; one with neither refuses everything.
    if (sites !== null && !Array.isArray(sites)) error('SITE_NOT_APPROVED');
    // The command's deadline as a system-clock time. Checked on arrival and right before every page effect: an action
    // dispatched just before the deadline but delivered (or reached) after it does nothing. A missing one refuses all.
    const due = () => { if (!(typeof until === 'number' && Date.now() < until)) error('TIMEOUT'); };
    due();
    pageAllowed(sites, blocked);
    if (documentUrl !== location.href) invalidate();
    // The engine changes the tab's token on every back/forward. A document that survived the traversal (bfcache, or
    // a same-document entry with the same URL) still gets a new generation, so no earlier ref acts on it.
    if (typeof nav === 'string' && nav !== navigation) { if (navigation !== null) invalidate(); navigation = nav; }
    const state = () => ({ ok: true, url: location.href, title: document.title.slice(0, 1000) });
    if (op === 'snapshot') {
      const root = args.selector ? target(args) : document.body;
      const nodes = [root, ...root.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable],h1,h2,h3,p,li')];
      const lines = []; let size = 0;
      for (const el of nodes.slice(0, 3000)) {
        if (!el.isConnected || el.hidden || !el.getClientRects().length || el.matches('input[type=hidden],input[type=password]')) continue;
        let ref = ids.get(el);
        if (!ref || !refs.has(ref)) { ref = `e${generation}_${++serial}`; ids.set(el, ref); refs.set(ref, el); }
        const role = el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }[el.tagName]) || el.tagName.toLowerCase();
        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300);
        const line = `- ${role} ${JSON.stringify(label)} [ref=${ref}]`;
        if (size + line.length > Math.min(args.maxChars || 30000, 100000)) break;
        size += line.length + 1; lines.push(line);
      }
      return { ...state(), mode: 'ai', snapshotId: generation, snapshotText: lines.join('\n') };
    }
    if (op === 'content') {
      const root = args.selector ? target(args) : document.body;
      const content = (root.innerText || '').slice(args.offset || 0, (args.offset || 0) + Math.min(args.maxChars || 30000, 100000));
      return { ...state(), content, text: content };
    }
    if (op === 'wait') {
      // A wait never runs past the deadline: one that would answers TIMEOUT there (decided up front, so a timer that
      // wakes a fraction of a millisecond early cannot turn it into a success).
      if (!args.selector) {
        const ms = Math.min(args.timeout ?? 1000, 15000), left = until - Date.now();
        await new Promise(r => setTimeout(r, Math.max(0, Math.min(ms, left))));
        if (ms >= left) error('TIMEOUT');
        due(); return state();
      }
      const end = Math.min(Date.now() + Math.min(args.timeout ?? 5000, 15000), until);
      do {
        due(); pageAllowed(sites, blocked);
        const el = args.selector ? document.querySelector(args.selector) : document.body;
        const visible = !!el?.getClientRects().length;
        if ((args.state === 'hidden' || args.state === 'detached') ? !el || !visible : !!el && (args.state === 'attached' || visible)) return state();
        await new Promise(r => setTimeout(r, 100));
      } while (Date.now() < end);
      error('TIMEOUT');
    }
    if (op === 'scroll') {
      const el = args.selector || args.ref ? target(args) : document.scrollingElement;
      const amount = Math.min(args.distance ?? 600, 10000);
      due(); el.scrollBy({ top: ['up', 'down'].includes(args.direction) ? amount * (args.direction === 'up' ? -1 : 1) : 0,
        left: ['left', 'right'].includes(args.direction) ? amount * (args.direction === 'left' ? -1 : 1) : 0, behavior: 'instant' }); return state();
    }
    const el = target(args, ['type', 'press'].includes(op)); safeNode(el);
    if (op === 'click') {
      const link = el.closest('a[href]'); if (link) {
        checkedUrl(link.href, sites, blocked);
        if (link.hasAttribute('download')) {
          if (!downloads) error('PERMISSION_REQUIRED');
          return { ...state(), downloadUrl: link.href };
        }
      }
      if (el.form) checkedUrl(el.form.action || location.href, sites, blocked);
      due(); el.click();
    } else if (op === 'hover') {
      due(); el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseenter'));
    } else if (op === 'fill') { due(); setValue(el, args.value || ''); }
    else if (op === 'type') { due(); el.focus(); setValue(el, (el.isContentEditable ? el.textContent : el.value || '') + (args.text || '')); }
    else if (op === 'select') {
      if (!(el instanceof HTMLSelectElement) || ![...el.options].some(o => o.value === args.value)) error('NO_MATCH');
      due(); el.value = args.value; event(el, 'input'); event(el, 'change');
    } else if (op === 'press') {
      if (!['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace', 'Delete'].includes(args.key)) error('UNSUPPORTED_IN_EXTENSION_MODE');
      due(); el.dispatchEvent(new KeyboardEvent('keydown', { key: args.key, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: args.key, bubbles: true }));
    } else if (op === 'upload') {
      if (!el.matches('input[type=file]')) error('NO_MATCH');
      const transfer = new DataTransfer();
      if (!el.multiple && args.files.length > 1) error('UPLOAD_MULTIPLE');
      const parts = uploadParts.get(args.uploadId);
      uploadParts.delete(args.uploadId);
      args.files.forEach((name, index) => {
        const file = new File(parts?.[index] || [], name, { type: 'application/octet-stream' });
        if (file.size !== args.sizes[index]) error('OPERATION_FAILED');
        transfer.items.add(file);
      });
      due(); el.files = transfer.files; event(el, 'input'); event(el, 'change');
    } else error('UNSUPPORTED_IN_EXTENSION_MODE');
    return state();
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.kind === 'synabun-upload-part') {
      const { id, index, data, until } = message;
      if (!(Date.now() < until)) { respond({ ok: false, code: 'TIMEOUT' }); return; }
      if (!uploadParts.has(id)) {
        uploadParts.set(id, []);
        setTimeout(() => uploadParts.delete(id), until - Date.now());
      }
      const parts = uploadParts.get(id);
      const decoded = atob(data);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      (parts[index] ||= []).push(bytes);
      respond({ ok: true }); return;
    }
    if (message?.kind !== 'synabun-fixed-command') return;
    execute(message).then(respond, error => respond({ ok: false, code: error.code || 'OPERATION_FAILED' }));
    return true;
  });
})();
