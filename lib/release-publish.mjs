#!/usr/bin/env node
/** The only documented npm publication path: check, pack, scan, publish the same tgz. */
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { approved, credentials, evidenceDigest, hashFile } from './virustotal.mjs';
import { scanRelease } from './release-scan.mjs';

export function runNpm(args, { cwd, env = process.env, capture = false } = {}) {
  // npm_execpath works with npm.cmd on Windows without shell argument interpolation.
  const npm = env.npm_execpath;
  if (!npm && process.platform === 'win32') throw new Error('On Windows run npm run release:publish so npm_execpath is available');
  const command = npm ? process.execPath : 'npm';
  const result = spawnSync(command, npm ? [npm, ...args] : args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 1800000, maxBuffer: 8 * 1024 * 1024 });
  // Never replay npm's captured output (it may contain authentication diagnostics).
  if (result.error || result.status !== 0) throw new Error(`npm ${args[0]} failed; publication stopped`);
  return result.stdout;
}
export async function verifyPacked({ out, now = Date.now() }) {
  const report = JSON.parse(await readFile(join(out, 'npm-virustotal.json'), 'utf8'));
  if (report.schema !== 1 || !report.approved || report.items?.length !== 1 || !approved(report.items)) throw new Error('npm scan report is not approved');
  const item = report.items[0];
  if (item.kind !== 'file' || basename(item.name) !== item.name || !/^synabun-.*\.tgz$/.test(item.name)) throw new Error('Invalid npm scan subject');
  const { evidence_digest, review, ...evidence } = item;
  if (evidenceDigest(evidence) !== evidence_digest) throw new Error('npm report evidence digest mismatch');
  const at = Date.parse(item.analysis_date);
  if (!Number.isFinite(at) || at > now + 300000 || now - at > 7 * 86400000 || item.analysis_status !== 'completed' || item.supported_engines < 10) throw new Error('npm scan report stale, unfinished or inconclusive');
  if (item.status === 'detections') {
    const { applyReviews } = await import('./virustotal.mjs');
    if (!approved(applyReviews([{ ...item, review: null }], [{ ...review, name: item.name, sha256: item.sha256, evidence_digest }], now))) throw new Error('npm detection review required');
  }
  const tarball = join(out, item.name);
  if (await hashFile(tarball) !== item.sha256) throw new Error('npm tarball SHA-256 mismatch; repack and scan');
  return { tarball, sha256: item.sha256 };
}
export async function publishNpm({ cwd, out, reviewFile, provenance = false, packOnly = false, publishPacked = false, run = runNpm, scan = scanRelease }) {
  credentials(); // Before installs or registry mutations.
  const rel = relative(resolve(cwd), resolve(out));
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))) throw new Error('Release output must be outside the checkout to keep reports/tarballs out of npm packages');
  const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  if (pkg.name !== 'synabun' || pkg.scripts?.prepublishOnly?.includes('refuse-publish-from-dev') || !pkg.scripts?.prepublishOnly?.includes('release-publish.mjs guard')) throw new Error('Publish from a fresh prepared Clean clone with npm run release:publish; Dev publication is refused');
  await mkdir(out, { recursive: true });
  if (!publishPacked) {
    run(['run', 'deps:check'], { cwd });
    run(['ci', '--ignore-scripts'], { cwd });
    // Preserve Clean's entire install/build/file/pack chain. npm publish TGZ skips it.
    run(['run', 'prepublishOnly'], { cwd, env: { ...process.env, SYNABUN_RELEASE_PACK: '1' } });
    run(['run', 'prepack'], { cwd });
    for (const file of ['mcp-server/dist/index.js', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) await access(join(cwd, file));
    const staging = await mkdtemp(join(tmpdir(), 'synabun-npm-pack-'));
    try {
      const packed = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', staging], { cwd, capture: true }));
      const name = packed?.[0]?.filename;
      if (packed.length !== 1 || !name || basename(name) !== name || name !== `synabun-${pkg.version}.tgz`) throw new Error('npm pack returned an unexpected tarball');
      const tarball = join(out, name);
      await rm(tarball, { force: true });
      await copyFile(join(staging, name), tarball);
      await chmod(tarball, 0o444);
      await scan({ files: [tarball], out, prefix: 'npm-virustotal', reviewFile });
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const packed = await verifyPacked({ out });
  if (basename(packed.tarball) !== `synabun-${pkg.version}.tgz`) throw new Error('npm tarball version mismatch');
  if (!packOnly) {
    run(['publish', packed.tarball, '--ignore-scripts', '--access', 'public', '--tag', 'latest', ...(provenance ? ['--provenance'] : [])], { cwd });
    if (await hashFile(packed.tarball) !== packed.sha256) throw new Error('npm tarball changed during publication; inspect registry immediately');
  }
  return packed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'guard') {
      if (process.env.SYNABUN_RELEASE_PACK !== '1') throw new Error('Direct npm publish is disabled: use npm run release:publish -- --out /absolute/release/folder (packs, scans and publishes the exact tgz).');
    } else {
      const args = process.argv.slice(2); let out, reviewFile, provenance = false, packOnly = false, publishPacked = false;
      while (args.length) {
        const arg = args.shift();
        if (arg === '--out') out = args.shift();
        else if (arg === '--review') reviewFile = args.shift();
        else if (arg === '--provenance') provenance = true;
        else if (arg === '--pack-only') packOnly = true;
        else if (arg === '--publish-packed') publishPacked = true;
        else throw new Error(`Unknown option: ${arg}`);
      }
      if (!out || (packOnly && publishPacked)) throw new Error('Use --out DIR; --pack-only and --publish-packed are mutually exclusive');
      await publishNpm({ cwd: dirname(dirname(fileURLToPath(import.meta.url))), out: resolve(out), reviewFile, provenance, packOnly, publishPacked });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
