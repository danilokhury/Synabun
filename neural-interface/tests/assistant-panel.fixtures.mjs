// Shared harness for the Assistant panel's browser suites: the real component
// (asst-panel.js) in a terminal host and the real sidepanel host, against a
// fake server and fake assistant sockets, in WebKit and Chromium. The page
// loads the same Google Fonts stylesheet as index.html (Inter, JetBrains Mono,
// Space Grotesk), served from a disk cache after the first fetch, so
// screenshots show the real type. Not a test file (node --test finds none here).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap';
/** index.html's font links, verbatim. */
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONT_CSS.replace(/&/g, '&amp;')}" rel="stylesheet">`;
const FONT_CACHE = '/tmp/synabun-test-fonts';
const FONT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Serve fonts.googleapis.com / fonts.gstatic.com from a disk cache (one network fetch per file, ever); offline: the fallback fonts. */
export async function routeFonts(page) {
  await routeCached(page, /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//);
}

/** The renderer's Markdown build (asst-render.js loads marked@14 from jsDelivr), cached the same way. */
export async function routeMarked(page) {
  await routeCached(page, /^https:\/\/cdn\.jsdelivr\.net\/npm\/marked@14\//);
}

async function routeCached(page, pattern) {
  await page.route(pattern, async (route) => {
    const url = route.request().url();
    const file = join(FONT_CACHE, createHash('sha1').update(url).digest('hex'));
    try {
      let body;
      let type;
      if (existsSync(file) && existsSync(`${file}.json`)) {
        body = readFileSync(file);
        type = JSON.parse(readFileSync(`${file}.json`, 'utf8')).type;
      } else {
        const res = await fetch(url, { headers: { 'user-agent': FONT_UA } });
        if (!res.ok) throw new Error(String(res.status));
        body = Buffer.from(await res.arrayBuffer());
        type = res.headers.get('content-type') || 'application/octet-stream';
        mkdirSync(FONT_CACHE, { recursive: true });
        writeFileSync(file, body);
        writeFileSync(`${file}.json`, JSON.stringify({ type }));
      }
      await route.fulfill({ status: 200, body, headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
    } catch { await route.abort(); }
  });
}

export const PUBLIC = resolve(import.meta.dirname, '../public');
export const I18N = resolve(import.meta.dirname, '../i18n');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const STORAGE_STUB = `export const storage = {
  getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key), keys: () => Object.keys(localStorage),
}; export async function flushStorage() {} export function isHydrated() { return true; }`;

export const MARK = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="8" y="5.5" width="11" height="5" rx="2.5" transform="rotate(-12 13.5 8)"/><rect x="4.5" y="12.5" width="11" height="5" rx="2.5" transform="rotate(-12 10 15)"/></svg>';

export const routing = { mode: null, effectiveMode: 'ask-unsure', defaultMode: 'ask-unsure', askBelow: 0.75 };
export const sessionMeta = (id, extra = {}) => ({
  id, title: 'SynaBun', status: 'idle',
  brain: { provider: 'claude-code', model: 'claude-sonnet-5', effort: 'high', mcpProfile: 'full', permissionMode: 'default', project: '/Users/me/Apps/Synabun' },
  costUsd: 0, routing, brainCapabilities: { vision: true, tier: 'medium', label: 'Sonnet 5' },
  pendingRoutes: 0, computerUse: false, computerUseExplicit: null, features: { routing: true, computer: false },
  ...extra,
});

export const FIXTURE = `<!doctype html><html><head><meta charset="utf-8">
${FONT_LINKS}
<link rel="stylesheet" href="/shared/styles.css">
<style>
  html,body{margin:0;height:100%;background:#050505;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  #stage{position:fixed;inset:48px 0 0 0;background:radial-gradient(55% 55% at 72% 38%, #2b3f73 0%, #111a2e 45%, #050505 75%)}
  #stage i{position:absolute;width:6px;height:6px;border-radius:50%;background:#9ecbff;box-shadow:0 0 12px #9ecbff}
  #outside{position:fixed;left:8px;bottom:8px;z-index:5}
</style>
</head><body>
<div id="stage"><i style="left:62%;top:30%"></i><i style="left:80%;top:52%"></i><i style="left:71%;top:70%"></i></div>
<div id="terminal-panel" style="left:10px;top:10px;right:auto;bottom:auto;width:720px;height:660px">
  <div class="term-body-row"><div class="term-container" id="term-container"></div></div>
</div>
<div id="topright-controls">
  <button id="topright-assistant-panel-btn" class="topright-icon-btn" data-tooltip="SynaBun Assistant side panel">${MARK}</button>
  <div id="term-minimized-tray"></div>
</div>
<button type="button" id="outside" data-tooltip="Outside the Assistant">outside</button>
<script type="module">
  // Every WAAPI animation the page starts, before any module runs (the FLIPs, the fades).
  window.anims = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    const anim = animate.call(this, keyframes, options);
    try {
      window.anims.push({ cls: String(this.className?.baseVal ?? this.className ?? ''), parent: String(this.parentElement?.className?.baseVal ?? this.parentElement?.className ?? ''), keyframes: JSON.parse(JSON.stringify(keyframes)), duration: typeof options === 'number' ? options : options?.duration, easing: options?.easing || '' });
    } catch { /* unserializable keyframes */ }
    return anim;
  };
  import('/shared/i18n.js').then(async ({ initI18n }) => {
    await initI18n('en');
    const bus = await import('/shared/state.js');
    const tooltip = await import('/shared/ui-tooltip.js');
    tooltip.initTooltip();
    const panel = await import('/shared/assistant/asst-panel.js');
    const mascot = await import('/shared/synabun-mascot.js');
    const assistant = await import('/shared/ui-assistant.js');
    const sidepanel = await import('/shared/ui-assistant-panel.js');
    assistant.initAssistant();
    // A stand-in terminal host for the shared rules; the terminal mounts below go straight to the component.
    assistant.registerAssistantHost({ id: 'terminal', has: () => false, sessions: () => [], focus() {}, mount() {}, close() {}, toggle() {} });
    await sidepanel.initAssistantPanel();
    document.getElementById('topright-assistant-panel-btn').addEventListener('click', () => sidepanel.toggleAssistantPanel());
    window.L = {
      bus, mascot, sidepanel, mounts: {},
      mountTerminal(sessionId, meta) {
        const vp = document.createElement('div');
        vp.className = 'term-viewport assistant-viewport';
        vp.dataset.session = sessionId;
        document.getElementById('term-container').appendChild(vp);
        const ctl = panel.mountAssistant(vp, { sessionId, brain: meta.brain, session: meta, host: { id: 'terminal', setLabel() {}, setStatus() {}, setBrain() {}, isVisible: () => true } });
        this.mounts[sessionId] = { ctl, vp };
        return true;
      },
      unmountTerminal(sessionId) { const m = this.mounts[sessionId]; if (!m) return; m.ctl.destroy(); m.vp.remove(); delete this.mounts[sessionId]; },
      rigs: () => mascot.__mascot.rigs(),
    };
    window.ready = true;
  });
</script></body></html>`;

// ── Event builders (the shapes the bridge and assistant-envelope.js emit) ──
export const start = id => ({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant', content: [] } } });
export const blockStart = (index, content_block) => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block } });
export const blockStop = index => ({ type: 'stream_event', event: { type: 'content_block_stop', index } });
export const thinkingDelta = thinking => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } });
export const assistant = (id, content, extra = {}) => ({ type: 'assistant', message: { id, role: 'assistant', content }, ...extra });
export const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
export const toolResult = (id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
export const text = t => ({ type: 'text', text: t });
export const thinking = t => ({ type: 'thinking', thinking: t });
export const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, ...extra });
export const LONG = 'cd /Users/me/Apps/Synabun && env -u SYNABUN_ASSISTANT_SESSION SYNABUN_TYPESAFE=off node --test neural-interface/tests/assistant-render-events.browser.mjs';

export function startServer() {
  const state = { posts: [], creates: [], createDelay: 0, sessions: {}, transcripts: {}, usage: {}, usageSockets: new Map() };
  let n = 0;
  const app = express();
  app.use(express.json());
  app.get('/shared/storage.js', (_, res) => res.type('js').send(STORAGE_STUB));
  app.get('/shared/ui-whiteboard.js', (_, res) => res.type('js').send('export function getWhiteboardElementById() { return null; }'));
  app.get('/shared/ui-native-loop-router.js', (_, res) => res.type('js').send('export async function focusNativeLoopRun() {}'));
  app.get('/fixture', (_, res) => res.type('html').send(FIXTURE));
  app.use('/api/ui-state', (_, res) => res.json({}));
  app.get('/api/claude/models', (_, res) => res.json({ models: [
    { id: 'claude-sonnet-5', label: 'Sonnet 5', desc: 'Balanced', tier: 'default', cliReady: true, effortLevels: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'claude-opus-5', label: 'Opus 5', desc: 'Most capable', cliReady: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ] }));
  app.get('/api/assistant/claude/accounts', (_, res) => res.json({ accounts: [{ id: 'default', label: 'Default' }] }));
  app.get('/api/mcp/profile', (_, res) => res.json({ ok: true, profile: 'full', presets: { full: { label: 'Full', tools: 106 } } }));
  app.get('/api/projects', (_, res) => res.json({ projects: [{ path: '/Users/me/Apps/Synabun', label: 'Synabun' }] }));
  app.get('/api/assistant/catalog', (_, res) => res.json({ ok: true, models: { 'claude-code': [{ id: 'claude-sonnet-5', label: 'Sonnet 5', tier: 'medium', vision: true }] } }));
  app.get('/api/assistant/routing', (_, res) => res.json({ ok: true, version: 1, routing: { defaultMode: 'ask-unsure', askBelow: 0.75, preferences: {}, ladders: {}, catalogFilter: {} }, taskClasses: [], modes: ['always-ask', 'ask-unsure', 'never'] }));
  app.get('/api/assistant/runs', (_, res) => res.json({ runs: [] }));
  app.get('/api/desktop/status', (_, res) => res.json({ ok: true, platform: 'linux', supported: false }));
  app.get('/api/assistant/sessions', (_, res) => res.json({ sessions: Object.values(state.sessions) }));
  app.get('/api/assistant/sessions/:id/usage', (req, res) => res.json({ ok: true, usage: state.usage[req.params.id] || null }));
  app.post('/__usage/:id', (req, res) => {
    const id = req.params.id;
    const packet = { type: 'assistant:usage', ...req.body, sessionId: id };
    state.usage[id] = packet;
    for (const ws of state.usageSockets.get(id) || []) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(packet));
    res.json({ ok: true });
  });
  app.post('/api/assistant/sessions', async (req, res) => {
    if (state.createDelay) await sleep(state.createDelay);
    const id = `assistant-sp${++n}`;
    state.sessions[id] = sessionMeta(id);
    state.creates.push(id);
    res.status(201).json({ ok: true, session: state.sessions[id] });
  });
  app.get('/api/assistant/sessions/:id', (req, res) => {
    const session = state.sessions[req.params.id];
    if (!session) return res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: 'Unknown session' });
    res.json({ ok: true, session: { ...session, transcript: state.transcripts[req.params.id] || [] } });
  });
  app.patch('/api/assistant/sessions/:id', (req, res) => { state.posts.push({ path: req.path, body: req.body }); res.json({ ok: true }); });
  app.post('/api/assistant/sessions/:id/close', (req, res) => { state.posts.push({ path: req.path }); res.json({ ok: true }); });
  app.use('/api', (_, res) => res.json({}));
  app.use('/i18n', express.static(I18N));
  app.use(express.static(PUBLIC));
  const server = app.listen(0, '127.0.0.1');
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const match = /^\/ws\/assistant\/([^/?]+)/.exec(request.url || '');
    if (!match) { socket.destroy(); return; }
    const id = decodeURIComponent(match[1]);
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (!state.usageSockets.has(id)) state.usageSockets.set(id, new Set());
      state.usageSockets.get(id).add(ws);
      ws.on('close', () => state.usageSockets.get(id)?.delete(ws));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'reattach') {
            ws.send(JSON.stringify({ type: 'reattach_result', ok: true, running: false, replayed: 0 }));
            if (state.usage[id]) ws.send(JSON.stringify(state.usage[id]));
          }
        } catch { /* fake feed */ }
      });
    });
  });
  return { server, state };
}

export function fakeAssistantSockets(page, hooks = {}) {
  const sockets = new Map();
  const opens = new Map();
  return {
    sockets,
    opens: (id) => opens.get(id) || 0,
    hooks,
    async install() {
      await page.routeWebSocket('**/ws/assistant/**', (ws) => {
        const id = decodeURIComponent(ws.url().split('/ws/assistant/')[1] || '');
        if (typeof hooks.refuse === 'function' && hooks.refuse(id)) { ws.close({ code: 1011, reason: 'refused' }); return; }
        const entry = { ws, messages: sockets.get(id)?.messages || [] };
        sockets.set(id, entry);
        opens.set(id, (opens.get(id) || 0) + 1);
        ws.onMessage((raw) => {
          let msg;
          try { msg = JSON.parse(String(raw)); } catch { return; }
          entry.messages.push(msg);
          if (msg.type === 'reattach') {
            // A test can make the server replay what it buffered while the panel was away.
            const replay = typeof hooks.reattach === 'function' ? hooks.reattach(id) : null;
            ws.send(JSON.stringify({ type: 'reattach_result', ok: true, running: !!replay?.running, ...(replay ? { replayed: replay.packets.length } : {}) }));
            for (const packet of replay?.packets || []) ws.send(JSON.stringify(packet));
          }
        });
        ws.send(JSON.stringify({ type: 'engine', engine: 'claude-agent-sdk', sdkVersion: '0.3.288' }));
      });
    },
    send(id, packet) { sockets.get(id).ws.send(JSON.stringify(packet)); },
    event(id, event) { sockets.get(id).ws.send(JSON.stringify({ type: 'event', event })); },
    close(id) { return sockets.get(id).ws.close({ code: 1011, reason: 'test outage' }); },
    async waitFor(id, predicate, what, timeout = 5000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const hit = (sockets.get(id)?.messages || []).find(predicate);
        if (hit) return hit;
        await sleep(20);
      }
      throw new Error(`no client message: ${what}\n${JSON.stringify(sockets.get(id)?.messages || [])}`);
    },
  };
}

export async function openPage(browserType, t, { reducedMotion = 'no-preference', viewport = { width: 1600, height: 900 }, markdown = false } = {}) {
  const { server, state } = startServer();
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const browser = await browserType.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  const missingKeys = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', (m) => { const line = m.text(); if (line.includes('[i18n] Missing key')) missingKeys.push(line); if (process.env.ASST_TEST_DEBUG) console.log('[page]', m.type(), line); });
  await page.route('https://**', r => r.abort());
  await routeFonts(page); // registered last: it wins over the catch-all for the two font hosts
  if (markdown) await routeMarked(page);
  const socks = fakeAssistantSockets(page);
  await socks.install();
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 }).catch((e) => { throw new Error(errors.join('\n') || e.message); });
  // Load every face now (not when a glyph first needs it): a late swap re-lays the page out mid-test.
  await page.evaluate(() => Promise.all([...document.fonts].filter(f => /Inter|JetBrains Mono|Space Grotesk/.test(f.family)).map(f => f.load().catch(() => null))).then(() => document.fonts.ready).then(() => true));
  return { page, state, socks, errors, missingKeys, browser, context };
}

/** Mount a terminal-host panel on a fresh session and wait for its empty state and socket. */
export async function mountTerminal(ctx, id) {
  ctx.state.sessions[id] = sessionMeta(id);
  await ctx.page.evaluate(([sid, meta]) => window.L.mountTerminal(sid, meta), [id, ctx.state.sessions[id]]);
  await ctx.page.waitForFunction(sid => document.querySelector(`[data-session="${sid}"] .asst-empty .asst-empty-mascot svg`), id);
  await ctx.socks.waitFor(id, m => m.type === 'reattach', `reattach ${id}`);
}

export const poseOf = (page, sel) => page.evaluate(s => document.querySelector(s)?.dataset.pose || null, sel);
export const lidOf = (page, sel) => page.evaluate((s) => {
  const t = document.querySelector(`${s} .syna-lid`)?.getAttribute('transform') || '';
  const m = /^translate\(([-\d.e]+),([-\d.e]+)\)/.exec(t);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}, sel);

/** Record every pose and reaction class a rig's SVG goes through (it moves into the dock with the hero). */
export function watchRig(page, sel, key) {
  return page.evaluate(([s, k]) => {
    const svg = document.querySelector(s);
    const log = (window.rigLog ||= {})[k] = [];
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName === 'data-pose') log.push({ pose: svg.dataset.pose, at: performance.now() });
        if (r.attributeName === 'class') for (const c of svg.classList) if (c.startsWith('syna-react-') && !log.some(e => e.react === c && performance.now() - e.at < 50)) log.push({ react: c, at: performance.now() });
      }
    }).observe(svg, { attributes: true, attributeFilter: ['data-pose', 'class'] });
    return true;
  }, [sel, key]);
}
export const rigLog = (page, key) => page.evaluate(k => window.rigLog?.[k] || [], key);
