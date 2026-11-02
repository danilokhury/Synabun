/** SAC inventory and release gate. No Windows execution; verification is delegated to osslsigncode. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticodeInfo, isSignable, signPolicy, verifyCommand, verifySigned, windowsFiles } from './win-sign.mjs';

export function sacFile(path, source = '') {
  if (/\.(exe|dll|node|sys|ps1|psm1|bat|cmd|vbs|msi)$/i.test(path)) return true;
  // Node.js modules are data to Node, not WSH scripts. Include actual WScript/ActiveX entry points only.
  return /\.js$/i.test(path) && !/^\s*(?:import|export)\s/m.test(source) && /\b(?:WScript\.|new\s+ActiveXObject\s*\()/.test(source);
}
export function signatureVerdict(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error) throw new Error(`osslsigncode unavailable: ${result.error.message}`);
  if (result.status === 0 && /^Signature verification: ok\s*$/m.test(output)) return 'valid';
  if (/No signature found/i.test(output)) return 'unsigned';
  // Batch is not an Authenticode format. Do not misreport it as a corrupt PE.
  if (/Unrecognized file type|Unsupported file type|Failed to open/i.test(output)) return 'unsupported';
  return 'unverified';
}
export function classifySacFile(path, signature, { scope = 'install' } = {}) {
  const policy = signPolicy(path);
  const batch = /\.(bat|cmd)$/i.test(path);
  const vendor = scope === 'git' || /(^|\/)resources\/(runtime|cloudflared|git|git-archive)\//i.test(path.replace(/\\/g, '/')) || batch;
  return {
    class: signature === 'unverified' ? 'unresolved' : signature === 'valid' ? 'a' : vendor || !policy.sign ? 'c' : 'b',
    reason: signature === 'valid' ? 'verified existing signature; preserve bytes' : vendor ? 'immutable vendor bundle or batch shim' : policy.reason,
  };
}
export function inventoryWindows(roots, { verifier = 'osslsigncode', run = spawnSync, caFile = null } = {}) {
  const entries = [];
  for (const { root, scope = 'install' } of roots) for (const path of windowsFiles(root)) {
    const source = /\.js$/i.test(path) ? readFileSync(path, 'utf8') : '';
    if (!sacFile(path, source)) continue;
    const rel = relative(root, path).replace(/\\/g, '/');
    const args = ['verify', '-in', path, '-ignore-crl'];
    if (caFile) args.push('-CAfile', caFile);
    const result = run(verifier, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const signature = /\.(bat|cmd)$/i.test(path) ? 'unsupported' : signatureVerdict(result);
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    entries.push({ scope, path: rel, ...classifySacFile(rel, signature, { scope }), signature,
      subject: /Signer #0:\s*\n\s*Subject:\s*([^\n]+)/.exec(output)?.[1]?.trim() || null,
      ...(signature === 'unverified' ? { verification: output.split('\n').filter(line => /Error:|error:|Signature verification:/.test(line)).slice(-5).join('\n') } : {}),
    });
  }
  return { counts: Object.fromEntries(['a', 'b', 'c', 'unresolved'].map(group => [group, entries.filter(e => e.class === group).length])), entries };
}

/** Cryptographic gate over every distributed candidate, including DLLs, .node and scripts, not a certificate-table check. */
export function auditWindowsSigning(plan, roots, { verify = verifySigned, readPe = authenticodeInfo, run = spawnSync, strictOwnership = true } = {}) {
  if (!plan.enabled || plan.dryRun) return [];
  const problems = [];
  for (const root of roots) for (const path of windowsFiles(root)) {
    const policy = signPolicy(path);
    if (!policy.sign) {
      if (strictOwnership && policy.kind === 'other' && isSignable(path)) problems.push(`${relative(root, path)}: unclassified signable file; declare its ownership before publishing`);
      continue;
    }
    try {
      // A verified vendor native is accepted without requiring our publisher or an RFC3161 timestamp.
      if (['native', 'helper'].includes(policy.kind) && readPe(path)?.signed) {
        const command = verifyCommand(plan, path);
        const result = run(command.file, command.args, { encoding: 'utf8', timeout: 30000 });
        if (signatureVerdict(result) === 'valid') continue;
      }
      verify({ ...plan, verifyMode: 'full' }, path);
    } catch (error) { problems.push(`${relative(root, path)}: ${error.message}`); }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const roots = [];
  let out = null;
  for (let n = 2; n < process.argv.length; n += 2) {
    const key = process.argv[n], value = process.argv[n + 1];
    if (key === '--out') out = value;
    else if (['--install', '--installer', '--uninstaller', '--git', '--asar'].includes(key) && value) roots.push({ root: value, scope: key.slice(2) });
    else throw new Error('usage: windows-sac.mjs --install <tree> [--installer <unpacked NSIS>] [--uninstaller <unpacked uninstaller>] [--git <unpacked Git>] [--asar <unpacked app.asar>] [--out <json>]');
  }
  if (!roots.length) throw new Error('at least one inventory tree required');
  const report = inventoryWindows(roots);
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  else console.log(JSON.stringify(report, null, 2));
}
