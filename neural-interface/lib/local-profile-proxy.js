/**
 * The proxy relay of a local browser profile (lib/local-profiles.js), and the "check proxy" request.
 *
 * Chrome takes no proxy credentials on its command line and has no SOCKS5 login at all. So a local profile whose
 * proxy has a username and a password gets one relay of its own on 127.0.0.1: Chrome is started with
 * `--proxy-server=http://127.0.0.1:<port>`, and the relay sends what Chrome asks for (CONNECT and plain-HTTP requests)
 * to the upstream proxy with the login: `Proxy-Authorization` for an HTTP or HTTPS proxy, the username/password
 * handshake of RFC 1929 for SOCKS5. A proxy without a login needs none of this and goes straight to Chrome.
 *
 * It fails closed. The relay opens connections to the upstream proxy and to nothing else: when the upstream refuses
 * or cannot be reached the request is answered 502, never sent directly. When the relay itself is down Chrome's proxy
 * points at a dead port, so pages fail there too.
 *
 * The relay listens on loopback only and asks no login of its own (Chrome could not send one): whatever on this
 * computer reaches its port goes out through the profile's proxy. A guarded worker's sandbox denies these ports
 * (server.js workerBrowserControlPorts).
 *
 * Built-ins only. ESM, Node >= 22.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export const PROXY_TYPES = Object.freeze(['none', 'http', 'https', 'socks5']);
/** Where "check proxy" asks for the exit address. */
export const CHECK_PROXY_URL = 'https://api.ipify.org?format=json';
const CONNECT_TIMEOUT_MS = 20000;
const MAX_HEAD_BYTES = 64 * 1024;

function proxyError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** Whether a profile's proxy needs the relay: a proxy with a login (a username; the password may be empty). */
export function proxyNeedsRelay(proxy) {
  return !!proxy && proxy.type !== 'none' && PROXY_TYPES.includes(proxy.type) && !!proxy.host && !!proxy.username;
}

/** What Chrome is given as `--proxy-server` for a proxy without a login, or null for none. */
export function directProxyServer(proxy) {
  if (!proxy || proxy.type === 'none' || !PROXY_TYPES.includes(proxy.type) || !proxy.host || !proxy.port) return null;
  const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  return `${proxy.type}://${host}:${proxy.port}`;
}

function onceConnected(socket, event, timeoutMs, what) {
  return new Promise((resolveP, rejectP) => {
    const done = (fn, value) => { clearTimeout(timer); socket.off('error', onError); socket.off(event, onOk); fn(value); };
    const onOk = () => done(resolveP, socket);
    const onError = (err) => done(rejectP, proxyError('PROXY_UNREACHABLE', `${what} could not be reached (${err?.code || err?.message || err})`));
    const timer = setTimeout(() => { socket.destroy(); done(rejectP, proxyError('PROXY_TIMEOUT', `${what} did not answer in ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    timer.unref?.();
    socket.once(event, onOk);
    socket.once('error', onError);
  });
}

/** Reads from `socket` until `enough(buffer)` says how many bytes the answer is; → { head, rest }. */
function readUntil(socket, enough, timeoutMs, what) {
  return new Promise((resolveP, rejectP) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
    const fail = (err) => { cleanup(); socket.destroy(); rejectP(err); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let size;
      try { size = enough(buffer); } catch (err) { return fail(err); }
      if (size > 0) { cleanup(); socket.pause(); return resolveP({ head: buffer.subarray(0, size), rest: buffer.subarray(size) }); }
      if (buffer.length > MAX_HEAD_BYTES) fail(proxyError('PROXY_PROTOCOL', `${what} sent an answer that is too long`));
    };
    const onError = (err) => fail(proxyError('PROXY_UNREACHABLE', `${what} closed the connection (${err?.code || err?.message || err})`));
    const onClose = () => fail(proxyError('PROXY_UNREACHABLE', `${what} closed the connection`));
    const timer = setTimeout(() => fail(proxyError('PROXY_TIMEOUT', `${what} did not answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    timer.unref?.();
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.resume();
  });
}

function basicAuth(proxy) {
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`, 'utf8').toString('base64')}`;
}

async function connectToProxy(proxy, timeoutMs) {
  const what = `The ${proxy.type.toUpperCase()} proxy ${proxy.host}:${proxy.port}`;
  if (proxy.type === 'https') {
    const socket = tls.connect({ host: proxy.host, port: Number(proxy.port), servername: net.isIP(proxy.host) ? undefined : proxy.host, ...(proxy.tls || {}) });
    return onceConnected(socket, 'secureConnect', timeoutMs, what);
  }
  const socket = net.connect({ host: proxy.host, port: Number(proxy.port) });
  return onceConnected(socket, 'connect', timeoutMs, what);
}

const SOCKS_REPLIES = {
  1: 'general failure', 2: 'connection not allowed', 3: 'network unreachable', 4: 'host unreachable',
  5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported',
};

async function socks5Tunnel(socket, proxy, host, port, timeoutMs) {
  const what = `The SOCKS5 proxy ${proxy.host}:${proxy.port}`;
  const withLogin = !!proxy.username;
  socket.write(Buffer.from(withLogin ? [5, 2, 0, 2] : [5, 1, 0]));
  let answer = await readUntil(socket, (b) => (b.length >= 2 ? 2 : 0), timeoutMs, what);
  if (answer.head[0] !== 5) throw proxyError('PROXY_PROTOCOL', `${what} did not answer as SOCKS5`);
  if (answer.rest.length) socket.unshift(answer.rest);
  const method = answer.head[1];
  if (method === 2) {
    if (!withLogin) throw proxyError('PROXY_AUTH', `${what} asks for a username and a password`);
    const user = Buffer.from(String(proxy.username), 'utf8');
    const pass = Buffer.from(String(proxy.password || ''), 'utf8');
    if (user.length > 255 || pass.length > 255) throw proxyError('PROXY_AUTH', 'A SOCKS5 username or password is at most 255 bytes');
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    answer = await readUntil(socket, (b) => (b.length >= 2 ? 2 : 0), timeoutMs, what);
    if (answer.rest.length) socket.unshift(answer.rest);
    if (answer.head[1] !== 0) throw proxyError('PROXY_AUTH', `${what} refused the username or the password`);
  } else if (method !== 0) {
    throw proxyError('PROXY_AUTH', `${what} accepts none of the ways SynaBun can sign in (no login, or a username and a password)`);
  }
  // The name goes to the proxy as a name: it is resolved there, never on this computer.
  const name = Buffer.from(String(host).replace(/^\[|\]$/g, ''), 'utf8');
  if (!name.length || name.length > 255) throw proxyError('PROXY_PROTOCOL', 'The host name is empty or longer than 255 bytes');
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
  answer = await readUntil(socket, (b) => {
    if (b.length < 5) return 0;
    const size = b[3] === 1 ? 10 : b[3] === 4 ? 22 : b[3] === 3 ? 7 + b[4] : -1;
    if (size < 0) throw proxyError('PROXY_PROTOCOL', `${what} sent an answer SynaBun does not read`);
    return b.length >= size ? size : 0;
  }, timeoutMs, what);
  if (answer.head[1] !== 0) throw proxyError('PROXY_REFUSED', `${what} did not connect to ${host}:${port} (${SOCKS_REPLIES[answer.head[1]] || `code ${answer.head[1]}`})`);
  if (answer.rest.length) socket.unshift(answer.rest);
  return socket;
}

async function httpConnectTunnel(socket, proxy, host, port, timeoutMs) {
  const what = `The ${proxy.type.toUpperCase()} proxy ${proxy.host}:${proxy.port}`;
  const target = `${host}:${port}`;
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${proxy.username ? `Proxy-Authorization: ${basicAuth(proxy)}\r\n` : ''}\r\n`);
  const answer = await readUntil(socket, (b) => { const at = b.indexOf('\r\n\r\n'); return at === -1 ? 0 : at + 4; }, timeoutMs, what);
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(answer.head.toString('latin1'))?.[1]);
  if (status === 407) throw proxyError('PROXY_AUTH', `${what} refused the username or the password (HTTP 407)`);
  if (!(status >= 200 && status < 300)) throw proxyError('PROXY_REFUSED', `${what} did not connect to ${target} (HTTP ${status || 'answer not read'})`);
  if (answer.rest.length) socket.unshift(answer.rest);
  return socket;
}

/**
 * A connection to `host:port` through `proxy` ({ type: 'http' | 'https' | 'socks5', host, port, username?, password? }).
 * → the socket, ready for the caller's bytes. Throws PROXY_UNREACHABLE | PROXY_TIMEOUT | PROXY_AUTH | PROXY_REFUSED |
 * PROXY_PROTOCOL; never opens a connection to anything but the proxy.
 */
export async function openProxyTunnel(proxy, host, port, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  if (!proxy || !['http', 'https', 'socks5'].includes(proxy.type) || !proxy.host || !proxy.port) {
    throw proxyError('PROXY_REQUIRED', 'No proxy is set');
  }
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw proxyError('PROXY_PROTOCOL', `Not a port: ${port}`);
  const socket = await connectToProxy(proxy, timeoutMs);
  try {
    const tunnel = proxy.type === 'socks5'
      ? await socks5Tunnel(socket, proxy, host, portNumber, timeoutMs)
      : await httpConnectTunnel(socket, proxy, host, portNumber, timeoutMs);
    tunnel.resume();
    return tunnel;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

function splitHostPort(target, fallbackPort) {
  const text = String(target || '');
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket) return { host: bracket[1], port: Number(bracket[2] || fallbackPort) };
  const at = text.lastIndexOf(':');
  if (at === -1) return { host: text, port: Number(fallbackPort) };
  return { host: text.slice(0, at), port: Number(text.slice(at + 1)) };
}

const HOP_HEADERS = new Set(['proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function forwardHeaders(raw) {
  const out = {};
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) && lower !== 'transfer-encoding') continue;
    if (out[name] === undefined) out[name] = raw[i + 1];
    else out[name] = [].concat(out[name], raw[i + 1]);
  }
  return out;
}

/**
 * One relay: a loopback HTTP proxy without a login in front of `upstream` (a proxy with one).
 *   listen(port?) → the port it listens on (a random free one for 0; a taken port rejects with EADDRINUSE)
 *   close()       → stops listening and ends every connection through it
 *   port          → the port while it listens, else null
 * `counters`: { tunnels, requests, failures } for tests and the log.
 */
export function createProxyRelay({ upstream, host = '127.0.0.1', log = () => {}, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  if (!upstream || !['http', 'https', 'socks5'].includes(upstream.type) || !upstream.host || !upstream.port) {
    throw proxyError('PROXY_REQUIRED', 'A relay needs an upstream proxy (type, host and port)');
  }
  const sockets = new Set();
  const counters = { tunnels: 0, requests: 0, failures: 0 };
  let listeningPort = null;
  const track = (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const refuse = (socket, err) => {
    counters.failures += 1;
    log(`relay: ${err?.message || err}`);
    const status = err?.code === 'PROXY_AUTH' ? '502 Proxy Login Refused' : '502 Bad Gateway';
    try { socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${String(err?.message || 'The proxy could not be reached').slice(0, 400)}\n`); } catch { /* gone */ }
  };

  const server = http.createServer();
  server.on('connection', track);

  // CONNECT host:port — every https page, and Chrome's WebSockets.
  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    const { host: targetHost, port: targetPort } = splitHostPort(req.url, 443);
    let tunnel;
    try { tunnel = track(await openProxyTunnel(upstream, targetHost, targetPort, { timeoutMs })); }
    catch (err) { return refuse(clientSocket, err); }
    counters.tunnels += 1;
    tunnel.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => tunnel.destroy());
    tunnel.on('close', () => clientSocket.destroy());
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) tunnel.write(head);
    tunnel.pipe(clientSocket);
    clientSocket.pipe(tunnel);
  });

  // A plain http:// request, asked of a proxy with its whole address.
  server.on('request', (req, res) => {
    let target;
    try { target = new URL(req.url); } catch { target = null; }
    if (!target || target.protocol !== 'http:') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      return res.end('This is the proxy relay of a SynaBun local profile: it takes a proxy request only.\n');
    }
    const fail = (err) => {
      counters.failures += 1;
      log(`relay: ${err?.message || err}`);
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end(`${String(err?.message || 'The proxy could not be reached').slice(0, 400)}\n`);
    };
    const headers = forwardHeaders(req.rawHeaders);
    const answer = (upstreamRes) => {
      counters.requests += 1;
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, forwardHeaders(upstreamRes.rawHeaders));
      upstreamRes.pipe(res);
    };
    let out;
    if (upstream.type === 'socks5') {
      // Through a connection the SOCKS5 proxy opened to the site: the request goes as the site expects it.
      openProxyTunnel(upstream, target.hostname, Number(target.port || 80), { timeoutMs }).then((tunnel) => {
        track(tunnel);
        // No `agent` here: Node uses `createConnection` only for a request without one (with `agent: false` it
        // would open a connection of its own, straight to the site).
        out = http.request({ method: req.method, host: target.hostname, port: Number(target.port || 80), path: `${target.pathname}${target.search}`, headers, createConnection: () => tunnel }, answer);
        out.on('error', fail);
        req.pipe(out);
      }, fail);
    } else {
      // To the HTTP(S) proxy as a proxy request, with the login.
      const lib = upstream.type === 'https' ? https : http;
      out = lib.request({
        host: upstream.host, port: Number(upstream.port), method: req.method, path: target.href, agent: false,
        headers: { ...headers, 'Proxy-Authorization': basicAuth(upstream) }, timeout: timeoutMs, ...(upstream.type === 'https' ? (upstream.tls || {}) : {}),
      }, answer);
      out.on('timeout', () => out.destroy(proxyError('PROXY_TIMEOUT', `The ${upstream.type.toUpperCase()} proxy ${upstream.host}:${upstream.port} did not answer`)));
      out.on('error', (err) => fail(err?.code?.startsWith?.('PROXY_') ? err : proxyError('PROXY_UNREACHABLE', `The ${upstream.type.toUpperCase()} proxy ${upstream.host}:${upstream.port} could not be reached (${err?.code || err?.message || err})`)));
      req.pipe(out);
    }
    res.on('close', () => { try { out?.destroy(); } catch { /* gone */ } });
  });

  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* gone */ } });

  return {
    counters,
    get port() { return listeningPort; },
    listen(port = 0) {
      return new Promise((resolveP, rejectP) => {
        const onError = (err) => { server.off('listening', onListening); rejectP(err); };
        const onListening = () => { server.off('error', onError); listeningPort = server.address().port; server.on('error', () => {}); resolveP(listeningPort); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host, port: Number(port) || 0, exclusive: true });
      });
    },
    close() {
      return new Promise((resolveP) => {
        const wasListening = listeningPort !== null;
        listeningPort = null;
        for (const socket of sockets) { try { socket.destroy(); } catch { /* gone */ } }
        sockets.clear();
        if (!wasListening) return resolveP();
        server.close(() => resolveP());
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * The address a site sees through `proxy`: GET `url` (CHECK_PROXY_URL) through it and read `{ ip }` from the answer.
 * → { ok: true, ip, via: 'http' | 'https' | 'socks5' | 'direct', ms } or { ok: false, code, error }.
 * Without a proxy (`type: 'none'`) the request goes out directly, and the answer says so (`via: 'direct'`).
 * Never throws.
 */
export async function checkProxy(proxy, { url = CHECK_PROXY_URL, timeoutMs = 15000, tlsOptions = {} } = {}) {
  const started = Date.now();
  let target;
  try { target = new URL(url); } catch { return { ok: false, code: 'CHECK_URL', error: `Not an address: ${url}` }; }
  const secure = target.protocol === 'https:';
  const port = Number(target.port || (secure ? 443 : 80));
  const direct = !proxy || proxy.type === 'none' || !proxy.host;
  let socket = null;
  try {
    if (!direct) socket = await openProxyTunnel(proxy, target.hostname, port, { timeoutMs });
    const body = await new Promise((resolveP, rejectP) => {
      const lib = secure ? https : http;
      const options = {
        method: 'GET', host: target.hostname, port, path: `${target.pathname}${target.search}`, timeout: timeoutMs,
        headers: { Accept: 'application/json', 'User-Agent': 'SynaBun', Connection: 'close' },
        // Through the proxy: the request rides the tunnel and nothing else. No `agent` then: Node uses
        // `createConnection` only for a request without one (with `agent: false` it would connect by itself, directly,
        // and the check would show this computer's own address).
        ...(socket ? {
          createConnection: () => (secure
            ? tls.connect({ socket, servername: net.isIP(target.hostname) ? undefined : target.hostname, ...tlsOptions })
            : socket),
        } : { agent: false, ...(secure ? tlsOptions : {}) }),
      };
      const req = lib.request(options, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; if (text.length > 16384) req.destroy(proxyError('CHECK_ANSWER', 'The answer is too long')); });
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300
          ? resolveP(text)
          : rejectP(proxyError('CHECK_ANSWER', `${target.hostname} answered HTTP ${res.statusCode}`))));
      });
      req.on('timeout', () => req.destroy(proxyError('PROXY_TIMEOUT', `${target.hostname} did not answer in ${Math.round(timeoutMs / 1000)} s`)));
      req.on('error', (err) => rejectP(err?.code?.startsWith?.('PROXY_') || err?.code === 'CHECK_ANSWER' ? err : proxyError('CHECK_FAILED', `${target.hostname} could not be reached${direct ? '' : ' through the proxy'} (${err?.code || err?.message || err})`)));
      req.end();
    });
    let ip = null;
    try { ip = JSON.parse(body)?.ip; } catch { ip = body.trim(); }
    if (typeof ip !== 'string' || !net.isIP(ip.trim())) return { ok: false, code: 'CHECK_ANSWER', error: `${target.hostname} did not answer with an address` };
    return { ok: true, ip: ip.trim(), via: direct ? 'direct' : proxy.type, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, code: err?.code || 'CHECK_FAILED', error: String(err?.message || err) };
  } finally {
    try { socket?.destroy(); } catch { /* gone */ }
  }
}
