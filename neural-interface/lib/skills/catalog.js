// ── The skills catalog: what every runtime folder holds ──
// Reads every root lib/skills/roots.js lists, asynchronously and within bounds, and answers with one entry per
// skill folder, command, agent and prompt file: what it is, where, which runtimes read it, its name and
// description as text, the count of its problems, whether SynaBun installed it, and how it collides with
// same-named entries ("which one runs"). A root that cannot be read, an entry skipped and why, and a scan that
// stopped at its limits are said, never dropped: `roots[].status`, `diagnostics`, `truncated`.
//
// The scan is cached (a fresh answer for `ttlMs`, then read again; any write SynaBun makes invalidates it) and
// the metadata of each head file is cached by its inode, size and modification time, so an unchanged file is
// never parsed twice. File trees are not read for the list: an entry's tree is read when it is opened (detail).
// Ids are opaque (`art_<hash>`): an id is looked up in the scan, never decoded into a path.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isInside, realPathOf } from '../path-confine.js';
import { listConfined } from '../confined-fs.js';

export const CATALOG_LIMITS = Object.freeze({ maxPerRoot: 500, maxEntries: 5000, maxCommandDepth: 4, budgetMs: 8000, ttlMs: 15000, headCache: 4000, yieldEvery: 25 });

const tick = () => new Promise((r) => setImmediate(r));
const artifactIdOf = (rootId, rel) => `art_${createHash('sha256').update(`${rootId}\0${rel}`).digest('hex').slice(0, 20)}`;
export const isArtifactId = (v) => typeof v === 'string' && /^art_[0-9a-f]{20}$/.test(v);

// Claude Code's same-name order (code.claude.com/docs/en/skills, "Resolve skills that share a name").
const CLAUDE_RANK = { managed: 0, user: 1, synced: 3, project: 2, plugin: 9 };

/**
 * @param {object} o
 * @param {() => object[]} o.roots lib/skills/roots.js listRoots
 * @param {(realBase: string, file: string) => { text: string, binary: boolean, revision: string, size: number }} o.readHead
 *   a bounded, confined read of a head file (throws when it cannot be read as a regular file)
 * @param {(o: { type, text, folderName, binary }) => { name: string, description: string, problems: object, data: object }} o.describe
 * @param {(path: string) => object|null} [o.ownership] what the install ledger says of a folder or file
 * @param {(o: { text: string, name: string, family: string }) => object|null} [o.classifyBridge] an old bridge's signature
 */
export function createSkillsCatalog({ roots, readHead, describe, ownership = () => null, classifyBridge = () => null, limits = CATALOG_LIMITS, now = () => Date.now() }) {
  let snapshot = null;
  let pending = null;
  let generation = 0;
  let stale = true;
  const headCache = new Map();

  function cachedDescribe(key, read) {
    const hit = headCache.get(key);
    if (hit) { headCache.delete(key); headCache.set(key, hit); return hit; }
    const value = read();
    headCache.set(key, value);
    if (headCache.size > limits.headCache) headCache.delete(headCache.keys().next().value);
    return value;
  }

  async function headOf(realBase, file, { type, folderName }) {
    // The key follows a link inside the folder; the read itself (readHead) refuses one that leads out of it.
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('not a regular file');
    const key = `${file}\0${st.ino}\0${st.size}\0${st.mtimeMs}\0${type}\0${folderName}`;
    return cachedDescribe(key, () => {
      const head = readHead(realBase, file);
      const described = describe({ type, text: head.text, folderName, binary: head.binary });
      // When the head file last changed: the Library's "updated" column (an entry is never sorted by a guess).
      const updatedAt = Number.isFinite(st.mtimeMs) && st.mtimeMs > 0 ? new Date(st.mtimeMs).toISOString() : null;
      return { ...described, revision: head.revision, size: head.size, binary: head.binary, text: head.binary ? '' : head.text, updatedAt };
    });
  }

  /** Read one root. @returns {{ entries: object[], diagnostics: object[], truncated: boolean, count: number }} */
  async function scanRoot(root, state) {
    const entries = [];
    const diagnostics = [];
    let truncated = false;
    const base = root.resolvedPath;
    const skip = (rel, reason, message) => diagnostics.push({ rootId: root.rootId, path: rel, reason, message });
    const outOfAnchor = (real) => root.anchor && !(() => { try { return isInside(realPathOf(root.anchor), real, { allowRoot: true }); } catch { return false; } })();
    const common = {
      rootId: root.rootId, family: root.family, scope: root.scope, sourceKind: root.sourceKind, runtimes: root.runtimes,
      accountId: root.accountId, projectPath: root.projectPath, projectLabel: root.projectLabel, pluginId: root.pluginId || null,
      readOnly: root.policy?.write !== 'owner',
    };
    if (root.layout === 'skill-folders') {
      let names = [];
      try { names = (await fsp.readdir(base, { withFileTypes: true })).map((d) => d.name).sort(); } catch (err) { return { entries, diagnostics: [{ rootId: root.rootId, path: '', reason: 'unreadable', message: String(err?.code || err?.message || err) }], truncated, count: 0 }; }
      for (const name of names) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        // Claude's account skills and Codex's system skills are roots of their own.
        if (root.scope === 'user' && root.family === 'claude' && name === 'synced') continue;
        if (entries.length >= limits.maxPerRoot || state.total >= limits.maxEntries || now() > state.deadline) { truncated = true; break; }
        if (++state.seen % limits.yieldEvery === 0) await tick();
        const dir = join(base, name);
        let real;
        try { real = realPathOf(dir); } catch { skip(name, 'link', 'A link that leads nowhere.'); continue; }
        let st;
        try { st = await fsp.stat(real); } catch { skip(name, 'unreadable', 'Cannot be read.'); continue; }
        if (!st.isDirectory()) continue;
        if (outOfAnchor(real)) { skip(name, 'outside-project', 'A link that leads out of the project: not read.'); continue; }
        const linked = real !== join(base, name);
        // A link in a project's folder must stay in the project; one in the user's own folder is theirs.
        if (linked && root.scope !== 'user' && root.scope !== 'shared' && !isInside(base, real)) { skip(name, 'link', 'A link out of its folder: not read.'); continue; }
        const head = join(real, 'SKILL.md');
        let meta;
        try { meta = await headOf(real, head, { type: 'skill', folderName: name }); } catch (err) {
          if (err?.code === 'ENOENT') skip(name, 'no-skill-md', 'A folder without SKILL.md: not a skill.');
          else skip(name, 'unreadable-head', `SKILL.md cannot be read (${err?.status === 413 ? 'too large' : (err?.code || err?.message || 'error')}).`);
          continue;
        }
        const rel = name;
        entries.push({
          ...common, id: artifactIdOf(root.rootId, rel), kind: 'skill', name: meta.name || name, folderName: name, relPath: rel,
          invocationName: root.scope === 'plugin' && root.pluginId ? `${root.pluginId.split('@')[0]}:${meta.name || name}` : (root.scope === 'synced' ? `anthropic-skills:${meta.name || name}` : (meta.name || name)),
          description: meta.description, problems: meta.problems, path: dir, realPath: real, headPath: head, linked,
          revision: meta.revision, size: meta.size, binary: meta.binary, data: meta.data, updatedAt: meta.updatedAt || null,
          ownership: ownership(dir), files: null,
        });
        state.total++;
      }
    } else {
      const maxDepth = root.kind === 'commands' ? limits.maxCommandDepth : 1;
      const kind = root.kind === 'commands' ? 'command' : root.kind === 'agents' ? 'agent' : 'prompt';
      const walk = async (dir, relDir, depth) => {
        let dirents = [];
        try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { if (!relDir) throw err; skip(relDir, 'unreadable', 'A folder that cannot be read.'); return; }
        dirents.sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const d of dirents) {
          if (d.name.startsWith('.')) continue;
          if (entries.length >= limits.maxPerRoot || state.total >= limits.maxEntries || now() > state.deadline) { truncated = true; return; }
          if (++state.seen % limits.yieldEvery === 0) await tick();
          const full = join(dir, d.name);
          const rel = relDir ? `${relDir}/${d.name}` : d.name;
          if (d.isDirectory()) { if (depth + 1 < maxDepth) await walk(full, rel, depth + 1); else if (kind === 'command') skip(rel, 'too-deep', 'Nested deeper than SynaBun reads.'); continue; }
          if (!/\.md$/i.test(d.name)) continue;
          let meta;
          try { meta = await headOf(base, full, { type: kind === 'prompt' ? 'command' : kind, folderName: d.name.replace(/\.md$/i, '') }); } catch (err) {
            skip(rel, d.isSymbolicLink() ? 'link' : 'unreadable-head', d.isSymbolicLink() ? 'A link: read only when it stays in its folder.' : `Cannot be read (${err?.status === 413 ? 'too large' : (err?.code || err?.message || 'error')}).`);
            continue;
          }
          const stem = d.name.replace(/\.md$/i, '');
          const namespace = relDir ? relDir.split('/').join(':') : '';
          const plugin = root.scope === 'plugin' && root.pluginId ? root.pluginId.split('@')[0] : '';
          const invocationName = kind === 'prompt' ? `prompts:${stem}` : [plugin, namespace, stem].filter(Boolean).join(':');
          const bridge = kind === 'prompt' || root.sourceKind === 'legacy-bridge' ? classifyBridge({ text: meta.text || '', name: stem, family: root.family, path: full }) : null;
          entries.push({
            ...common, id: artifactIdOf(root.rootId, rel), kind, name: kind === 'agent' && meta.name ? meta.name : stem, folderName: stem, relPath: rel, namespace,
            invocationName, description: meta.description, problems: meta.problems, path: full, realPath: full, headPath: full, linked: d.isSymbolicLink(),
            revision: meta.revision, size: meta.size, binary: meta.binary, data: meta.data, updatedAt: meta.updatedAt || null, ownership: ownership(full), bridge, files: null,
          });
          state.total++;
        }
      };
      try { await walk(base, '', 0); } catch (err) { return { entries, diagnostics: [{ rootId: root.rootId, path: '', reason: 'unreadable', message: String(err?.code || err?.message || err) }], truncated, count: 0 }; }
    }
    return { entries, diagnostics, truncated, count: entries.length };
  }

  /** Same-named entries, runtime by runtime: which one a runtime runs, or that it lists both. */
  function collide(entries) {
    const groups = new Map();
    for (const e of entries) {
      if (e.kind === 'prompt') continue;
      for (const runtime of e.runtimes) {
        const key = `${runtime}\0${e.invocationName}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
    }
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      const runtime = key.split('\0')[0];
      // One folder seen through two roots (a link) is one skill, not a collision.
      const distinct = new Map(list.map((e) => [e.realPath, e]));
      if (distinct.size < 2) continue;
      if (runtime === 'claude') {
        const ranked = [...list].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'skill' ? -1 : 1) || ((CLAUDE_RANK[a.scope] ?? 5) - (CLAUDE_RANK[b.scope] ?? 5)));
        const winner = ranked[0];
        for (const e of list) {
          (e.collisions ||= []).push({
            runtime, with: list.filter((x) => x !== e).map((x) => x.id), outcome: e === winner ? 'runs' : 'shadowed',
            why: e === winner ? `/${e.invocationName} runs this one in Claude Code.` : `Claude Code runs the ${winner.scope} ${winner.kind} of the same name instead (a skill comes before a command; managed, then personal, then project).`,
          });
        }
      } else {
        for (const e of list) {
          (e.collisions ||= []).push({ runtime, with: list.filter((x) => x !== e).map((x) => x.id), outcome: 'both-listed', why: `${runtime === 'codex' ? 'Codex' : 'OpenCode'} lists every skill of this name; which one the model picks is not fixed. Give them different names.` });
        }
      }
    }
  }

  async function build() {
    const state = { total: 0, seen: 0, deadline: now() + limits.budgetMs };
    const rootList = roots();
    const entries = [];
    const diagnostics = [];
    const rootRows = [];
    let truncated = false;
    for (const root of rootList) {
      const row = { ...root, count: 0, truncated: false };
      if (root.status !== 'ok') {
        if (root.status !== 'absent') diagnostics.push({ rootId: root.rootId, path: '', reason: root.status, message: root.status === 'not-a-folder' ? 'Not a folder.' : 'Cannot be read.' });
        rootRows.push(row);
        continue;
      }
      if (now() > state.deadline || state.total >= limits.maxEntries) { row.truncated = true; truncated = true; rootRows.push(row); continue; }
      const res = await scanRoot(root, state);
      entries.push(...res.entries);
      diagnostics.push(...res.diagnostics);
      if (res.diagnostics.some((d) => d.path === '' && d.reason === 'unreadable')) row.status = 'unreadable';
      row.count = res.count;
      row.truncated = res.truncated;
      truncated ||= res.truncated;
      rootRows.push(row);
    }
    collide(entries);
    generation += 1;
    return { generation, generatedAt: new Date(now()).toISOString(), entries, roots: rootRows, diagnostics, truncated };
  }

  /** The catalog, read again when it is stale; one read at a time (callers share it). */
  async function scan({ force = false } = {}) {
    if (!force && snapshot && !stale && now() - Date.parse(snapshot.generatedAt) < limits.ttlMs) return snapshot;
    if (pending) return pending;
    pending = build().then((s) => { snapshot = s; stale = false; return s; }).finally(() => { pending = null; });
    return pending;
  }

  function invalidate() { stale = true; }

  /** One page of entries, filtered. A cursor of an older scan restarts at the top (`cursorReset`). */
  async function page({ cursor = null, limit = 100, kind = null, runtime = null, rootId = null, scope = null, q = '' } = {}) {
    const s = await scan();
    let offset = 0;
    let cursorReset = false;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf-8'));
        if (c && c.g === s.generation && Number.isInteger(c.o) && c.o >= 0) offset = c.o; else cursorReset = true;
      } catch { cursorReset = true; }
    }
    const needle = String(q || '').toLowerCase();
    const filtered = s.entries.filter((e) => (!kind || e.kind === kind) && (!runtime || e.runtimes.includes(runtime)) && (!rootId || e.rootId === rootId)
      && (!scope || e.scope === scope) && (!needle || `${e.name} ${e.description}`.toLowerCase().includes(needle)));
    const size = Math.max(1, Math.min(500, Number(limit) || 100));
    const items = filtered.slice(offset, offset + size).map(publicEntry);
    const next = offset + size < filtered.length ? Buffer.from(JSON.stringify({ g: s.generation, o: offset + size })).toString('base64url') : null;
    return { items, nextCursor: next, total: filtered.length, generation: s.generation, generatedAt: s.generatedAt, truncated: s.truncated, cursorReset };
  }

  /** One entry by id, with its file tree (read now, bounded) and its head file's text. */
  async function detail(id, { tree = true } = {}) {
    if (!isArtifactId(id)) return null;
    let s = await scan();
    let entry = s.entries.find((e) => e.id === id);
    if (!entry) { s = await scan({ force: true }); entry = s.entries.find((e) => e.id === id); }
    if (!entry) return null;
    const out = { ...publicEntry(entry), text: null };
    // The head file's text, read now the way the scan reads it: bounded, a regular file inside its folder (a skill)
    // or its root (a command, an agent). A file that is not text is said to be binary; one that cannot be read says why.
    try {
      const base = entry.kind === 'skill' ? entry.realPath : (s.roots.find((r) => r.rootId === entry.rootId)?.resolvedPath || entry.realPath);
      const head = readHead(base, entry.headPath);
      if (head.binary) out.binary = true;
      else out.text = head.text;
    } catch (err) {
      out.textError = err?.status === 413 ? 'too large' : (err?.code || err?.message || 'unreadable');
    }
    if (entry.kind === 'skill' && tree) {
      const listing = listConfined(entry.realPath, entry.realPath, { skip: (n) => n === 'node_modules' });
      const plain = (nodes) => nodes.map((n) => (n.type === 'dir' ? { name: n.name, path: n.path, type: 'dir', children: plain(n.children || []) } : { name: n.name, path: n.path, type: 'file', size: n.size }));
      out.files = plain(listing.entries);
      out.filesTruncated = listing.truncated;
    }
    return { entry: out, internal: entry };
  }

  /** The internal entry (paths included), for the service. */
  async function find(id) {
    if (!isArtifactId(id)) return null;
    const s = await scan();
    return s.entries.find((e) => e.id === id) || (await scan({ force: true })).entries.find((e) => e.id === id) || null;
  }

  return { scan, invalidate, page, detail, find, roots: () => roots(), _headCache: headCache };
}

/** An entry as the API answers it (no frontmatter object; paths are the user's own and stay). */
export function publicEntry(e) {
  const { data, realPath, ...rest } = e;
  return { ...rest, linked: !!e.linked, collisions: e.collisions || [] };
}

/** A path inside a root, as the root's own relative path (forward slashes). */
export function relativeIn(root, path) {
  return relative(root, path).split(sep).join('/');
}

