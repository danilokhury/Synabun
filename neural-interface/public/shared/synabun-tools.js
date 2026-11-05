// ═══════════════════════════════════════════
// SynaBun — what a SynaBun MCP tool call is called, one way for every panel
// ═══════════════════════════════════════════
//
// Every side panel draws SynaBun's own tools with the SynaBun card (logo, a
// friendly name, a one-line summary). Which call is SynaBun's, what it is
// called and what it says on its card are decided here, once:
//
//   synabunToolKey(name, server?)  the bare tool name ('bluesky_post') of a SynaBun call, else null.
//                                  Claude Code / Codex `mcp__SynaBun__x` (any letter case, also a
//                                  plugin's `mcp__plugin_<p>_SynaBun__x`), OpenCode `SynaBun_x`, or a
//                                  tool name with its server given apart (Codex items, Antigravity).
//   isSynabunTool(name, server?)   synabunToolKey(...) != null
//   synabunToolGroup(key)          what the card's icon is picked by: 'memory' for the memory tools, else
//                                  the first word of the name (bluesky, browser, gsc, git). Which
//                                  tool group a tool belongs to is the MCP server's tool catalog
//                                  (mcp-server/src/services/tool-catalog.ts), never a table here.
//   synabunToolLabel(key)          'Bluesky · Post', 'Recall', 'Search Console · Inspect URL'
//   synabunToolSummary(key, input) one line from the call's input ('' when there is nothing to say)
//
// A tool nobody listed still gets a card: its group and action come from its
// name. No imports and no DOM: node --test, the panels and DOM-free modules
// (agy-render.js, ocp-v2-*) all load it.

const SERVER_RE = /^(?:synabun|plugin_.+_synabun)$/i;

/** True when `server` names SynaBun's MCP server (any letter case; a Claude Code plugin's copy too). */
export function isSynabunServer(server) {
  return SERVER_RE.test(String(server ?? '').trim());
}

/**
 * The bare tool name of a SynaBun MCP call, else null.
 * `server`, when the caller knows it apart from the name (Codex item.server, Antigravity ServerName),
 * decides alone: the name is then the tool's own (a prefixed one is unwrapped too).
 */
export function synabunToolKey(name, server) {
  const raw = String(name ?? '').trim();
  if (server != null && String(server).trim() !== '') {
    if (!isSynabunServer(server)) return null;
    return unwrap(raw) || raw || null;
  }
  return unwrap(raw);
}

function unwrap(raw) {
  const mcp = /^mcp__(.+?)__(.+)$/i.exec(raw);
  if (mcp) return isSynabunServer(mcp[1]) ? mcp[2] : null;
  const oc = /^synabun_(.+)$/i.exec(raw);
  return oc ? oc[1] : null;
}

/** synabunToolKey(name, server) != null */
export function isSynabunTool(name, server) {
  return synabunToolKey(name, server) != null;
}

// ── Names ──

// Display names only (what a card says), keyed by the tool's own name.
// Tools that are one thing, not a group's action:
const SINGLE = Object.freeze({
  recall: 'Recall', remember: 'Remember', reflect: 'Reflect', forget: 'Forget', restore: 'Restore',
  memories: 'Memories', sync: 'Sync', category: 'Category',
  tool_groups: 'Tool groups', choice: 'Choice', git: 'Git', loop: 'Loop', tictactoe: 'Tic-Tac-Toe',
  style_guide: 'Style Guide', image_staged: 'Staged images', morelogin: 'MoreLogin', skill: 'Skill',
  computer: 'Computer', fb_groups: 'Facebook · Groups', whatsapp_send_file: 'WhatsApp · Send file',
});
// The memory tools (their cards share the memory icon).
const MEMORY = Object.freeze({ recall: 1, remember: 1, reflect: 1, forget: 1, restore: 1, memories: 1, sync: 1, category: 1 });
// The name a tool's first words stand for; the longest that fits wins.
const PREFIX_NAMES = Object.freeze({
  browser_extract: 'Extract', browser: 'Browser', bluesky: 'Bluesky', youtube: 'YouTube', gsc: 'Search Console',
  discord: 'Discord', whiteboard: 'Whiteboard', card: 'Cards', agent: 'Agent', computer: 'Computer',
  whatsapp: 'WhatsApp', image: 'Image',
});
const PREFIXES = Object.freeze(Object.keys(PREFIX_NAMES).sort((a, b) => b.length - a.length));

// Words that are not written in lower case.
const WORDS = Object.freeze({
  dm: 'DM', ax: 'AX', url: 'URL', urls: 'URLs', id: 'ID', ig: 'IG', li: 'LI', fb: 'FB', wa: 'WA', x: 'X',
  tiktok: 'TikTok', cwv: 'CWV', https: 'HTTPS', api: 'API', ai: 'AI', ui: 'UI', faq: 'FAQ',
});

// Names a reader knows better than the words of the tool's name.
const ACTION_NAMES = Object.freeze({
  browser_go_back: 'Back',
  browser_go_forward: 'Forward',
  browser_extract_tweets: 'Tweets',
  browser_extract_fb_posts: 'Facebook posts',
  browser_extract_fb_groups: 'Facebook groups',
  browser_fb_composer_state: 'Facebook composer',
  browser_x_compose_state: 'X composer',
  bluesky_search_actors: 'Search users',
});

function words(text) {
  const parts = String(text || '').split(/[_\s-]+/).filter(Boolean)
    .map((w) => WORDS[w.toLowerCase()] || w.toLowerCase());
  if (!parts.length) return '';
  const first = parts[0];
  parts[0] = first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first;
  return parts.join(' ');
}

function prefixOf(key) {
  for (const prefix of PREFIXES) {
    if (key === prefix || key.startsWith(`${prefix}_`)) return { prefix, label: PREFIX_NAMES[prefix] };
  }
  return null;
}

/** What a SynaBun card's icon is picked by: 'memory', or the first word of the tool's name. */
export function synabunToolGroup(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return '';
  if (Object.prototype.hasOwnProperty.call(MEMORY, k)) return 'memory';
  return k.split('_')[0];
}

/** 'Bluesky · Post', 'Recall', 'Browser · Navigate': the name a SynaBun card shows. */
export function synabunToolLabel(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return 'SynaBun';
  if (Object.prototype.hasOwnProperty.call(SINGLE, k)) return SINGLE[k];
  const g = prefixOf(k);
  if (!g) return words(k);
  const action = ACTION_NAMES[k] || words(k.slice(g.prefix.length + 1));
  return action ? `${g.label} · ${action}` : g.label;
}

// ── Summaries ──

const MAX_SUMMARY = 90;

function line(value) {
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s;
}

// What a call is about, in the order a reader looks for it. `action` is put in front of it.
const SUBJECT_FIELDS = ['query', 'q', 'url', 'text', 'content', 'title', 'prompt', 'task', 'message', 'handle', 'actor',
  'uri', 'name', 'property', 'site', 'video_id', 'videoId', 'channel_id', 'selector', 'label', 'key', 'path', 'memory_id', 'id'];

const BY_TOOL = Object.freeze({
  remember: (i) => [i.category, i.content].map(line).filter(Boolean).join(': '),
  reflect: (i) => line(i.content) || (i.memory_id ? `Update ${String(i.memory_id).slice(0, 8)}` : ''),
  forget: (i) => line(String(i.memory_id || '').slice(0, 8)),
  restore: (i) => line(String(i.memory_id || '').slice(0, 8)),
  sync: () => '',
  browser_press: (i) => line(i.key),
  browser_scroll: (i) => line(i.direction || i.selector),
  browser_evaluate: (i) => line(i.script || i.expression),
  browser_type: (i) => line(i.text || i.selector),
  browser_fill: (i) => line(i.value || i.text || i.selector),
  browser_select: (i) => line(i.value || i.selector),
});

/** One line from a SynaBun call's input: what it is about, '' when there is nothing to say. */
export function synabunToolSummary(key, input) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const k = String(key || '').toLowerCase();
  const own = BY_TOOL[k];
  if (own) { try { return own(i) || ''; } catch { return ''; } }
  const action = line(i.action);
  let subject = '';
  for (const f of SUBJECT_FIELDS) { subject = line(i[f]); if (subject) break; }
  if (action && subject) return line(`${action} · ${subject}`);
  return action || subject;
}
