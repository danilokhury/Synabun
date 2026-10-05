// ═══════════════════════════════════════════
// SynaBun — Style Guide store
// ═══════════════════════════════════════════
//
// Where a project's guide lives and what a save does. One folder,
// <DATA_HOME>/data/style-guides/, keyed by sha1(projectPath)[0:16]:
//
//   <hash>.json             the guide (schema v2)
//   <hash>.history.json     [{ revision, at, source, label, config }], newest first, 30 kept
//   <hash>.proposals.json   [{ id, at, status, decidedAt, runId, provider, model, reason, changes }]
//   assets/<hash>/          uploaded logo files (mirrored into <project>/.synabun/style-guide/)
//
// save() normalizes, bumps the revision, records history and writes the project's
// artifacts (DESIGN.md, tokens.json, tokens.css, the Tailwind file, the pointers),
// each one only when its `exports` flag is on. A save that changes nothing keeps the
// revision. Agents never call save(): their only write path is addProposal(), and a
// proposal changes nothing until the user accepts it.
//
// loadStyleGuideForRun(cwd, taskClass) is what the Assistant's dispatcher reads when
// a worker starts: the summary and the file paths, or null when the project has no
// saved guide or the guide keeps that class of run out.

import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getDataHome } from '../../../lib/paths.js';
import { exportCss } from './export-css.js';
import { exportDtcgText } from './export-dtcg.js';
import { exportTailwindV3, exportTailwindV4 } from './export-tailwind.js';
import { POINTER_FILES, findPointer, pointerBlock, removePointer, upsertPointer } from './pointers.js';
import { renderDesignMd } from './render-design-md.js';
import { STYLE_GUIDE_OUT_DIR, applyMergePatch, diffConfigs, isPlainObject, normalizeStyleGuide } from './schema.js';
import { estimateTokens, styleGuideSummaryForClass } from './summary.js';
import { containedPath, safeLogoFile } from './security.js';

export const HISTORY_LIMIT = 30;
export const PROPOSAL_LIMIT = 200;
export const MAX_PROPOSAL_BYTES = 64 * 1024;
/** Consecutive unlabeled editor saves closer than this share one history entry, so autosave does not flush the 30. */
export const HISTORY_COALESCE_MS = 5 * 60 * 1000;
export const EXPORT_FORMATS = Object.freeze(['design-md', 'dtcg', 'css', 'tailwind-v4', 'tailwind-v3']);
// Not a design decision, so never an agent's to change through a proposal.
const PROPOSAL_FORBIDDEN_KEYS = Object.freeze(['schemaVersion', 'projectPath', 'updatedAt', 'revision', 'agents', 'exports']);
const GENERATED_MARK = 'SynaBun Style Guide';
const DESIGN_FILE = 'DESIGN.md';
const DESIGN_BACKUP = 'DESIGN.before-synabun.md';

export class StyleGuideError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'StyleGuideError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/** sha1(resolved project path), first 16 hex characters: the store key and the assets folder name. */
export function styleGuideHash(projectPath) {
  return createHash('sha1').update(resolve(String(projectPath))).digest('hex').slice(0, 16);
}

/** <dataDir>/style-guides, from an explicit data folder, a data home, or the default data home. */
export function styleGuidesDir({ dataDir = null, dataHome = null } = {}) {
  return resolve(dataDir || resolve(dataHome || getDataHome(), 'data'), 'style-guides');
}

function inside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** Write through a temp file in the same folder, so a reader never sees half a file. */
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw error;
  }
}

/** Write only when the content differs. → true when the file was written. */
function writeIfChanged(path, text) {
  try { if (readFileSync(path, 'utf8') === text) return false; } catch { /* not there yet */ }
  writeAtomic(path, text);
  return true;
}

const comparable = (config) => JSON.stringify({ ...config, updatedAt: null, revision: 0 });

/** The files a guide writes into its project, by format: [{ format, path, relative }] for the enabled exports. */
export function artifactFiles(projectPath, config, { formats = null } = {}) {
  const root = resolve(projectPath);
  const dir = config.exports.outDir || STYLE_GUIDE_OUT_DIR;
  const wanted = Array.isArray(formats) && formats.length
    ? formats.map((format) => (format === 'tailwind' ? `tailwind-${config.exports.tailwind === 'v3' ? 'v3' : 'v4'}` : String(format))).filter((format) => EXPORT_FORMATS.includes(format))
    : [
      ...(config.exports.designMd ? ['design-md'] : []),
      ...(config.exports.tokensJson ? ['dtcg'] : []),
      ...(config.exports.cssVars ? ['css'] : []),
      ...(config.exports.tailwind === 'v4' ? ['tailwind-v4'] : config.exports.tailwind === 'v3' ? ['tailwind-v3'] : []),
    ];
  const relativeOf = { 'design-md': DESIGN_FILE, dtcg: `${dir}/tokens.json`, css: `${dir}/tokens.css`, 'tailwind-v4': `${dir}/tailwind.css`, 'tailwind-v3': `${dir}/tailwind.tokens.cjs` };
  const enabled = { 'design-md': config.exports.designMd, dtcg: config.exports.tokensJson, css: config.exports.cssVars, 'tailwind-v4': config.exports.tailwind === 'v4', 'tailwind-v3': config.exports.tailwind === 'v3' };
  return [...new Set(wanted)].filter((format) => enabled[format]).map((format) => ({ format, relative: relativeOf[format], path: resolve(root, relativeOf[format]) }));
}

/** The text of one export format (the same bytes the file gets). `theme` flattens css / tailwind-v4 to one theme. */
export function renderFormat(config, format, { theme = null } = {}) {
  switch (format) {
    case 'design-md': return { text: renderDesignMd(config), contentType: 'text/markdown; charset=utf-8', filename: DESIGN_FILE };
    case 'dtcg': return { text: exportDtcgText(config, { generatedAt: config.updatedAt }), contentType: 'application/design-tokens+json; charset=utf-8', filename: 'tokens.json' };
    case 'css': return { text: exportCss(config, { theme }), contentType: 'text/css; charset=utf-8', filename: 'tokens.css' };
    case 'tailwind-v4': return { text: exportTailwindV4(config, { theme }), contentType: 'text/css; charset=utf-8', filename: 'tailwind.css' };
    case 'tailwind-v3': return { text: exportTailwindV3(config), contentType: 'text/javascript; charset=utf-8', filename: 'tailwind.tokens.cjs' };
    default: return null;
  }
}

/**
 * The store over one data home. `projects()` returns the registered projects ([{ path, label }] or
 * paths); without it the list is read from <dataDir>/claude-code-projects.json. `now()` is injectable.
 */
export function createStyleGuideStore({ dataHome = null, dataDir = null, projects = null, now = () => new Date(), log = () => {} } = {}) {
  const dataFolder = resolve(dataDir || resolve(dataHome || getDataHome(), 'data'));
  const dir = resolve(dataFolder, 'style-guides');
  const assetsDir = resolve(dir, 'assets');
  const iso = () => now().toISOString();

  function listProjects() {
    let rows = [];
    try { rows = typeof projects === 'function' ? projects() : readJson(resolve(dataFolder, 'claude-code-projects.json'), []); } catch { rows = []; }
    return (Array.isArray(rows) ? rows : [])
      .map((row) => (typeof row === 'string' ? { path: row } : row))
      .filter((row) => row && typeof row.path === 'string' && row.path)
      .map((row) => ({ path: resolve(row.path), label: row.label || basename(row.path) }));
  }

  /** The registered project that contains `anyPath` (the deepest one when projects nest), or null. */
  function resolveProject(anyPath) {
    if (typeof anyPath !== 'string' || !anyPath.trim() || !isAbsolute(anyPath.trim())) return null;
    const target = resolve(anyPath.trim());
    return listProjects().filter((project) => inside(target, project.path) && containedPath(project.path, target)).sort((a, b) => b.path.length - a.path.length)[0] || null;
  }

  function paths(projectPath) {
    const hash = styleGuideHash(projectPath);
    return { hash, json: resolve(dir, `${hash}.json`), history: resolve(dir, `${hash}.history.json`), proposals: resolve(dir, `${hash}.proposals.json`), assets: resolve(assetsDir, hash) };
  }

  function assertPath(root, path) {
    if (!containedPath(root, path, { noSymlinks: true })) throw new StyleGuideError('UNSAFE_PATH', 'Style guide paths must stay inside the project and may not traverse symlinks.', 403);
    return path;
  }

  // Validate before committing a revision, so a refused export cannot partly save the guide.
  function validateArtifacts(root, config, formats = null) {
    for (const file of artifactFiles(root, config, { formats })) assertPath(root, file.path);
    assertPath(root, resolve(root, config.exports.outDir, 'tokens.json'));
    assertPath(root, resolve(root, STYLE_GUIDE_OUT_DIR, DESIGN_BACKUP));
    for (const variant of config.logo.variants.filter((v) => safeLogoFile(v.file))) {
      assertPath(assetsDir, resolve(paths(root).assets, variant.file));
      assertPath(root, resolve(root, STYLE_GUIDE_OUT_DIR, variant.file));
    }
  }

  function isSaved(projectPath) {
    return existsSync(paths(projectPath).json);
  }

  /** { config, saved }: the stored guide normalized (a v1 file migrates here), or the defaults. */
  function load(projectPath) {
    const root = resolve(projectPath);
    const file = paths(root).json;
    if (!existsSync(file)) return { config: normalizeStyleGuide({}, { projectPath: root }), saved: false };
    const raw = readJson(file, null);
    // A file that cannot be read is not silently replaced: it counts as saved, so the next save keeps its revision line.
    return { config: normalizeStyleGuide(isPlainObject(raw) ? raw : {}, { projectPath: root }), saved: true };
  }

  function readHistory(projectPath) {
    const rows = readJson(paths(projectPath).history, []);
    return Array.isArray(rows) ? rows.filter((row) => isPlainObject(row) && Number.isFinite(Number(row.revision))) : [];
  }

  function readProposals(projectPath) {
    const rows = readJson(paths(projectPath).proposals, []);
    return Array.isArray(rows) ? rows.filter((row) => isPlainObject(row) && typeof row.id === 'string') : [];
  }

  function writeProposals(projectPath, rows) {
    // Decided proposals age out first; pending ones are never dropped.
    let kept = rows;
    if (kept.length > PROPOSAL_LIMIT) {
      const decided = kept.filter((row) => row.status !== 'pending').slice(0, Math.max(0, PROPOSAL_LIMIT - kept.filter((row) => row.status === 'pending').length));
      kept = kept.filter((row) => row.status === 'pending' || decided.includes(row));
    }
    writeAtomic(paths(projectPath).proposals, `${JSON.stringify(kept, null, 2)}\n`);
  }

  function mirrorLogos(root, config) {
    const variants = config.logo.variants.filter((variant) => safeLogoFile(variant.file));
    if (!variants.length) return;
    const target = resolve(root, STYLE_GUIDE_OUT_DIR);
    mkdirSync(target, { recursive: true });
    for (const variant of variants) {
      const source = resolve(paths(root).assets, variant.file);
      if (!existsSync(source)) continue;
      try { copyFileSync(source, resolve(target, variant.file)); } catch (error) { log('style-guide', `logo mirror failed: ${error.message}`); }
    }
  }

  /** Remove a token file this module generated that the current settings no longer produce. */
  function dropStale(root, config, keep) {
    const dirName = config.exports.outDir || STYLE_GUIDE_OUT_DIR;
    for (const name of ['tokens.json', 'tokens.css', 'tailwind.css', 'tailwind.tokens.cjs']) {
      const path = resolve(root, dirName, name);
      if (keep.has(path) || !existsSync(path)) continue;
      try {
        // Only a file that says it is ours: never a file the project put there.
        if (readFileSync(path, 'utf8').slice(0, 400).includes(GENERATED_MARK)) unlinkSync(path);
      } catch { /* left in place */ }
    }
  }

  /**
   * Write the project's artifacts for `config`. Without `formats`: the enabled exports (and stale
   * generated token files removed); with `formats`: the requested subset of enabled exports.
   * → [{ format, path, changed, backup? }]
   */
  function writeArtifacts(projectPath, config, { formats = null } = {}) {
    const root = resolve(projectPath);
    validateArtifacts(root, config, formats);
    const files = artifactFiles(root, config, { formats });
    const written = [];
    for (const file of files) {
      const rendered = renderFormat(config, file.format);
      const entry = { format: file.format, path: file.path };
      if (file.format === 'design-md' && existsSync(file.path)) {
        // A DESIGN.md somebody wrote by hand is kept once, beside the token files, before it is replaced.
        let existing = '';
        try { existing = readFileSync(file.path, 'utf8'); } catch { existing = ''; }
        const backup = resolve(root, STYLE_GUIDE_OUT_DIR, DESIGN_BACKUP);
        if (existing.trim() && !existing.includes(`Generated by ${GENERATED_MARK}`) && !existsSync(backup)) {
          writeAtomic(backup, existing);
          entry.backup = backup;
        }
      }
      entry.changed = writeIfChanged(file.path, rendered.text);
      written.push(entry);
    }
    if (!formats) dropStale(root, config, new Set(files.map((file) => file.path)));
    mirrorLogos(root, config);
    return written;
  }

  /** [{ format, path, exists }] for the enabled exports. */
  function written(projectPath, config) {
    return artifactFiles(projectPath, config).map((file) => ({ format: file.format, path: file.path, exists: existsSync(file.path) }));
  }

  /**
   * Install or remove the pointer block in <project>/CLAUDE.md and AGENTS.md.
   * → [{ path, state }] with state created | updated | unchanged | removed | deleted | absent | skipped | error.
   */
  function syncPointers(projectPath, config, enabled) {
    const root = resolve(projectPath);
    const block = pointerBlock(config);
    return POINTER_FILES.map((name) => {
      const path = resolve(root, name);
      try {
        let stat = null;
        try { stat = lstatSync(path); } catch { stat = null; }
        if (stat && (stat.isSymbolicLink() || !stat.isFile())) return { path, state: 'skipped', reason: 'not a regular file' };
        const before = stat ? readFileSync(path, 'utf8') : null;
        if (enabled) {
          const after = upsertPointer(before ?? '', block);
          if (before === after) return { path, state: 'unchanged' };
          writeAtomic(path, after);
          return { path, state: before === null ? 'created' : 'updated' };
        }
        if (before === null || !findPointer(before)) return { path, state: 'absent' };
        const after = removePointer(before);
        if (after === '') { rmSync(path); return { path, state: 'deleted' }; }
        writeAtomic(path, after);
        return { path, state: 'removed' };
      } catch (error) {
        return { path, state: 'error', reason: error?.message || String(error) };
      }
    });
  }

  /**
   * Save a guide: normalize → revision + 1 → history → artifacts. A config equal to the stored one
   * keeps its revision (the artifacts are still brought up to date). → { config, written, pointers, changed }
   */
  function save(projectPath, input, { source = 'ui', label = '' } = {}) {
    const root = resolve(projectPath);
    const p = paths(root);
    const current = load(root);
    const next = normalizeStyleGuide(input, { projectPath: root });
    validateArtifacts(root, next);
    const changed = !current.saved || comparable(next) !== comparable(current.config);
    if (changed) {
      const at = iso();
      next.revision = (current.saved ? current.config.revision : 0) + 1;
      next.updatedAt = at;
      mkdirSync(dir, { recursive: true });
      writeAtomic(p.json, `${JSON.stringify(next, null, 2)}\n`);
      const history = readHistory(root);
      const entry = { revision: next.revision, at, source: String(source || 'ui').slice(0, 80), label: String(label || '').slice(0, 120), config: next };
      const newest = history[0];
      const coalesce = entry.source === 'ui' && !entry.label && newest && newest.source === 'ui' && !newest.label
        && Date.parse(at) - Date.parse(newest.at) < HISTORY_COALESCE_MS && Date.parse(at) >= Date.parse(newest.at);
      if (coalesce) history[0] = entry; else history.unshift(entry);
      writeAtomic(p.history, `${JSON.stringify(history.slice(0, HISTORY_LIMIT))}\n`);
    } else {
      next.revision = current.config.revision;
      next.updatedAt = current.config.updatedAt;
    }
    const files = writeArtifacts(root, next);
    // The block is only ever removed by this module when it is there: a project that never opted in is not touched.
    const pointers = syncPointers(root, next, next.exports.projectPointers);
    return { config: next, written: files, pointers, changed };
  }

  /** [{ revision, at, source, label }], newest first. */
  function history(projectPath) {
    return readHistory(projectPath).map(({ revision, at, source, label }) => ({ revision: Number(revision), at: at || null, source: source || 'ui', label: label || '' }));
  }

  function historyConfig(projectPath, revision) {
    const entry = readHistory(projectPath).find((row) => Number(row.revision) === Number(revision));
    return entry && isPlainObject(entry.config) ? entry.config : null;
  }

  function restore(projectPath, revision) {
    const config = historyConfig(projectPath, revision);
    if (!config) throw new StyleGuideError('REVISION_NOT_FOUND', `Revision ${revision} is not in the history.`, 404);
    // The settings about agents and exports are the current ones: a restore brings back the design.
    const current = load(projectPath).config;
    return save(projectPath, { ...config, agents: current.agents, exports: current.exports, logo: current.logo }, { source: `restore:${Number(revision)}` });
  }

  /** What a proposal would change: the patch applied to the current guide, and the leaf diff. */
  function previewChanges(projectPath, changes) {
    const current = load(projectPath).config;
    const config = normalizeStyleGuide(applyMergePatch(current, changes), { projectPath: current.projectPath });
    return { config, diff: diffConfigs(current, config) };
  }

  /** [{ id, at, status, decidedAt, runId, provider, model, reason, changes, diff }], newest first. */
  function proposals(projectPath, { status = null } = {}) {
    return readProposals(projectPath)
      .filter((row) => !status || row.status === status)
      .map((row) => ({ ...row, diff: row.status === 'pending' ? previewChanges(projectPath, row.changes).diff : (Array.isArray(row.diff) ? row.diff : []) }));
  }

  function pendingCount(projectPath) {
    return readProposals(projectPath).filter((row) => row.status === 'pending').length;
  }

  /** An agent's only write: a merge patch the user may accept. → { id, pending, ignored, diff } */
  function addProposal(projectPath, { changes, reason = '', runId = null, provider = null, model = null } = {}) {
    const { config, saved } = load(projectPath);
    if (!saved) throw new StyleGuideError('NOT_SAVED', 'This project has no saved style guide yet: there is nothing to propose a change to.', 409);
    if (!config.agents.allowProposals) throw new StyleGuideError('PROPOSALS_OFF', 'Proposals are turned off for this project (Style Guide → Agents).', 422);
    if (!isPlainObject(changes)) throw new StyleGuideError('BAD_CHANGES', 'changes must be a JSON merge patch (an object).');
    if (Buffer.byteLength(JSON.stringify(changes)) > MAX_PROPOSAL_BYTES) throw new StyleGuideError('TOO_LARGE', 'That proposal is too large.', 413);
    const ignored = PROPOSAL_FORBIDDEN_KEYS.filter((key) => key in changes);
    const patch = Object.fromEntries(Object.entries(changes).filter(([key]) => !PROPOSAL_FORBIDDEN_KEYS.includes(key)));
    const text = String(reason || '').trim();
    if (!text) throw new StyleGuideError('NO_REASON', 'reason is required: say why the guide should change.');
    const { diff } = previewChanges(projectPath, patch);
    if (!diff.length) throw new StyleGuideError('NO_CHANGE', ignored.length ? `Nothing to propose: ${ignored.join(', ')} cannot be changed by a proposal, and the rest equals the current guide.` : 'Nothing to propose: these values equal the current guide.');
    const rows = readProposals(projectPath);
    if (rows.filter((row) => row.status === 'pending').length >= PROPOSAL_LIMIT) throw new StyleGuideError('TOO_MANY_PROPOSALS', 'Review pending proposals before adding more.', 429);
    const id = `prop-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const clean = (value, max) => (value === null || value === undefined || value === '' ? null : String(value).slice(0, max));
    rows.unshift({ id, at: iso(), status: 'pending', decidedAt: null, runId: clean(runId, 120), provider: clean(provider, 40), model: clean(model, 120), reason: text.slice(0, 2000), changes: patch });
    mkdirSync(dir, { recursive: true });
    writeProposals(projectPath, rows);
    return { id, pending: rows.filter((row) => row.status === 'pending').length, ignored, diff };
  }

  function decide(projectPath, id, status) {
    const rows = readProposals(projectPath);
    const row = rows.find((entry) => entry.id === String(id));
    if (!row) throw new StyleGuideError('PROPOSAL_NOT_FOUND', 'No such proposal.', 404);
    if (row.status !== 'pending') throw new StyleGuideError('ALREADY_DECIDED', `That proposal was already ${row.status}.`, 409);
    return { rows, row, status };
  }

  /** Accept: the patch over the current guide, saved with source `proposal:<id>`. */
  function acceptProposal(projectPath, id) {
    if (!load(projectPath).config.agents.allowProposals) throw new StyleGuideError('PROPOSALS_OFF', 'Proposals are turned off for this project (Style Guide → Agents).', 422);
    const { rows, row } = decide(projectPath, id, 'accepted');
    const preview = previewChanges(projectPath, row.changes);
    const result = save(projectPath, preview.config, { source: `proposal:${row.id}`, label: row.reason.slice(0, 120) });
    Object.assign(row, { status: 'accepted', decidedAt: iso(), diff: preview.diff });
    writeProposals(projectPath, rows);
    return result;
  }

  function rejectProposal(projectPath, id) {
    const { rows, row } = decide(projectPath, id, 'rejected');
    Object.assign(row, { status: 'rejected', decidedAt: iso(), diff: previewChanges(projectPath, row.changes).diff });
    writeProposals(projectPath, rows);
    return { ok: true };
  }

  /** Everything GET /api/style-guide answers, for one project root. */
  function describe(projectPath, { loaded = null } = {}) {
    const root = resolve(projectPath);
    const { config, saved } = loaded || load(root);
    const summary = styleGuideSummaryForClass(config, null);
    return {
      config,
      designMd: renderDesignMd(config),
      hasDesignFile: existsSync(resolve(root, DESIGN_FILE)),
      assetsHash: styleGuideHash(root),
      revision: config.revision,
      saved,
      summary,
      tokensEstimate: estimateTokens(summary),
      written: written(root, config),
      proposalsPending: pendingCount(root),
    };
  }

  return {
    dir, assetsDir, dataDir: dataFolder,
    listProjects, resolveProject, paths, isSaved, load, save, history, historyConfig, restore,
    proposals, pendingCount, addProposal, acceptProposal, rejectProposal, previewChanges,
    writeArtifacts, written, syncPointers, describe, assertPath,
  };
}

/**
 * What a dispatched worker is told about its project's guide (assistant-task-prompt.js styleGuideBlock).
 * The project is the closest folder at or above `cwd` that has a saved guide. null when there is none,
 * when the guide keeps this class of run out (`agents.inject`), or when anything fails: a prompt is
 * never held up by this. A run without a class counts as a coding run.
 * → { projectPath, revision, summary, designPath, tokenFiles, imagery, proposals }
 */
export function loadStyleGuideForRun(cwd, taskClass = null, { dataHome = null, dataDir = null } = {}) {
  try {
    if (typeof cwd !== 'string' || !cwd.trim() || !isAbsolute(cwd.trim())) return null;
    const dir = styleGuidesDir({ dataDir, dataHome });
    if (!existsSync(dir)) return null;
    let root = null;
    let at = resolve(cwd.trim());
    for (let depth = 0; depth < 40; depth++) {
      if (existsSync(join(dir, `${styleGuideHash(at)}.json`))) { root = at; break; }
      const parent = dirname(at);
      if (parent === at) break;
      at = parent;
    }
    if (!root) return null;
    if (!containedPath(root, resolve(cwd.trim()))) return null;
    const raw = readJson(join(dir, `${styleGuideHash(root)}.json`), null);
    if (!isPlainObject(raw)) return null;
    const config = normalizeStyleGuide(raw, { projectPath: root });
    const key = taskClass ? String(taskClass) : 'code';
    if (config.agents.inject[key] !== true) return null;
    const designPath = resolve(root, DESIGN_FILE);
    return {
      projectPath: root,
      revision: config.revision,
      summary: styleGuideSummaryForClass(config, key),
      designPath: existsSync(designPath) ? designPath : null,
      tokenFiles: artifactFiles(root, config).filter((file) => file.format !== 'design-md' && existsSync(file.path)).map((file) => file.path),
      imagery: {
        style: config.imagery.style, mood: config.imagery.mood,
        promptPrefix: config.imagery.generation.promptPrefix, negativePrompt: config.imagery.generation.negativePrompt,
        aspectRatios: config.imagery.generation.aspectRatios,
      },
      proposals: config.agents.allowProposals,
    };
  } catch {
    return null;
  }
}
