#!/usr/bin/env node
/**
 * Check the cloudflared pins (neural-interface/lib/cloudflared/pins.json) against Cloudflare's release, for real:
 * the application's own code downloads each pinned file, compares it with its pinned SHA-256, takes the binary
 * out and compares that with its own. Run it after the pins were moved to another release.
 *
 *   node scripts/verify-cloudflared-pins.mjs          this system: through the manager, as a first tunnel start
 *                                                     would do it, into a scratch data home; then the binary is
 *                                                     asked for its version
 *   node scripts/verify-cloudflared-pins.mjs --all    every pinned platform (nothing of another system is run)
 *   --keep                                            leave the scratch folder (it is printed) instead of removing it
 *
 * Nothing is written outside a new folder under the system's temporary one, and no tunnel is started.
 * Exit code 0: everything asked for matched. 1: something did not.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile, installCloudflared } from '../neural-interface/lib/cloudflared/install.js';
import { createCloudflaredManager, probeCloudflaredVersion } from '../neural-interface/lib/cloudflared/manager.js';
import { cloudflaredPinFor, readCloudflaredPins } from '../neural-interface/lib/cloudflared/pins.js';

const all = process.argv.includes('--all');
const keep = process.argv.includes('--keep');
const pins = readCloudflaredPins();
const scratch = mkdtempSync(join(tmpdir(), 'synabun-cloudflared-verify-'));
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
let failed = 0;

console.log(`cloudflared ${pins.version} (${pins.release})`);
console.log(`scratch: ${scratch}\n`);

try {
  const mine = cloudflaredPinFor(pins);
  if (!mine) {
    console.log(`No file is pinned for this system (${process.platform}-${process.arch}).`);
  } else {
    // As the server does it: nothing is there, a start asks for the copy to run.
    const manager = createCloudflaredManager({ dataHome: join(scratch, 'data-home'), packaged: null, findSystem: () => null, log: (line) => console.log(`  ${line}`) });
    const before = await manager.inspect();
    console.log(`this system (${mine.key}): ${before.state}; a start downloads ${megabytes(before.download.size)}`);
    const started = Date.now();
    const copy = await manager.ensure();
    const file = await hashFile(copy.path);
    const version = await probeCloudflaredVersion(copy.path);
    const ok = file.sha256 === mine.binary.sha256 && file.size === mine.binary.size && version === pins.version && copy.source === 'downloaded';
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok' : 'FAILED'}: ${copy.source} in ${((Date.now() - started) / 1000).toFixed(1)} s, ${megabytes(file.size)}, mode ${(statSync(copy.path).mode & 0o777).toString(8)}`);
    console.log(`  binary sha256 ${file.sha256}${file.sha256 === mine.binary.sha256 ? ' = the pin' : ` IS NOT the pin ${mine.binary.sha256}`}`);
    console.log(`  cloudflared --version answers: ${version ?? 'nothing'}${version === pins.version ? ' = the pinned version' : ' IS NOT the pinned version'}`);
    const again = await manager.ensure();
    console.log(`  asked again: ${again.source}, ${again.path === copy.path ? 'the same file, nothing downloaded' : 'ANOTHER FILE'}\n`);
  }

  if (all) {
    for (const pin of Object.values(pins.platforms)) {
      const started = Date.now();
      try {
        // Both checks happen inside: the release file against `sha256`, the binary against `binary.sha256`.
        const placed = await installCloudflared({ pin, root: join(scratch, 'all', pin.key), platform: pin.platform });
        const file = await hashFile(placed.path);
        console.log(`ok      ${pin.key.padEnd(13)} ${pin.file.padEnd(31)} file ${megabytes(pin.size).padStart(8)} sha256 ${pin.sha256.slice(0, 16)}…  binary ${megabytes(file.size).padStart(8)} sha256 ${file.sha256.slice(0, 16)}…  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
      } catch (error) {
        failed++;
        console.log(`FAILED  ${pin.key.padEnd(13)} ${pin.file}: ${error.code || 'error'}: ${error.message}`);
      }
    }
  }
} finally {
  if (keep) console.log(`\nkept: ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}

console.log(failed ? `\n${failed} did not match.` : '\nEverything asked for matched its pins.');
process.exitCode = failed ? 1 : 0;
