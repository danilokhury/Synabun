// ─────────────────────────────────────────────────────────────────────────────
// The raw requests SynaBun makes to a serve, answered through OpenCode 2's API.
//
// Besides the client's methods, server.js and the panel's request module call
// a serve by path (`ocpProxy(method, path, body)`): the provider and agent
// lists, a session's deletion, the pending questions and a question's answer,
// the MCP resources, and OpenCode 2's own /api/* routes. Those paths are the
// ones SynaBun has always named (OpenCode 1's); every one of them would land
// on OpenCode 2's web app (an HTML page, status 200), so each is answered here
// through the OpenCode 2 client (lib/opencode2-client.js), in the shapes
// SynaBun reads, as `{ status, data }`. A path under /api/ goes through with
// the serve's password. Anything else gets a clear 501 instead of a web page.
// ─────────────────────────────────────────────────────────────────────────────

const json = (status, data) => ({ status, data });

function asProxyResult(result, okStatus = 200) {
  if (!result) return json(500, { error: 'OpenCode gave no answer' });
  if (result.error) {
    const status = Number(result.response?.status) || 500;
    const error = result.error;
    const message = typeof error === 'string' ? error : (error?.message || error?.data?.message || 'OpenCode request failed');
    return json(status >= 400 ? status : 500, { error: message, ...(error && typeof error === 'object' ? { name: error._tag || error.name || undefined } : {}) });
  }
  return json(okStatus, result.data === undefined ? true : result.data);
}

/**
 * Answer one raw request on a serve. `client` is an OpenCode 2 client
 * (createOpencode2Client), `rawFetch(path, init)` sends a request under /api/
 * with the serve's password (the pass-through).
 */
export async function opencode2Proxy(client, method, path, body = null, { rawFetch = null } = {}) {
  const url = new URL(path, 'http://opencode.invalid');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const query = Object.fromEntries(url.searchParams.entries());
  const directory = query.directory || query['location[directory]'] || undefined;
  const verb = String(method || 'GET').toUpperCase();
  const segments = route.split('/').filter(Boolean).map(decodeURIComponent);

  if (route.startsWith('/api/') && typeof rawFetch === 'function') {
    return rawFetch(`${route}${url.search}`, { method: verb, body });
  }

  // ── Providers, agents ──
  if (route === '/provider' && verb === 'GET') return asProxyResult(await client.provider.list({ directory }));
  if (route === '/config/providers' && verb === 'GET') return asProxyResult(await client.config.providers({ directory }));
  if (route === '/agent' && verb === 'GET') return asProxyResult(await client.app.agents({ directory }));

  // ── MCP resources ──
  if (route === '/experimental/resource' && verb === 'GET' && typeof rawFetch === 'function') {
    const located = directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : '';
    const listed = await rawFetch(`/api/mcp/resource${located}`, { method: 'GET' });
    if (listed.status !== 200) return listed;
    // { "<server>:<uri>": { name, uri, client, … } }
    const out = {};
    for (const resource of Array.isArray(listed.data?.data?.resources) ? listed.data.data.resources : []) {
      if (!resource?.uri) continue;
      out[`${resource.server}:${resource.uri}`] = { name: resource.name, uri: resource.uri, client: resource.server, ...(resource.description ? { description: resource.description } : {}), ...(resource.mimeType ? { mimeType: resource.mimeType } : {}) };
    }
    return json(200, out);
  }

  // ── Questions ──
  if (route === '/question' && verb === 'GET') return asProxyResult(await client.question.list({ directory }));
  if (segments[0] === 'question' && segments.length === 3 && segments[2] === 'reply' && verb === 'POST') {
    return asProxyResult(await client.question.reply({ requestID: segments[1], answers: body?.answers, directory }));
  }

  // ── Sessions ──
  if (segments[0] === 'session' && segments.length === 2 && verb === 'DELETE') {
    return asProxyResult(await client.session.delete({ sessionID: segments[1] }));
  }

  return json(501, { error: `SynaBun does not translate ${verb} ${route} for OpenCode.` });
}
