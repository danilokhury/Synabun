#!/usr/bin/env node
/** Shared CI identity, OIDC-only publication and exact-byte handoff contract. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashFile } from './virustotal.mjs';
import { publishNpm, runNpm, verifyPacked } from './release-publish.mjs';

export const REPOSITORY = 'danilokhury/Synabun';
export const WORKFLOW = '.github/workflows/publish.yml';
export const PUBLISH_NPM = '11.21.0'; // Verified OIDC-compatible CLI; builder stays 10.9.3.
export const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export const exactCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const requestId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const runTitle = ({ version, commit, request }) => `npm ${version} ${commit} ${request}`;
export const artifactName = (id, attempt) => `npm-publication-${id}-${attempt}`;
const numberId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function validateIdentity({ env, event, pkg, head, main }) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || pkg.name !== 'synabun' || !stableVersion(pkg.version)
      || pkg.repository?.url !== `git+https://github.com/${REPOSITORY}.git`) throw new Error('Unexpected npm package/repository identity');
  if (!exactCommit(head) || head !== main || !numberId(env.GITHUB_RUN_ID) || !numberId(env.GITHUB_RUN_ATTEMPT)) throw new Error('Release commit must be the current main tip; require exact run identity');
  let request = null;
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_SHA !== head || event.inputs?.commit !== head
        || event.inputs?.version !== pkg.version || !requestId(event.inputs?.request_id)) throw new Error('Invalid dispatch ref/commit/version/request identity');
    request = event.inputs.request_id;
  } else if (env.GITHUB_EVENT_NAME === 'release') {
    const tag = event.release?.tag_name;
    if (event.action !== 'published' || event.release?.draft !== false || event.release?.prerelease !== false
        || !new RegExp(`^v?\\.?${pkg.version.replaceAll('.', '\\.')}$`).test(tag || '')
        || env.GITHUB_REF !== `refs/tags/${tag}` || env.GITHUB_SHA !== head) throw new Error('Invalid stable release event/tag');
  } else throw new Error('Only main workflow_dispatch or stable release.published can publish');
  if (env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW}@${env.GITHUB_REF}`) throw new Error('Unexpected publisher workflow identity');
  return { repository: REPOSITORY, workflow: WORKFLOW, event: env.GITHUB_EVENT_NAME,
    version: pkg.version, commit: head, request, run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) };
}

export function oidcEnvironment(env, { cli, userconfig, globalconfig, cache }) {
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted' || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('GitHub-hosted OIDC runner and id-token: write are required');
  // Modern npm tries OIDC first. Remove legacy credentials anyway: no silent token fallback.
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(NPM|NPM_TOKEN|NODE_AUTH_TOKEN)$/i.test(key) && !/^npm_config_/i.test(key)));
  return { ...clean, npm_execpath: cli, NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig,
    NPM_CONFIG_CACHE: cache, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
}

export function verifyToolchain(node, npm) {
  if (node.replace(/^v/, '') !== '22.19.0' || npm.trim() !== PUBLISH_NPM) throw new Error(`Publication requires Node 22.19.0 and isolated npm ${PUBLISH_NPM}; builder npm is unchanged`);
}

export async function registryVersion(version, { fetchImpl = fetch, allowMissing = false } = {}) {
  if (!stableVersion(version)) throw new Error('Invalid registry version');
  const response = await fetchImpl(`https://registry.npmjs.org/synabun/${version}`, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw new Error(`npm registry lookup failed (${response.status})`);
  const pkg = await response.json();
  if (pkg?.name !== 'synabun' || pkg.version !== version || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.dist?.integrity || '')) throw new Error('npm registry identity/integrity is unverified');
  return pkg.dist.integrity;
}

export async function sha512(path) {
  const hash = createHash('sha512');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return `sha512-${hash.digest('base64')}`;
}
export const bundleFiles = version => ['npm-virustotal.json', 'npm-virustotal.md', `synabun-${version}.tgz`];

export async function publicationReceipt({ out, identity, registry = registryVersion }) {
  const packed = await verifyPacked({ out });
  if (packed.tarball !== join(out, `synabun-${identity.version}.tgz`)) throw new Error('npm receipt version mismatch');
  const integrity = await sha512(packed.tarball);
  if (await registry(identity.version) !== integrity) throw new Error('npm registry SHA512 differs from scanned tarball');
  const files = {};
  for (const name of bundleFiles(identity.version)) files[name] = { sha256: await hashFile(join(out, name)), size: (await lstat(join(out, name))).size };
  const receipt = { schema: 1, ...identity, integrity, files };
  await writeFile(join(out, 'npm-publication.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

export async function verifyPublication({ out, expected, registry = registryVersion, strictFiles = true }) {
  const receipt = JSON.parse(await readFile(join(out, 'npm-publication.json'), 'utf8'));
  if (receipt.schema !== 1 || receipt.repository !== REPOSITORY || receipt.workflow !== WORKFLOW
      || !stableVersion(receipt.version) || !exactCommit(receipt.commit) || !numberId(receipt.run_id)
      || !numberId(receipt.run_attempt) || !['workflow_dispatch', 'release'].includes(receipt.event)
      || (receipt.event === 'workflow_dispatch' && !requestId(receipt.request))) throw new Error('Unknown or invalid npm publication receipt');
  for (const [key, value] of Object.entries(expected)) if (receipt[key] !== value) throw new Error(`npm publication identity mismatch: ${key}`);
  const names = bundleFiles(expected.version);
  if (JSON.stringify(Object.keys(receipt.files || {}).sort()) !== JSON.stringify([...names].sort())
      || (strictFiles && JSON.stringify((await readdir(out)).sort()) !== JSON.stringify([...names, 'npm-publication.json'].sort()))) throw new Error('Unexpected npm artifact file set');
  for (const name of [...names, 'npm-publication.json']) {
    const info = await lstat(join(out, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('npm artifact must contain regular files only');
    if (name !== 'npm-publication.json' && (info.size !== receipt.files[name].size || await hashFile(join(out, name)) !== receipt.files[name].sha256)) throw new Error(`npm artifact integrity mismatch: ${name}`);
  }
  const packed = await verifyPacked({ out });
  if (packed.tarball !== join(out, `synabun-${expected.version}.tgz`) || await sha512(packed.tarball) !== receipt.integrity
      || await registry(expected.version) !== receipt.integrity) throw new Error('npm publication version/registry integrity mismatch');
  // Read only the packed manifest; never extract arbitrary paths into the checkout.
  const tar = spawnSync('tar', ['-xOf', packed.tarball, 'package/package.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000 });
  if (tar.status !== 0) throw new Error('Cannot inspect npm tarball manifest');
  const pkg = JSON.parse(tar.stdout);
  if (pkg.name !== 'synabun' || pkg.version !== expected.version || pkg.repository?.url !== `git+https://github.com/${REPOSITORY}.git`) throw new Error('Packed npm manifest identity mismatch');
  return receipt;
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) throw new Error('Cannot verify current main commit');
  return result.stdout.trim();
}
async function ciIdentity() {
  git('fetch', '--no-tags', '--depth=1', 'origin', 'main');
  return validateIdentity({ env: process.env, event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
    pkg: JSON.parse(await readFile('package.json', 'utf8')), head: git('rev-parse', 'HEAD'), main: git('rev-parse', 'FETCH_HEAD') });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const stage = process.argv[2], identity = await ciIdentity(), out = join(process.env.RUNNER_TEMP, 'npm-release');
    if (stage === 'identity') {
      const published = await registryVersion(identity.version, { allowMissing: true });
      if (published && identity.event === 'workflow_dispatch') throw new Error('Version already published: recover the original successful run artifacts; never repack an existing version');
      await appendFile(process.env.GITHUB_OUTPUT, `published=${!!published}\n`);
    } else if (stage === 'publish') {
      try { await lstat('.npmrc'); throw new Error('Project .npmrc is forbidden in the publishing checkout'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const base = process.env.RUNNER_TEMP;
      const userconfig = join(base, 'npm-oidc-userconfig'), globalconfig = join(base, 'npm-oidc-globalconfig');
      await writeFile(userconfig, ''); await writeFile(globalconfig, '');
      const env = oidcEnvironment(process.env, { cli: join(base, 'npm-oidc-cli/node_modules/npm/bin/npm-cli.js'), userconfig, globalconfig, cache: join(base, 'npm-oidc-cache') });
      const run = (args, options) => runNpm(args, { ...options, env });
      verifyToolchain(process.version, run(['--version'], { capture: true }));
      await publishNpm({ cwd: process.cwd(), out, run, publishPacked: true, provenance: true });
      await publicationReceipt({ out, identity });
    } else throw new Error('Use identity or publish');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
