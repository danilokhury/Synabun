// Shared by the project's browser tests: optional CDN assets are local no-ops.
// Unexpected network access is still blocked and fails the test, rather than
// silently changing Markdown rendering based on connectivity or CDN timing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const assets = [
  ['https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js', '/__codex-fixture__/marked.js', 'js', 'export const marked = null;'],
  ['https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark-dimmed.min.css', '/__codex-fixture__/highlight.css', 'css', ''],
  ['https://cdn.jsdelivr.net/npm/highlight.js@11/lib/highlight.min.js', '/__codex-fixture__/highlight.js', 'js', ''],
];

export function serveOfflineCodexAssets(app) {
  app.get('/shared/cdx/cdx-tabs.js', (_, res) => {
    let source = readFileSync(new URL('../public/shared/cdx/cdx-tabs.js', import.meta.url), 'utf8');
    for (const [remote, local] of assets) source = source.replaceAll(remote, local);
    res.type('js').send(source);
  });
  for (const [, path, type, source] of assets) {
    app.get(path, (_, res) => res.type(type).send(source));
  }
}

export async function guardOfflineRequests(context) {
  const externalRequests = [];
  const isLocal = url => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (isLocal(url)) return route.continue();
    externalRequests.push(url);
    await route.abort('blockedbyclient');
  });
  await context.routeWebSocket(url => !isLocal(url), socket => {
    externalRequests.push(socket.url());
    socket.close();
  });
  return () => assert.deepEqual(externalRequests, [], 'Codex browser fixture made no non-loopback requests');
}
