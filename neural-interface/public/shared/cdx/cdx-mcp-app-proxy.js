import { appProxyOrigin, approvedAppCsp, buildAppSrcdoc, APP_INNER_SANDBOX, APP_RESOURCE_LIMIT, validAppMessage, validAppResponse, plainObject } from './cdx-mcp-app.js';

const parentOrigin = appProxyOrigin(location.origin);
let inner = null;
let revoked = false;
const revoke = () => {
  if (revoked) return;
  revoked = true;
  inner?.remove(); inner = null;
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-navigation-blocked', params: {} }, parentOrigin);
};
const sandboxMessage = data => typeof data?.method === 'string' && data.method.startsWith('ui/notifications/sandbox-');
// Responses are relayed too; only the host consumes its own teardown response.
const rpc = data => validAppMessage(data) || validAppResponse(data);

if (parentOrigin && parent !== window) {
  // A blocked child navigation can produce a CSP violation without a load.
  document.addEventListener('securitypolicyviolation', event => {
    if (event.effectiveDirective === 'frame-src') revoke();
  });
  addEventListener('message', event => {
    if (revoked) return;
    if (event.source === parent && event.origin === parentOrigin) {
      const data = event.data;
      if (sandboxMessage(data)) {
        // This host-only transport packet carries up to 2 MB of HTML, unlike
        // the app's JSON-RPC params (1 MB). buildAppSrcdoc enforces its cap.
        if (!plainObject(data) || data.jsonrpc !== '2.0' || 'id' in data || !plainObject(data.params)
          || data.method !== 'ui/notifications/sandbox-resource-ready' || inner) return;
        try {
          const csp = approvedAppCsp({ csp: data.params?.csp }, [location.origin, parentOrigin]);
          const srcdoc = buildAppSrcdoc(data.params?.html, csp);
          inner = document.createElement('iframe');
          inner.title = 'MCP app view';
          inner.setAttribute('sandbox', APP_INNER_SANDBOX);
          inner.setAttribute('allow', '');
          inner.referrerPolicy = 'no-referrer';
          let loaded = false;
          inner.addEventListener('load', () => {
            if (loaded) revoke();
            else loaded = true;
          });
          inner.srcdoc = srcdoc;
          document.body.append(inner);
        } catch { /* Invalid HTML/resources are never inserted anywhere else. */ }
        return;
      }
      if (!validAppMessage(data) && !validAppResponse(data, APP_RESOURCE_LIMIT * 2)) return;
      inner?.contentWindow.postMessage(data, '*');
    } else if (inner && event.source === inner.contentWindow && event.origin === 'null') {
      if (!rpc(event.data) || sandboxMessage(event.data)) return;
      parent.postMessage(event.data, parentOrigin);
    }
  });
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, parentOrigin);
}
