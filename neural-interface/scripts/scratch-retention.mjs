import { getDataHome } from '../../lib/paths.js';
import { scratchKeptReport, scratchPass, scratchSummary } from '../lib/scratch-retention.js';

// Preview only: one JSON line per folder (remove / prune / keep, with its reason, entries and bytes), then the totals.
if (process.argv.length !== 3 || process.argv[2] !== '--dry-run') {
  console.error('Usage: node neural-interface/scripts/scratch-retention.mjs --dry-run');
  process.exitCode = 2;
} else {
  try {
    const result = await scratchPass({ dataHome: getDataHome(), dryRun: true, candidate: row => console.log(JSON.stringify(row)) });
    console.log(scratchSummary(result));
    const kept = scratchKeptReport(result);
    if (kept.length) console.log(`Kept by reason:\n${kept.join('\n')}`);
    console.log(`Scratch now ${(result.totalBytes / 1e6).toFixed(2)} MB, would free ${(result.wouldFreeBytes / 1e6).toFixed(2)} MB.`);
    if (result.passReason) process.exitCode = 1;
  } catch (error) {
    console.error(`[scratch-retention] Preview unavailable (${error.message})`);
    process.exitCode = 1;
  }
}
