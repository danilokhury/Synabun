// Pure MCP Apps boundaries, shared by the panel, static proxy and server.
export const APP_RESOURCE_LIMIT = 2 * 1024 * 1024;
export const APP_MESSAGE_LIMIT = 1024 * 1024;
export const APP_ARGUMENT_DISPLAY_LIMIT = 64 * 1024;
export const APP_PROTOCOL_VERSION = '2025-06-18';
export const APP_OUTER_SANDBOX = 'allow-scripts allow-same-origin allow-forms';
export const APP_INNER_SANDBOX = 'allow-scripts allow-forms';
const bytes = value => new TextEncoder().encode(value).length;
const validBase64 = value => typeof value === 'string' && value.length % 4 === 0
  && !/[^A-Za-z0-9+/=]/.test(value) && /^(?:[^=]*)(?:={1,2})?$/.test(value)
  && value.length <= Math.ceil(APP_RESOURCE_LIMIT / 3) * 4;
export const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function appProxyOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) return null;
    url.hostname = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    return url.origin;
  } catch { return null; }
}

// Reject IP literals entirely (including public ones), ambiguous numeric hosts,
// local DNS suffixes and wildcards. Exact HTTPS origins only; no DNS resolution.
export function filterAppDomains(values, ownOrigins = [], limit = 20) {
  const ownHosts = ownOrigins.flatMap(origin => { try { return [new URL(origin).hostname]; } catch { return []; } });
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (result.length >= Math.min(20, limit)) break;
    if (typeof value !== 'string' || value.length > 512 || !/^https:\/\//.test(value)) continue;
    const raw = value;
    try {
      const url = new URL(raw);
      const host = url.hostname;
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') continue;
      if (/[\s*]/.test(raw) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host)
        || host.split('.').some(label => label.startsWith('-') || label.endsWith('-') || label.length > 63)
        || /(?:^|\.)(?:localhost|local|internal|home|lan|test-local)$/.test(host)
        || /[\d.]$/.test(host) || host.includes(':')) continue;
      if (ownHosts.includes(host)) continue;
      const origin = url.origin;
      if (!result.includes(origin)) result.push(origin);
    } catch { /* Reject malformed declarations. */ }
  }
  return result;
}

export function approvedAppCsp(meta = {}, ownOrigins = []) {
  const connectDomains = filterAppDomains(meta?.csp?.connectDomains, ownOrigins);
  const resourceDomains = filterAppDomains(meta?.csp?.resourceDomains, ownOrigins, 20 - connectDomains.length);
  return { connectDomains, resourceDomains };
}

export function buildAppCsp(csp = {}) {
  // Refilter even approved inputs: the static proxy never trusts host HTML/CSP.
  const safe = approvedAppCsp({ csp });
  const resources = safe.resourceDomains.join(' ');
  return ["default-src 'none'", `script-src 'unsafe-inline'${resources ? ` ${resources}` : ''}`,
    `style-src 'unsafe-inline'${resources ? ` ${resources}` : ''}`,
    `img-src data: blob:${resources ? ` ${resources}` : ''}`,
    `media-src data: blob:${resources ? ` ${resources}` : ''}`,
    `font-src data:${resources ? ` ${resources}` : ''}`,
    `connect-src ${safe.connectDomains.length ? safe.connectDomains.join(' ') : "'none'"}`,
    "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "webrtc 'block'"].join('; ');
}

export function buildAppSrcdoc(html, csp = {}) {
  if (typeof html !== 'string' || bytes(html) > APP_RESOURCE_LIMIT) throw new Error('App resource exceeds 2 MB.');
  const policy = buildAppCsp(csp).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  // The first policy is enforced even if later resource bytes contain their own
  // doctype, head, CSP or base. Later policies can only restrict it further.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta http-equiv="x-dns-prefetch-control" content="off"></head><body>${html}</body></html>`;
}

// The complete display is also the immutable JSON snapshot approved for sending.
export function appArgumentDisplay(value = {}) {
  if (!plainObject(value)) throw new Error('Tool arguments must be an object.');
  const text = JSON.stringify(value, null, 2);
  const size = bytes(text);
  if (size > APP_ARGUMENT_DISPLAY_LIMIT) throw new Error('Tool arguments exceed the 64 KiB display cap.');
  return { text, size, arguments: JSON.parse(text) };
}

export function decodedAppContent(content) {
  if (!plainObject(content) || typeof content.uri !== 'string') throw new Error('Invalid resource content.');
  if (typeof content.text === 'string' && content.blob == null) {
    if (bytes(content.text) > APP_RESOURCE_LIMIT) throw new Error('Resource exceeds 2 MB.');
    return content.text;
  }
  if (!validBase64(content.blob) || content.text != null) throw new Error('Invalid resource blob.');
  const decoded = Uint8Array.from(atob(content.blob), char => char.charCodeAt(0));
  if (decoded.length > APP_RESOURCE_LIMIT) throw new Error('Resource exceeds 2 MB.');
  return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
}

export function acceptAppResource(result, uri) {
  if (typeof uri !== 'string' || !uri.startsWith('ui://')) throw new Error('App resources require ui://.');
  const content = result?.contents?.find(entry => entry?.uri === uri);
  if (content?.mimeType !== 'text/html;profile=mcp-app') throw new Error('Resource is not an MCP app.');
  return { html: decodedAppContent(content), meta: plainObject(content._meta?.ui) ? content._meta.ui : {} };
}

export function validateAppResources(result) {
  if (!Array.isArray(result?.contents)) throw new Error('Invalid resource response.');
  let size = 0;
  for (const content of result.contents) {
    if (!plainObject(content) || typeof content.uri !== 'string') throw new Error('Invalid resource content.');
    // Blob resources need not be UTF-8 for resources/read, but are still capped.
    if (typeof content?.blob === 'string') {
      if (content.text != null || !validBase64(content.blob)) throw new Error('Invalid resource blob.');
      size += atob(content.blob).length;
    } else size += bytes(decodedAppContent(content));
    if (size > APP_RESOURCE_LIMIT) throw new Error('Resources exceed 2 MB.');
  }
  return result;
}

export function validAppMessage(message) {
  if (!plainObject(message) || message.jsonrpc !== '2.0') return false;
  if ('id' in message && !(typeof message.id === 'string' && message.id.length <= 256)
    && !(typeof message.id === 'number' && Number.isFinite(message.id))) return false;
  if (typeof message.method !== 'string' || !message.method || message.method.length > 100) return false;
  try { if (bytes(JSON.stringify(message.params ?? {})) > APP_MESSAGE_LIMIT) return false; } catch { return false; }
  return true;
}

export function validAppEvent(event, source, origin) {
  return event.source === source && event.origin === origin && validAppMessage(event.data);
}

export function validAppResponse(message, limit = APP_MESSAGE_LIMIT) {
  if (!plainObject(message) || message.jsonrpc !== '2.0' || 'method' in message
    || !(typeof message.id === 'string' && message.id.length <= 256 || typeof message.id === 'number' && Number.isFinite(message.id))
    || !('result' in message || 'error' in message)) return false;
  try { return bytes(JSON.stringify(message)) <= limit; } catch { return false; }
}

export const APP_METHOD_ROUTES = Object.freeze({
  'ui/initialize': 'initialize', 'ui/notifications/initialized': 'initialized',
  'tools/call': 'approve-tool', 'resources/read': 'read-resource',
  'ui/open-link': 'approve-link', 'ui/message': 'draft',
  'ui/notifications/size-changed': 'resize', 'ui/notifications/request-teardown': 'teardown',
  'notifications/message': 'log', ping: 'ping', 'ui/request-display-mode': 'display-mode',
});
export const appMethodRoute = method => Object.hasOwn(APP_METHOD_ROUTES, method) ? APP_METHOD_ROUTES[method] : 'unsupported';

export function createAppCallGate({ now = Date.now, limit = 5, interval = 10000 } = {}) {
  let pending = null, inFlight = false, hits = [];
  const rate = () => {
    const time = now(); hits = hits.filter(hit => time - hit < interval);
    if (hits.length >= limit) return false;
    hits.push(time); return true;
  };
  return {
    offer(call) { if (pending || inFlight || !rate()) return false; pending = call; return true; },
    decline() { const call = pending; pending = null; return call; },
    async allow(bridge) {
      if (!pending || inFlight) throw new Error('Explicit approval required.');
      const call = pending; pending = null; inFlight = true;
      try { return await bridge(call); } finally { inFlight = false; }
    },
    rate,
  };
}

export function appToolOutcome(item) {
  const status = typeof item?.status === 'string' ? item.status : Object.keys(item?.status || {})[0];
  if (/failed|declined|cancel|error/i.test(status || '') || item?.error) return { method: 'ui/notifications/tool-cancelled', params: { reason: 'Tool call failed or was declined.' } };
  if (!/^(completed|complete|done|success)$/.test(status || '') && !item?._synabunCompleted) return null;
  const result = item?.result;
  return { method: 'ui/notifications/tool-result', params: {
    content: Array.isArray(result?.content) ? result.content : [],
    ...(result?.structuredContent != null ? { structuredContent: result.structuredContent } : {}),
    ...(typeof result?.isError === 'boolean' ? { isError: result.isError } : {}),
    ...(plainObject(result?._meta) ? { _meta: result._meta } : {}),
  } };
}
