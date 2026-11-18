// SynaBun's "Connect your browser" page (/extension-setup on SynaBun's own app port; the manifest's content_scripts
// names exactly that origin and path, and the copy SynaBun prepares names the port it runs on). This script tells the
// page the extension is installed, and hands the service worker the page's one-time pairing token. Nothing else.
//
// It runs in the isolated world, top frame only, and acts only on that exact origin and path (checked again here and
// by the service worker against sender.url). It never reads anything but the one ticket element the page fills in,
// sends nothing anywhere but to this extension's service worker, and keeps no token: the service worker decides
// whether to pair (only an extension that needs pairing does) and the server accepts a token once.
(() => {
  const allowed = (() => {
    try {
      const own = chrome.runtime.getManifest().content_scripts || [];
      return own.flatMap(entry => entry.js?.includes('setup-content.js') ? entry.matches || [] : [])
        .map(pattern => { const u = new URL(pattern.replace(/\*$/, '')); return `${u.origin}${u.pathname}`; });
    } catch { return []; }
  })();
  if (window.top !== window || location.protocol !== 'http:' || !allowed.includes(`${location.origin}${location.pathname}`)) return;
  const root = document.documentElement;
  // The page shows "Extension found" from this; it holds the version only.
  root.dataset.synabunExtension = String(chrome.runtime.getManifest().version || '');
  let sent = '';
  async function offer() {
    const ticket = document.getElementById('synabun-setup-ticket');
    const token = ticket?.dataset.token || '', bridgePort = Number(ticket?.dataset.bridgePort);
    if (!/^[a-f0-9]{64}$/.test(token) || token === sent) return;
    sent = token;
    root.dataset.synabunPair = 'sent';
    let answer;
    try { answer = await chrome.runtime.sendMessage({ kind: 'synabun-setup-pair', token, bridgePort }); }
    catch { answer = { ok: false, code: 'EXTENSION_UNAVAILABLE' }; }
    // The page reads the outcome's code only (pairing itself is reported by the server's status).
    root.dataset.synabunPair = answer?.ok ? 'started' : String(answer?.code || 'REFUSED').replace(/[^A-Z_]/g, '').slice(0, 40);
  }
  new MutationObserver(() => { void offer(); }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-token'] });
  void offer();
})();
