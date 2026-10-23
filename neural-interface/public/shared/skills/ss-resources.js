// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: what a skill refers to, and its arguments
// ═══════════════════════════════════════════
//
// A skill is its SKILL.md and the files it points the model to. This reads those pointers and checks them
// against the folder (rule L-05): a link that leaves the skill, a file that is not there, one an export leaves
// out (hidden files, node_modules), an absolute path that will not travel with it, a chain of references more
// than one level deep, and files nothing refers to. Markdown links are references by definition; a path in
// `code` counts only when it starts where the skill's own files do (./, a top-level folder of the skill, or the
// skill-folder variables), so a skill about a repository can name that repository's files freely.
//
// It also reads the argument placeholders of the body for each runtime (rule L-08): Claude Code counts $0 as the
// first argument; Codex and OpenCode read a native skill body as written, so $ARGUMENTS reaches the model as
// text there. $SKILL_DIR is a convention of SynaBun's old bridges, not a variable any runtime fills.
//
// No DOM, no I/O: the caller hands in the files and their text.

const LINK_RE = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const CODE_RE = /`([^`\n]{1,300})`/g;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const VARIABLE_PREFIX_RE = /^(?:\$SKILL_DIR|\$\{CLAUDE_SKILL_DIR\}|\$CLAUDE_SKILL_DIR)(?=\/|$)/;
const ALWAYS_KEPT = /^(?:SKILL\.md|icon\.(?:png|svg|jpe?g|webp)|LICEN[CS]E(?:\.[A-Za-z]+)?|README(?:\.md)?|agents\/openai\.yaml|evals?\/.*)$/i;
const TEXT_EXT = /\.(?:md|markdown|mdx|txt)$/i;

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Join a reference onto the folder of the file it is in, as the skill's own relative path; `escapes` when it climbs out. */
function resolveRef(fromDir, target) {
  const parts = fromDir ? fromDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return { escapes: true, path: null }; parts.pop(); continue; }
    parts.push(seg);
  }
  return { escapes: false, path: parts.join('/') };
}

/**
 * The references of a skill folder, checked.
 * @param {object} o
 * @param {{ path: string, size?: number, text?: string|null }[]} o.files every file (text null for a binary)
 * @param {string[]} [o.dirs] every folder
 * @param {{ path: string, reason: string }[]} [o.excluded] what an export leaves out
 * @param {string} [o.headPath]
 * @returns {{ references: object[], orphans: string[], diagnostics: object[] }}
 */
export function analyzeResources({ files = [], dirs = [], excluded = [], headPath = 'SKILL.md' } = {}) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const dirSet = new Set(dirs);
  for (const f of files) { const p = f.path.split('/'); for (let i = 1; i < p.length; i++) dirSet.add(p.slice(0, i).join('/')); }
  const excludedSet = new Map(excluded.map((e) => [e.path, e.reason]));
  const topLevel = new Set([...dirSet].filter((d) => !d.includes('/')));
  const references = [];
  const diagnostics = [];
  const add = (ruleId, severity, message, file, line) => diagnostics.push({ ruleId, severity, message, file, line });
  const referenced = new Set([headPath]);

  const read = (path, depth, seen) => {
    const file = byPath.get(path);
    if (!file || typeof file.text !== 'string' || seen.has(path)) return;
    seen.add(path);
    const text = file.text;
    const fromDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const found = [];
    for (const m of text.matchAll(LINK_RE)) {
      const raw = m[1];
      if (SCHEME_RE.test(raw) || raw.startsWith('#') || raw.startsWith('//')) continue;
      found.push({ raw: raw.split('#')[0].split('?')[0], kind: 'link', index: m.index });
    }
    for (const m of text.matchAll(CODE_RE)) {
      const raw = m[1].trim();
      if (/\s/.test(raw) || SCHEME_RE.test(raw)) continue;
      if (VARIABLE_PREFIX_RE.test(raw)) { found.push({ raw, kind: 'variable', index: m.index }); continue; }
      const first = raw.replace(/^\.\//, '').split('/')[0];
      if (raw.startsWith('./') || (raw.includes('/') && topLevel.has(first))) found.push({ raw, kind: 'code', index: m.index });
      else if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('~/')) {
        if (/(?:^|\/)(?:skills?|\.claude|\.codex|\.agents|\.opencode)\//.test(raw)) found.push({ raw, kind: 'code', index: m.index });
      }
    }
    for (const ref of found) {
      if (!ref.raw) continue;
      const line = lineAt(text, ref.index);
      const entry = { from: path, raw: ref.raw, kind: ref.kind, line, depth, to: null, status: 'ok' };
      if (ref.raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(ref.raw) || ref.raw.startsWith('~/')) {
        entry.status = 'absolute';
        add('L-05-absolute', 'warning', `${ref.raw} is a path on this computer: it does not travel with the skill. Point to a file inside the skill instead.`, path, line);
        references.push(entry);
        continue;
      }
      let target = ref.raw;
      let base = fromDir;
      if (ref.kind === 'variable') { target = ref.raw.replace(VARIABLE_PREFIX_RE, '').replace(/^\//, ''); base = ''; }
      let decoded = target;
      try { decoded = decodeURIComponent(target); } catch { decoded = target; }
      const resolved = resolveRef(base, decoded.replace(/\\/g, '/'));
      if (resolved.escapes) {
        entry.status = 'escapes';
        add('L-05-escape', 'error', `${ref.raw} leads out of the skill's folder.`, path, line);
        references.push(entry);
        continue;
      }
      entry.to = resolved.path;
      const hiddenPart = resolved.path.split('/').find((seg) => seg.startsWith('.') || seg === 'node_modules');
      if (excludedSet.has(resolved.path) || hiddenPart) {
        entry.status = 'excluded';
        add('L-05-excluded', 'error', `${ref.raw} points to ${resolved.path}, which an export leaves out (${excludedSet.get(resolved.path) || (hiddenPart === 'node_modules' ? 'node_modules' : 'hidden')}): the skill would refer to a file it does not carry.`, path, line);
      } else if (byPath.has(resolved.path)) {
        referenced.add(resolved.path);
        if (depth >= 1 && TEXT_EXT.test(resolved.path) && resolved.path !== headPath) {
          add('L-05-deep', 'info', `${path} refers on to ${resolved.path}: references more than one level deep may be read only in part. Link it from ${headPath} instead.`, path, line);
        }
        if (depth < 2 && TEXT_EXT.test(resolved.path)) read(resolved.path, depth + 1, seen);
      } else if (dirSet.has(resolved.path) || resolved.path === '') {
        entry.status = 'directory';
        for (const f of files) if (resolved.path === '' || f.path.startsWith(`${resolved.path}/`)) referenced.add(f.path);
      } else {
        entry.status = 'missing';
        add('L-05-missing', ref.kind === 'link' ? 'error' : 'warning', `${ref.raw} is not in the skill.`, path, line);
      }
      references.push(entry);
    }
  };
  read(headPath, 0, new Set());

  const orphans = files.map((f) => f.path).filter((p) => !referenced.has(p) && !ALWAYS_KEPT.test(p) && !p.split('/').some((s) => s.startsWith('.')));
  if (orphans.length) {
    const shown = orphans.slice(0, 12).join(', ') + (orphans.length > 12 ? `, and ${orphans.length - 12} more` : '');
    add('L-05-orphan', 'info', `${orphans.length === 1 ? 'One file is' : `${orphans.length} files are`} not referred to from ${headPath} or the files it links: ${shown}. A model finds a file only when it is pointed to it.`, headPath, null);
  }
  return { references, orphans, diagnostics };
}

/**
 * The argument placeholders of a body, for one runtime.
 * @param {string} runtime 'claude' | 'codex' | 'opencode' | 'portable' | 'claude-cloud'
 * @param {{ body: string, bodyLine?: number, headPath?: string, declared?: string[] }} o
 */
export function argumentDiagnostics(runtime, { body = '', bodyLine = 1, headPath = 'SKILL.md', declared = [] } = {}) {
  const out = [];
  const text = String(body);
  const add = (ruleId, severity, message, index) => out.push({ ruleId, severity, message, file: headPath, line: index === null ? null : lineAt(text, index) + bodyLine - 1 });
  const first = (re) => { const m = re.exec(text); return m ? m.index : -1; };
  const skillDir = first(/(?<!\\)\$SKILL_DIR\b/);
  if (skillDir >= 0) add('L-08-bridge-token', 'warning', '$SKILL_DIR is a convention of SynaBun\'s old bridges, not a variable a runtime fills. Use a path relative to the skill (Claude Code also has ${CLAUDE_SKILL_DIR}).', skillDir);
  const args = first(/(?<!\\)\$ARGUMENTS\b/);
  const positional = first(/(?<!\\)\$\d+\b/);
  if (runtime === 'claude') {
    const one = first(/(?<!\\)\$1\b/);
    if (one >= 0 && first(/(?<!\\)\$0\b/) < 0) add('L-08-zero-based', 'info', 'Claude Code counts arguments from $0: $1 is the second argument.', one);
  } else if (runtime === 'codex' || runtime === 'opencode' || runtime === 'portable' || runtime === 'claude-cloud') {
    const where = args >= 0 ? args : positional;
    if (where >= 0) {
      const who = { codex: 'Codex', opencode: 'OpenCode', portable: 'The portable format', 'claude-cloud': 'Claude.ai and the API' }[runtime];
      add('L-08-arguments-literal', 'info', `${who} reads a skill body as written: ${args >= 0 ? '$ARGUMENTS' : 'a $N placeholder'} reaches the model as text, not filled.`, where);
    }
    const claudeVar = first(/\$\{CLAUDE_[A-Z_]+\}/);
    if (claudeVar >= 0 && runtime !== 'portable') add('L-08-claude-variable', 'info', 'A ${CLAUDE_*} variable is filled by Claude Code only; elsewhere it stays as written.', claudeVar);
  }
  if (declared.length && runtime !== 'claude') add('L-08-named-arguments', 'info', `"arguments" (${declared.join(', ')}) is a Claude Code field; other runtimes do not fill $${declared[0]}.`, null);
  return out;
}
