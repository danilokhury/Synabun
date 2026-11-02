/**
 * electron-builder's custom Windows sign hook (win.signtoolOptions.sign, set by builderSigningOptions in
 * win-sign.mjs only when a provider is configured). electron-builder calls it for every selected signExts file it visits:
 *
 *   the `dir` build   SynaBun.exe and synabun-cli.exe (signApp), and every .exe of the payload as it is copied
 *                     into resources/ (its extra-files transformer)
 *   the installer     the uninstaller it embeds, then the installer
 *
 * signPolicy decides: our executables, DLLs, native modules and scripts are signed and verified; the payload's programs are left exactly as their
 * vendors signed them (cloudflared and Git for Windows are checked byte for byte against their pins afterwards).
 * Works on macOS (jsign + osslsigncode); a failure throws, which stops electron-builder and the build.
 */

import { createRedactor, signFile, windowsSigningPlan } from './win-sign.mjs';

let notedPayload = false;

export async function sign(configuration) {
  const env = process.env;
  const redact = createRedactor(env);
  const log = (line) => console.log(`  • windows signing  ${redact(line)}`);
  const plan = windowsSigningPlan(env);
  if (!plan.enabled) return;
  if (plan.problems.length) throw new Error(redact(`Windows signing is not configured correctly: ${plan.problems.join('; ')}`));
  // One signature per file: a second call for another digest (electron-builder's default is sha1, then sha256) is skipped.
  if (configuration?.isNest) return;
  const outcome = signFile(plan, configuration.path, { env, log });
  if (!outcome.signed && !outcome.dryRun && !notedPayload && outcome.kind === 'payload') {
    notedPayload = true;
    log('immutable vendor bundles (Node.js, cloudflared, Git for Windows) keep their vendors\' signatures: not re-signed');
  }
}

export default sign;
