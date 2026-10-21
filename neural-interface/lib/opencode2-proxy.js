// ─────────────────────────────────────────────────────────────────────────────
// OpenCode 2 — the raw OpenCode 1 requests SynaBun makes, answered on OpenCode 2.
//
// Besides the SDK, server.js and the panel's request module call a serve over
// plain HTTP (`ocpProxy(method, path, body)`): /provider, /agent, /question,
// /config, /mcp, DELETE /session/:id, … Those are OpenCode 1 paths. On an
// OpenCode 2 serve every one of them would land on the web app (an HTML page,
// status 200), so ocpProxy hands them here instead: each known path is
// answered through the OpenCode 2 client (lib/opencode2-client.js), in the
// shape OpenCode 1 gave, as `{ status, data }`. A path under /api/ is the same
// family of routes on both majors (OpenCode 1.18's own /api/* surface became
// OpenCode 2's API) and goes through with the serve's password. Anything else
// gets a clear 501 instead of a web page.
// ─────────────────────────────────────────────────────────────────────────────

const json = (status, data) => ({ status, data });

function asProxyResult(result, okStatus = 200) {
  if (!result) return json(500, { error: 'OpenCode 2 gave no answer' });
  if (result.error) {
    const status = Number(result.response?.status) || 500;
    const error = result.error;
    const message = typeof error === 'string' ? error : (error?.message || error?.data?.message || 'OpenCode 2 request failed');
    return json(status >= 400 ? status : 500, { error: message, ...(error && typeof error === 'object' ? { name: error._tag || error.name || undefined } : {}) });
  }
  return json(okStatus, result.data === undefined ? true : result.data);
}

const notOnV2 = (what) => json(501, { error: `${what} is not available on OpenCode 2 from SynaBun yet. Use the OpenCode 2 app or CLI for it.` });

/**
 * Answer one raw OpenCode 1 request on an OpenCode 2 serve. `client` is an
 * OpenCode 2 client (createOpencode2Client), `rawFetch(path, init)` sends a
 * request under /api/ with the serve's password (the pass-through).
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

  // ── The serve itself ──
  if (route === '/global/health' && verb === 'GET') return asProxyResult(await client.global.health());
  // OpenCode 2 has no "dispose": its instances end with the process, which
  // SynaBun stops right after asking.
  if (route === '/global/dispose' && verb === 'POST') return json(200, true);

  // ── Providers, agents, config ──
  if (route === '/provider' && verb === 'GET') return asProxyResult(await client.provider.list({ directory }));
  if (route === '/provider/auth' && verb === 'GET') return json(200, {});
  if (segments[0] === 'provider' && segments[2] === 'oauth') return notOnV2('Signing in to a provider');
  if (segments[0] === 'auth' && segments.length === 2) return notOnV2('Saving provider credentials');
  if (route === '/config/providers' && verb === 'GET') return asProxyResult(await client.config.providers({ directory }));
  if (route === '/config' && verb === 'GET') return asProxyResult(await client.config.get({ directory }));
  if (route === '/config' && verb === 'PATCH') return notOnV2('Changing the running OpenCode config');
  if (route === '/agent' && verb === 'GET') return asProxyResult(await client.app.agents({ directory }));
  if (route === '/command' && verb === 'GET') return asProxyResult(await client.command.list({ directory }));
  if (route === '/experimental/tool/ids' && verb === 'GET') return json(200, []);

  // ── MCP ──
  if (route === '/mcp' && verb === 'GET') return asProxyResult(await client.mcp.status({ directory }));
  if (route === '/mcp' && verb === 'POST') return asProxyResult(await client.mcp.add({ name: body?.name, config: body?.config, directory }));
  if (segments[0] === 'mcp' && segments.length === 3 && verb === 'POST') {
    if (segments[2] === 'connect') return asProxyResult(await client.mcp.connect({ name: segments[1], directory }));
    if (segments[2] === 'disconnect') return asProxyResult(await client.mcp.disconnect({ name: segments[1], directory }));
  }
  if (segments[0] === 'mcp' && segments[2] === 'auth') return notOnV2('Signing in to an MCP server');
  if (route === '/experimental/resource' && verb === 'GET' && typeof rawFetch === 'function') {
    const located = directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : '';
    const listed = await rawFetch(`/api/mcp/resource${located}`, { method: 'GET' });
    if (listed.status !== 200) return listed;
    // OpenCode 1: { "<server>:<uri>": { name, uri, client, … } }
    const out = {};
    for (const resource of Array.isArray(listed.data?.data?.resources) ? listed.data.data.resources : []) {
      if (!resource?.uri) continue;
      out[`${resource.server}:${resource.uri}`] = { name: resource.name, uri: resource.uri, client: resource.server, ...(resource.description ? { description: resource.description } : {}), ...(resource.mimeType ? { mimeType: resource.mimeType } : {}) };
    }
    return json(200, out);
  }

  // ── Questions ──
  if (route === '/question' && verb === 'GET') return asProxyResult(await client.question.list({ directory }));
  if (segments[0] === 'question' && segments.length === 3 && verb === 'POST') {
    if (segments[2] === 'reply') return asProxyResult(await client.question.reply({ requestID: segments[1], answers: body?.answers, directory }));
    if (segments[2] === 'reject') return asProxyResult(await client.question.reject({ requestID: segments[1], directory }));
  }

  // ── Permissions ──
  if (route === '/permission' && verb === 'GET') return asProxyResult(await client.permission.list({ directory }));
  if (segments[0] === 'permission' && segments.length === 3 && segments[2] === 'reply' && verb === 'POST') {
    return asProxyResult(await client.permission.reply({ requestID: segments[1], reply: body?.reply, message: body?.message, directory }));
  }

  // ── Sessions ──
  if (route === '/session' && verb === 'GET') return asProxyResult(await client.session.list({ directory }));
  if (segments[0] === 'session' && segments.length === 2) {
    const sessionID = segments[1];
    if (verb === 'GET') return asProxyResult(await client.session.get({ sessionID }));
    if (verb === 'DELETE') return asProxyResult(await client.session.delete({ sessionID }));
    if (verb === 'PATCH') return asProxyResult(await client.session.update({ sessionID, ...(body || {}) }));
  }
  if (segments[0] === 'session' && segments.length === 3 && verb === 'POST' && segments[2] === 'abort') {
    return asProxyResult(await client.session.abort({ sessionID: segments[1] }));
  }
  if (segments[0] === 'session' && segments.length === 3 && verb === 'GET' && segments[2] === 'message') {
    return asProxyResult(await client.session.messages({ sessionID: segments[1], directory }));
  }

  return json(501, { error: `SynaBun does not translate ${verb} ${route} for OpenCode 2.` });
}
