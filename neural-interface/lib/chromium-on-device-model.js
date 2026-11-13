/**
 * Chromium's Optimization Guide downloads models into the profile it runs in: the on-device foundational
 * model (Gemini Nano: `OptGuideOnDeviceModel/<version>/weights.bin`, about 4 GB) and the smaller prediction
 * and hints models. SynaBun's automation browsers use none of them, and one such weights.bin, written into a
 * SynaBun browser profile, once ended up in git. Every Chromium SynaBun launches itself gets these features
 * turned off on its command line.
 *
 * Chromium reads one --disable-features: when the switch is given more than once, the last value replaces the
 * others. So the list is merged into the one flag the arguments already carry (SynaBun's own, or one in the
 * user's extra launch arguments), never added as a second flag. Under Playwright, SynaBun's arguments come after
 * Playwright's defaults, so the merged flag is the one Chromium keeps.
 *
 * No imports: page-free and unit-tested (tests/chromium-on-device-model.test.mjs).
 */

/** The Optimization Guide features that fetch or run downloaded models. */
export const ON_DEVICE_MODEL_FEATURES = Object.freeze([
  'OptimizationGuideModelDownloading',
  'OptimizationGuideOnDeviceModel',
  'OptimizationHintsFetching',
  'OptimizationTargetPrediction',
  'OptimizationHints',
]);

// Chromium takes a switch after "--" or "-" (POSIX and Windows alike).
const DISABLE_FEATURES = /^--?disable-features(?:=([\s\S]*))?$/;

/** The feature names of one --disable-features value: comma-separated, surrounding quotes and blanks dropped. */
function featureNames(value) {
  let text = String(value ?? '').trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  if (quoted) text = quoted[2];
  return text.split(',').map((name) => name.trim()).filter(Boolean);
}

/**
 * `args` with exactly one --disable-features, at the place of the first one it had (or at the end), naming
 * every feature any of its --disable-features named, in order, then `features`; each name once. The other
 * arguments keep their order. `args` itself is not changed.
 */
export function mergeDisabledFeatures(args, features = []) {
  const list = Array.isArray(args) ? args : [];
  const names = [];
  const add = (name) => { if (!names.includes(name)) names.push(name); };
  const out = [];
  let at = -1;
  for (const arg of list) {
    const match = typeof arg === 'string' ? DISABLE_FEATURES.exec(arg) : null;
    if (!match) { out.push(arg); continue; }
    featureNames(match[1]).forEach(add);
    if (at === -1) { at = out.length; out.push(null); }
  }
  for (const name of features) {
    const clean = String(name ?? '').trim();
    if (clean) add(clean);
  }
  if (!names.length) return at === -1 ? out : out.filter((_, i) => i !== at);
  const flag = `--disable-features=${names.join(',')}`;
  if (at === -1) out.push(flag);
  else out[at] = flag;
  return out;
}

/** `args` with the Optimization Guide's model features merged into its one --disable-features. */
export function withOnDeviceModelBlocked(args) {
  return mergeDisabledFeatures(args, ON_DEVICE_MODEL_FEATURES);
}
