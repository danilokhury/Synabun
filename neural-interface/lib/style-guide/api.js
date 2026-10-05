// ═══════════════════════════════════════════
// SynaBun — Style Guide REST API (/api/style-guide/*)
// ═══════════════════════════════════════════
//
// Thin routes over lib/style-guide/store.js, registered on the main app with
// absolute paths (server.js). The feature-permission middleware there covers the
// prefix: a guest without `styleGuide` cannot make a non-GET request.
//
// `projectPath` may be any path inside a registered project: it resolves to that
// project's root, and a path in no registered project is a 403. Routes that list
// (`/presets`, `/history`, `/proposals`, `/fonts`, `/projects`) answer a bare array;
// the others answer an object with `ok`. An error is `{ ok: false, error, code }`.
//
//   GET    /api/style-guide                    the guide + rendered DESIGN.md + summary + written files
//   PUT    /api/style-guide                    save (normalize → revision + 1 → history → artifacts)
//   GET    /api/style-guide/summary            the compact text agents get (taskClass?)
//   GET    /api/style-guide/preview-md         DESIGN.md as text, not written
//   GET    /api/style-guide/export             one format as text (as=json wraps it)
//   POST   /api/style-guide/export             write the artifacts now
//   POST   /api/style-guide/import             design-md | dtcg | css | tailwind-json | codebase | community
//   GET    /api/style-guide/presets            the eight presets
//   POST   /api/style-guide/presets/apply
//   GET    /api/style-guide/history · POST /api/style-guide/history/restore
//   GET    /api/style-guide/proposals · POST /api/style-guide/proposals
//   POST   /api/style-guide/proposals/:id/accept · /reject
//   POST   /api/style-guide/contrast           WCAG ratio + APCA for two colors (or aliases, with projectPath)
//   POST   /api/style-guide/scale              the 11-step OKLCH scale and the harmonies of a base color
//   POST   /api/style-guide/dark-semantic      a dark theme's roles derived from a light theme's
//   GET    /api/style-guide/defaults           the default guide (the editor's "reset" source)
//   GET    /api/style-guide/fonts              the bundled Google Fonts list (q?)
//   POST   /api/style-guide/pointers           the opt-in block in <project>/CLAUDE.md and AGENTS.md
//   GET    /api/style-guide/projects           registered projects with their guide's status
//   POST   /api/style-guide/logo · DELETE /api/style-guide/logo/:variantId · GET /api/style-guide/assets/:hash/:file
//
// The old editor still calls GET / PUT / logo with a v1-shaped config: it asks with
// `compat=v1` and gets the v1 keys mirrored into `config` (schema.js withV1Mirror).

import express from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { contrastReport, deriveDarkSemantic, harmony, hexToOklch, scaleFromBase } from './color.js';
import { IMPORT_KINDS, ImportError, runImport } from './import.js';
import { applyPreset, getPreset, listPresets } from './presets.js';
import { LOGO_BACKGROUNDS, LOGO_KINDS, STYLE_GUIDE_OUT_DIR, defaultStyleGuide, hasLegacyKeys, isPlainObject, resolveColor, withV1Mirror } from './schema.js';
import { EXPORT_FORMATS, StyleGuideError, renderFormat } from './store.js';
import { estimateTokens, styleGuideSummaryForClass } from './summary.js';
import { resolvedTokens } from './tokens.js';
import { safeLogoFile } from './security.js';

const LOGO_TYPES = Object.freeze({ 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'image/webp': '.webp' });
const SAVE_SOURCE_RE = /^(ui|import:[a-z-]{1,24}|preset:[a-z0-9-]{1,40})$/;
const inputLabel = (value) => typeof value === 'string' ? value.slice(0, 120) : JSON.stringify(value)?.slice(0, 120) || '';

let fontsCache = null;
/** The bundled list of popular Google Fonts: [{ family, category, weights }]. */
export function loadFonts() {
  if (!fontsCache) fontsCache = JSON.parse(readFileSync(new URL('./fonts.json', import.meta.url), 'utf8'));
  return fontsCache;
}
function googleFontSet() {
  return new Set(loadFonts().map((font) => font.family.toLowerCase()));
}

function fail(res, error) {
  const known = error instanceof StyleGuideError || error instanceof ImportError;
  const status = known && Number.isInteger(error.status) ? error.status : error instanceof RangeError ? 400 : 500;
  return res.status(status).json({ ok: false, error: error?.message || String(error), code: known ? error.code : status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR' });
}

export function registerStyleGuideRoutes(app, { store, fetchImpl = null, log = () => {} } = {}) {
  if (!app || !store) throw new Error('registerStyleGuideRoutes requires an app and a store');

  /** The registered project a request names, or null after answering 400 / 403. */
  const projectOf = (res, projectPath) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) { res.status(400).json({ ok: false, error: 'Missing projectPath', code: 'NO_PROJECT_PATH' }); return null; }
    const project = store.resolveProject(projectPath);
    if (!project) { res.status(403).json({ ok: false, error: 'Project not registered', code: 'PROJECT_NOT_REGISTERED' }); return null; }
    return project;
  };
  const wantsV1 = (req, config = null) => String(req.query?.compat ?? req.body?.compat ?? '') === 'v1' || (config ? hasLegacyKeys(config) : false);
  /** The GET shape for a project, after a save when `extra` carries its result. */
  const describe = (project, { v1 = false, extra = {} } = {}) => {
    const state = store.describe(project.path);
    return { ok: true, projectPath: project.path, ...state, config: v1 ? withV1Mirror(state.config) : state.config, ...extra };
  };
  const saved = (project, result, { v1 = false, extra = {} } = {}) => describe(project, {
    v1,
    extra: { designPath: resolve(project.path, 'DESIGN.md'), changed: result.changed, writtenNow: result.written.map(({ format, path, changed, backup }) => ({ format, path, changed, ...(backup ? { backup } : {}) })), pointers: result.pointers, ...extra },
  });
  const route = (handler) => async (req, res) => {
    try { await handler(req, res); } catch (error) {
      if (!(error instanceof StyleGuideError || error instanceof ImportError)) log('style-guide', error?.stack || String(error));
      if (!res.headersSent) fail(res, error);
    }
  };

  // ── read ──
  app.get('/api/style-guide', route((req, res) => {
    const project = projectOf(res, req.query.projectPath);
    if (project) res.json(describe(project, { v1: wantsV1(req) }));
  }));

  app.get('/api/style-guide/summary', route((req, res) => {
    const project = projectOf(res, req.query.projectPath);
    if (!project) return;
    const { config, saved: isSaved } = store.load(project.path);
    const taskClass = typeof req.query.taskClass === 'string' && req.query.taskClass ? req.query.taskClass : null;
    const summary = styleGuideSummaryForClass(config, taskClass);
    res.json({ ok: true, summary, tokensEstimate: estimateTokens(summary), saved: isSaved, revision: config.revision, projectPath: project.path });
  }));

  app.get('/api/style-guide/preview-md', route((req, res) => {
    const project = projectOf(res, req.query.projectPath);
    if (project) res.type('text/markdown').send(renderFormat(store.load(project.path).config, 'design-md').text);
  }));

  app.get('/api/style-guide/export', route((req, res) => {
    const project = projectOf(res, req.query.projectPath);
    if (!project) return;
    const format = String(req.query.format || '');
    const theme = ['light', 'dark'].includes(req.query.theme) ? req.query.theme : null;
    const { config } = store.load(project.path);
    let out = null;
    if (format === 'summary') out = { text: styleGuideSummaryForClass(config, typeof req.query.taskClass === 'string' ? req.query.taskClass : null), contentType: 'text/plain; charset=utf-8', filename: 'style-guide-summary.txt' };
    else if (format === 'json') out = { text: `${JSON.stringify(resolvedTokens(config, theme), null, 2)}\n`, contentType: 'application/json; charset=utf-8', filename: 'tokens.resolved.json' };
    else out = renderFormat(config, format, { theme });
    if (!out) return res.status(400).json({ ok: false, error: `format must be one of: ${[...EXPORT_FORMATS, 'summary', 'json'].join(', ')}`, code: 'BAD_FORMAT' });
    if (req.query.as === 'json') return res.json({ ok: true, format, contentType: out.contentType, filename: out.filename, text: out.text, revision: config.revision });
    res.set('Content-Type', out.contentType).send(out.text);
  }));

  app.get('/api/style-guide/presets', route((req, res) => { res.json(listPresets()); }));

  app.get('/api/style-guide/fonts', route((req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const fonts = loadFonts();
    res.json(q ? fonts.filter((font) => font.family.toLowerCase().includes(q) || font.category === q) : fonts);
  }));

  app.get('/api/style-guide/projects', route((req, res) => {
    res.json(store.listProjects().map((project) => {
      const { config, saved: isSaved } = store.load(project.path);
      return {
        path: project.path, label: project.label, saved: isSaved, revision: isSaved ? config.revision : 0, updatedAt: isSaved ? config.updatedAt : null,
        hasDesignFile: existsSync(resolve(project.path, 'DESIGN.md')), proposalsPending: store.pendingCount(project.path),
      };
    }));
  }));

  app.get('/api/style-guide/history', route((req, res) => {
    const project = projectOf(res, req.query.projectPath);
    if (project) res.json(store.history(project.path));
  }));

  app.get('/api/style-guide/proposals', route((req, res) => {
    const project = projectOf(res, req.query.projectPath);
    if (!project) return;
    const status = ['pending', 'accepted', 'rejected'].includes(req.query.status) ? req.query.status : null;
    res.json(store.proposals(project.path, { status }));
  }));

  // ── write ──
  app.put('/api/style-guide', route((req, res) => {
    const { projectPath, config, source, label } = req.body || {};
    if (!projectPath || !isPlainObject(config)) return res.status(400).json({ ok: false, error: 'Missing projectPath or config', code: 'BAD_REQUEST' });
    const project = projectOf(res, projectPath);
    if (!project) return;
    const result = store.save(project.path, config, { source: SAVE_SOURCE_RE.test(String(source || '')) ? source : 'ui', label: typeof label === 'string' ? label : '' });
    res.json(saved(project, result, { v1: wantsV1(req, config) }));
  }));

  app.post('/api/style-guide/export', route((req, res) => {
    const { projectPath, formats } = req.body || {};
    const project = projectOf(res, projectPath);
    if (!project) return;
    const { config, saved: isSaved } = store.load(project.path);
    if (!isSaved) throw new StyleGuideError('NOT_SAVED', 'This project has no saved style guide yet: save it first.', 409);
    if (formats !== undefined && (!Array.isArray(formats) || formats.some((format) => ![...EXPORT_FORMATS, 'tailwind'].includes(format)))) {
      throw new StyleGuideError('BAD_FORMAT', `formats must be a list of: ${[...EXPORT_FORMATS, 'tailwind'].join(', ')}`);
    }
    const written = store.writeArtifacts(project.path, config, { formats: formats?.length ? formats : null });
    res.json({ ok: true, written: written.map(({ format, path, changed, backup }) => ({ format, path, changed, ...(backup ? { backup } : {}) })) });
  }));

  app.post('/api/style-guide/import', route(async (req, res) => {
    const { projectPath, kind, text, slug, mode = 'preview', merge = 'merge' } = req.body || {};
    const project = projectOf(res, projectPath);
    if (!project) return;
    if (!IMPORT_KINDS.includes(kind)) throw new ImportError('BAD_KIND', `kind must be one of: ${IMPORT_KINDS.join(', ')}`);
    if (!['preview', 'apply'].includes(mode)) throw new ImportError('BAD_MODE', 'mode must be "preview" or "apply"');
    const base = store.load(project.path).config;
    const result = await runImport({
      kind, text: typeof text === 'string' ? text : '', slug: typeof slug === 'string' ? slug : '', base, merge,
      deps: { projectRoot: project.path, googleFonts: googleFontSet(), ...(fetchImpl ? { fetchImpl } : {}) },
    });
    const extra = { diff: result.diff, warnings: result.warnings, ...(result.files ? { files: result.files } : {}), ...(result.source ? { source: result.source } : {}) };
    if (mode === 'preview') return res.json({ ok: true, mode, config: result.config, ...extra });
    const outcome = store.save(project.path, result.config, { source: `import:${kind}` });
    res.json(saved(project, outcome, { extra: { mode, ...extra } }));
  }));

  app.post('/api/style-guide/presets/apply', route((req, res) => {
    const { projectPath, presetId, merge = 'replace' } = req.body || {};
    const project = projectOf(res, projectPath);
    if (!project) return;
    if (!getPreset(presetId)) throw new StyleGuideError('PRESET_NOT_FOUND', `No preset named "${String(presetId || '')}".`, 404);
    const applied = applyPreset(store.load(project.path).config, presetId, { merge });
    const result = store.save(project.path, applied.config, { source: `preset:${presetId}` });
    res.json(saved(project, result, { extra: { diff: applied.diff } }));
  }));

  app.post('/api/style-guide/history/restore', route((req, res) => {
    const { projectPath, revision } = req.body || {};
    const project = projectOf(res, projectPath);
    if (!project) return;
    if (!Number.isInteger(Number(revision))) throw new StyleGuideError('BAD_REVISION', 'revision must be a number from the history.');
    res.json(saved(project, store.restore(project.path, Number(revision))));
  }));

  app.post('/api/style-guide/proposals', route((req, res) => {
    const { projectPath, changes, reason, runId, provider, model } = req.body || {};
    const project = projectOf(res, projectPath);
    if (!project) return;
    // A caller that names no run is known by the terminal id its MCP client sends (a dispatched worker's is its run id).
    const caller = typeof req.headers['x-synabun-terminal'] === 'string' ? req.headers['x-synabun-terminal'] : null;
    const result = store.addProposal(project.path, { changes, reason, runId: runId || caller, provider, model });
    res.json({ ok: true, id: result.id, pending: result.pending, ignored: result.ignored, diff: result.diff });
  }));

  app.post('/api/style-guide/proposals/:id/accept', route((req, res) => {
    const project = projectOf(res, req.body?.projectPath);
    if (!project) return;
    res.json(saved(project, store.acceptProposal(project.path, req.params.id)));
  }));

  app.post('/api/style-guide/proposals/:id/reject', route((req, res) => {
    const project = projectOf(res, req.body?.projectPath);
    if (!project) return;
    store.rejectProposal(project.path, req.params.id);
    res.json({ ok: true, proposalsPending: store.pendingCount(project.path) });
  }));

  app.post('/api/style-guide/contrast', route((req, res) => {
    const { fg, bg, size = 'normal', projectPath, theme } = req.body || {};
    // Aliases ({semantic.text}) need a project; plain colors do not.
    let config = null;
    if (projectPath) {
      const project = projectOf(res, projectPath);
      if (!project) return;
      config = store.load(project.path).config;
    }
    const color = (value) => (config ? resolveColor(config, value, { theme: ['light', 'dark'].includes(theme) ? theme : null }) : resolveColor({}, value));
    const front = color(fg);
    const back = color(bg);
    if (!front || !back) throw new StyleGuideError('BAD_COLOR', `Not a color: ${!front ? `fg "${inputLabel(fg)}"` : `bg "${inputLabel(bg)}"`}. Use a hex, rgb(), hsl(), oklch()${config ? ' or an alias like {semantic.text}' : ', or pass projectPath to use an alias'}.`);
    res.json({ ok: true, ...contrastReport(front, back, { size: size === 'large' ? 'large' : 'normal' }), fg: front, bg: back, size: size === 'large' ? 'large' : 'normal' });
  }));

  // The editor's color tools, so it does not carry a second copy of the math.
  app.post('/api/style-guide/scale', route((req, res) => {
    const { base, hueShift = 0, chroma = 1 } = req.body || {};
    const hex = resolveColor({}, base);
    if (!hex) throw new StyleGuideError('BAD_COLOR', `Not a color: base "${inputLabel(base)}". Use a hex, rgb(), hsl() or oklch().`);
    const lch = hexToOklch(hex);
    res.json({
      ok: true, base: hex.slice(0, 7), steps: scaleFromBase(hex, { hueShift: Number(hueShift) || 0, chroma: Number.isFinite(Number(chroma)) ? Number(chroma) : 1 }),
      harmony: harmony(hex), oklch: { l: Math.round(lch.l * 10000) / 10000, c: Math.round(lch.c * 10000) / 10000, h: Math.round(lch.h * 100) / 100 },
    });
  }));

  app.post('/api/style-guide/dark-semantic', route((req, res) => {
    const { light, neutral = 'neutral' } = req.body || {};
    if (!isPlainObject(light) || Object.values(light).some((value) => typeof value !== 'string')) throw new StyleGuideError('BAD_REQUEST', 'light must be the light theme\'s roles: { role: color or alias }');
    res.json({ ok: true, dark: deriveDarkSemantic(light, { neutral: typeof neutral === 'string' && neutral ? neutral : 'neutral' }) });
  }));

  app.get('/api/style-guide/defaults', route((req, res) => {
    const project = projectOf(res, req.query.projectPath);
    if (project) res.json({ ok: true, config: defaultStyleGuide(project.path) });
  }));

  app.post('/api/style-guide/pointers', route((req, res) => {
    const { projectPath, enabled } = req.body || {};
    const project = projectOf(res, projectPath);
    if (!project) return;
    if (typeof enabled !== 'boolean') throw new StyleGuideError('BAD_REQUEST', 'enabled must be true or false');
    const { config, saved: isSaved } = store.load(project.path);
    if (!isSaved && enabled) throw new StyleGuideError('NOT_SAVED', 'This project has no saved style guide yet: save it before pointing agents at it.', 409);
    if (!isSaved) return res.json({ ok: true, enabled: false, files: store.syncPointers(project.path, config, false) });
    const result = store.save(project.path, { ...config, exports: { ...config.exports, projectPointers: enabled } }, { source: 'ui' });
    res.json({ ok: true, enabled, files: result.pointers, revision: result.config.revision });
  }));

  // ── logo files ──
  const logoBody = express.raw({ type: Object.keys(LOGO_TYPES), limit: '4mb' });
  app.post('/api/style-guide/logo', (req, res, next) => logoBody(req, res, (error) => {
    if (error) return fail(res, new StyleGuideError(error.status === 413 ? 'TOO_LARGE' : 'BAD_REQUEST', error.message, error.status || 400));
    next();
  }), route((req, res) => {
    const { projectPath, variantId, name, bg, kind } = req.query;
    const project = projectOf(res, projectPath);
    if (!project) return;
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ ok: false, error: 'No image data received', code: 'NO_IMAGE' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!LOGO_TYPES[mime]) throw new StyleGuideError('BAD_IMAGE_TYPE', 'Use PNG, SVG, JPEG or WebP.', 415);
    if (req.body.length > 4 * 1024 * 1024) throw new StyleGuideError('TOO_LARGE', 'That logo is larger than 4 MB.', 413);
    const dir = store.paths(project.path).assets;
    const ext = LOGO_TYPES[mime];
    const id = String(variantId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || `logo-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    const filename = id + ext;
    const { config } = store.load(project.path);
    const index = config.logo.variants.findIndex((entry) => entry.id === id);
    const previous = index >= 0 ? config.logo.variants[index] : null;
    if (!previous && config.logo.variants.length >= 24) throw new StyleGuideError('TOO_MANY_LOGOS', 'A guide supports at most 24 logo variants.');
    store.assertPath(store.assetsDir, resolve(dir, filename));
    store.assertPath(project.path, resolve(project.path, STYLE_GUIDE_OUT_DIR, filename));
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, filename), req.body);
    const variant = {
      id,
      name: (typeof name === 'string' && name.trim()) || previous?.name || 'Variant',
      kind: LOGO_KINDS.includes(kind) ? kind : previous?.kind || 'primary',
      bg: LOGO_BACKGROUNDS.includes(bg) ? bg : previous?.bg || 'primary',
      file: filename,
    };
    if (previous) {
      // A new extension leaves the old file behind: remove it here and in the project.
      if (safeLogoFile(previous.file) && previous.file !== filename) {
        store.assertPath(store.assetsDir, resolve(dir, previous.file));
        store.assertPath(project.path, resolve(project.path, STYLE_GUIDE_OUT_DIR, previous.file));
        try { unlinkSync(resolve(dir, previous.file)); } catch { /* already gone */ }
        try { unlinkSync(resolve(project.path, STYLE_GUIDE_OUT_DIR, previous.file)); } catch { /* already gone */ }
      }
      config.logo.variants[index] = variant;
    } else config.logo.variants.push(variant);
    const result = store.save(project.path, config, { source: 'ui' });
    const v1 = wantsV1(req);
    res.json({ ok: true, variant: result.config.logo.variants.find((entry) => entry.id === id) || variant, config: v1 ? withV1Mirror(result.config) : result.config, revision: result.config.revision, assetsHash: store.paths(project.path).hash });
  }));

  app.delete('/api/style-guide/logo/:variantId', route((req, res) => {
    const project = projectOf(res, req.query.projectPath);
    if (!project) return;
    const { config } = store.load(project.path);
    const index = config.logo.variants.findIndex((entry) => entry.id === req.params.variantId);
    if (index === -1) return res.status(404).json({ ok: false, error: 'Variant not found', code: 'VARIANT_NOT_FOUND' });
    const [removed] = config.logo.variants.splice(index, 1);
    if (safeLogoFile(removed.file)) {
      store.assertPath(store.assetsDir, resolve(store.paths(project.path).assets, removed.file));
      store.assertPath(project.path, resolve(project.path, STYLE_GUIDE_OUT_DIR, removed.file));
      try { unlinkSync(resolve(store.paths(project.path).assets, removed.file)); } catch { /* already gone */ }
      try { unlinkSync(resolve(project.path, STYLE_GUIDE_OUT_DIR, removed.file)); } catch { /* already gone */ }
    }
    const result = store.save(project.path, config, { source: 'ui' });
    res.json({ ok: true, config: wantsV1(req) ? withV1Mirror(result.config) : result.config, revision: result.config.revision });
  }));

  app.get('/api/style-guide/assets/:hash/:file', route((req, res) => {
    const { hash, file } = req.params;
    if (!/^[a-f0-9]{16}$/.test(hash)) return res.status(400).json({ ok: false, error: 'Bad hash' });
    if (/[\\/]/.test(file) || file.includes('..')) return res.status(400).json({ ok: false, error: 'Bad filename' });
    if (!safeLogoFile(file)) throw new StyleGuideError('BAD_IMAGE_TYPE', 'Not an allowed logo filename.');
    const project = store.listProjects().find((entry) => store.paths(entry.path).hash === hash);
    if (!project) throw new StyleGuideError('NOT_FOUND', 'Not found', 404);
    const full = resolve(store.assetsDir, hash, file);
    if (!full.startsWith(store.assetsDir + sep)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    if (!existsSync(full)) return res.status(404).json({ ok: false, error: 'Not found' });
    store.assertPath(store.assetsDir, full);
    // An uploaded SVG is served as a file to look at, never as a page that can run script on this origin.
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(full);
  }));
}
