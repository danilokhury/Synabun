// Reproducible, checked downloads from immutable revisions. No remote publication or upload.
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { buildBundle } from './bundle.js';
import { buildExport, readHeadOf } from './export.js';
import { effectiveInstallName } from './scan-context.js';
import { folderDigest } from './library.js';
import { PORTABLE_FIELDS } from '../../public/shared/skills/ss-profiles.js';
import { frontmatter } from './frontmatter.js';
import { fromEditing, toEditing } from '../../public/shared/skills/ss-doc.js';

export const PACKAGE_FORMATS = ['bundle', 'skill', 'portable', 'claude-upload', 'claude-plugin', 'claude-api', 'github'];
const bad = (code, message, status = 422, extra = {}) => { throw Object.assign(new Error(message), { code, status, ...extra }); };
export function createSkillPackages({ service }) {
  function prepare(revisionId, { format = 'bundle', profile = null, excludeEvals = false } = {}) {
    if (!PACKAGE_FORMATS.includes(format)) bad('invalid_format', `format is ${PACKAGE_FORMATS.join(', ')}.`, 400);
    if (profile && !service.profileIds().includes(profile)) bad('invalid_profile', 'Unknown export profile.', 400);
    const source = service.library.readRevisionFiles(revisionId);
    const skill = service.library.getSkill(source.revision.skillId);
    const sourceScan = service.scanFolder(source, { name: effectiveInstallName(skill, source.files), digest: source.revision.contentDigest, skill });
    if (sourceScan.status === 'incomplete' || sourceScan.coverage?.complete === false) bad('scan_incomplete', 'The source scan is incomplete.');
    if (sourceScan.gate === 'blocked') bad('scan_blocked', 'The source scan blocks export.');
    let folder = { files: source.files, dirs: source.dirs };
    const losses = [], excluded = [], transforms = [];
    const targetProfile = format === 'claude-upload' || format === 'claude-api' ? 'claude-upload' : format === 'portable' ? 'portable-six-field' : format === 'claude-plugin' ? 'claude-code' : profile;
    if (targetProfile === 'claude-upload' || format === 'portable') {
      const { text, parsed } = readHeadOf(folder.files);
      if (parsed.errors?.length || !parsed.data || typeof parsed.data !== 'object') bad('invalid_frontmatter', 'Fix the frontmatter before exporting.');
      const changes = {};
      for (const key of Object.keys(parsed.data)) if (!PORTABLE_FIELDS.includes(key)) { changes[key] = undefined; losses.push({ field: key, reason: 'This target does not support this runtime behavior.' }); }
      // Lossless patch on the export only. Explicit confirmation of losses is required to download it.
      const result = frontmatter.patch(toEditing(text).text, changes);
      if (!result.ok) bad('export_transform_failed', 'The portable metadata could not be produced.');
      folder = { ...folder, files: folder.files.map((f) => f.path === 'SKILL.md' ? { ...f, bytes: Buffer.from(fromEditing(text, result.text)) } : f) };
    }
    if (excludeEvals) {
      excluded.push(...folder.files.filter((f) => f.path.startsWith('evals/')).map((f) => f.path));
      folder = { files: folder.files.filter((f) => !f.path.startsWith('evals/')), dirs: folder.dirs.filter((d) => d !== 'evals' && !d.startsWith('evals/')) };
    }
    if (targetProfile) { const out = buildExport(folder, targetProfile); folder = out; transforms.push(...out.transforms); if (out.diagnostics.some((d) => d.severity === 'error')) bad('export_incompatible', 'The export cannot preserve invocation policy for this profile.'); }
    const name = effectiveInstallName(skill, folder.files);
    const strictName = ['portable-six-field', 'claude-upload', 'opencode-native'].includes(targetProfile) || format === 'claude-plugin';
    if (strictName && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)) bad('invalid_name', 'This target needs a lowercase skill name of at most 64 characters.');
    const lint = service.lintFolder(folder, { profiles: targetProfile ? [targetProfile] : null, folderName: name });
    const profileLint = targetProfile ? lint.profiles[targetProfile] : null;
    // Snapshot formats preserve valid library names; compatibility diagnostics remain in the preview.
    const studioErrors = lint.studio.diagnostics.filter((d) => d.severity === 'error' && (targetProfile || d.ruleId !== 'name-length'));
    const diagnostics = [...studioErrors, ...(profileLint?.diagnostics || []).filter((d) => d.severity === 'error'), ...lint.resources.diagnostics.filter((d) => d.severity === 'error')];
    const digest = folderDigest(folder);
    const scan = service.scanFolder(folder, { name, digest, skill });
    if (diagnostics.length) bad('export_blocked', 'Fix the package validation errors before exporting.', 422, { reason: 'lint', diagnostics });
    if (scan.gate === 'blocked' || scan.coverage?.complete === false) bad(scan.status === 'incomplete' ? 'scan_incomplete' : 'scan_blocked', 'Fix the blocked scan before exporting.');
    const license = readHeadOf(folder.files).parsed.data?.license || null;
    if (format === 'claude-plugin') {
      // Claude plugin layout: components at root; the manifest describes the plugin, never runs commands.
      folder = { files: [
        { path: '.claude-plugin/plugin.json', bytes: Buffer.from(`${JSON.stringify({ name, version: '1.0.0', description: String(readHeadOf(folder.files).parsed.data.description || '').slice(0, 1024) }, null, 2)}\n`) },
        ...folder.files.map((f) => ({ ...f, path: `skills/${name}/${f.path}` })),
      ], dirs: ['.claude-plugin', 'skills', `skills/${name}`, ...folder.dirs.map((d) => `skills/${name}/${d}`)] };
    }
    const artifactDigest = folderDigest(folder);
    return { folder, manifest: { schemaVersion: 1, revisionId, sourceDigest: source.revision.contentDigest, artifactDigest, format, profile: targetProfile,
      name, namingPolicy: strictName ? 'target' : 'preserved', files: folder.files.map((f) => ({ path: f.path, bytes: f.bytes.length, executable: !!f.executable, digest: `sha256:${createHash('sha256').update(f.bytes).digest('hex')}` })), losses, excluded, transforms, license, source: source.revision.source, sourceScan, lint, scan,
      requiresAcknowledgement: losses.length > 0 || sourceScan.gate === 'review' || scan.gate === 'review' || ['github', 'claude-plugin'].includes(format) && !license,
      note: format === 'claude-api' ? 'Offline full snapshot only. Uploading would create a shared remote resource; no API call is made.' : format === 'github' ? 'Reproducible distribution archive only; no push or release is made.' : null } };
  }
  function preview(revisionId, options) { return prepare(revisionId, options).manifest; }
  function download(revisionId, options = {}) {
    const { folder, manifest } = prepare(revisionId, options);
    if (manifest.requiresAcknowledgement && options.acknowledgedDigest !== manifest.artifactDigest) bad('export_review_required', 'Review the losses, license and findings, then acknowledge this exact export digest.', 409);
    const { name, format } = manifest;
    let bytes, filename, contentType;
    if (format === 'bundle') {
      bytes = Buffer.from(buildBundle({ type: 'skill', name, files: folder.files, dirs: folder.dirs }).json); filename = `${name}.skill.json`; contentType = 'application/json';
    } else {
      const zip = new AdmZip({ noSort: true });
      const prefix = format === 'claude-api' ? '' : `${name}/`;
      for (const d of [...folder.dirs].sort()) zip.addFile(`${prefix}${d}/`, Buffer.alloc(0), '', 0o755);
      for (const f of [...folder.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) zip.addFile(`${prefix}${f.path}`, f.bytes, '', f.executable ? 0o755 : 0o644);
      for (const entry of zip.getEntries()) { entry.header.time = new Date(1980, 0, 1, 0, 0, 0); entry.header.made = 0x0314; }
      bytes = zip.toBuffer(); filename = format === 'skill' ? `${name}${options.profile === 'claude-upload' ? '-claude.zip' : '.skill'}` : `${name}-${format}.zip`; contentType = 'application/zip';
      const back = new AdmZip(bytes).getEntries().filter((e) => !e.isDirectory);
      if (back.length !== folder.files.length || back.some((e) => !folder.files.some((f) => `${prefix}${f.path}` === e.entryName && e.getData().equals(f.bytes)))) bad('package_corrupt', 'The archive did not read back as exported.', 500);
    }
    return { bytes, filename, contentType, manifest: { ...manifest, archiveDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` } };
  }
  return { preview, download };
}
