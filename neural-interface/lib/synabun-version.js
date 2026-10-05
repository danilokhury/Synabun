// Version parsing and ordering for SynaBun's update check and the CLI tool
// version checks. Pure: no I/O, so the rules below are unit-tested directly
// (tests/synabun-version.test.mjs).
//
// Two schemes exist. Every SynaBun release before 2.0.0 was date-style
// (2026.4.26, 2026.9.5), and a numeric-only suffix on one of those was a
// POST-release iteration: 2026.4.26-1 is the first patch published after
// 2026.4.26, shipped as `latest` on npm. From 2.0.0 on, versions are plain
// semver, where any suffix after `-` is a PRE-release (2.0.0-1 and
// 2.0.0-beta.1 both come before 2.0.0). The date-style rule applies only to a
// version whose major is a year.

/** First major of the date-style scheme. No semver-era release will reach it. */
export const SYNABUN_DATE_VERSION_MIN_MAJOR = 2000;

// The whole string, after the optional `v` / `v.` prefix: three numbers, an
// optional prerelease (dot-separated identifiers of letters, digits and
// hyphens, none empty), optional build metadata, and nothing else. Anchored at
// both ends, so "2.0.1junk", "2.0.1-" and "2.0.1-beta..1" are not versions.
const VERSION_RE = /^(\d{1,15})\.(\d{1,15})\.(\d{1,15})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

// Structured parse of one whole version string, or null:
//   "2.0.0"              -> { major:2, minor:0, patch:0, pre:null, iter:null, build:null }
//   "v2.0.0-beta.1"      -> { major:2, minor:0, patch:0, pre:"beta.1", iter:null, build:null }
//   "2.0.0-1"            -> { major:2, minor:0, patch:0, pre:"1", iter:null, build:null }  (a prerelease)
//   "2.0.1+build.7"      -> { major:2, minor:0, patch:1, pre:null, iter:null, build:"build.7" }
//   "v.2026.09.05"       -> { major:2026, minor:9, patch:5, pre:null, iter:null, build:null }
//   "2026.4.20-2"        -> { major:2026, minor:4, patch:20, pre:"2", iter:2, build:null }   (a post-release iteration)
//   "2026.4.26-beta.3"   -> { major:2026, minor:4, patch:26, pre:"beta.3", iter:null, build:null }
//
// `iter` is set only for a date-style version with a numeric-only suffix.
// A zero-padded part is read as its number (git tags such as v.2026.09.05).
// Callers hand over a version and nothing around it: CLI output such as
// "2.1.224 (Claude Code)" goes through the server's parseVersion() first.
export function parseSemver(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^v\.?/, '');
  const m = VERSION_RE.exec(s);
  if (!m) return null;
  const major = +m[1];
  const dateStyle = major >= SYNABUN_DATE_VERSION_MIN_MAJOR;
  const pre = m[4] || null;
  const iter = dateStyle && pre && /^\d+$/.test(pre) ? Number(pre) : null;
  return {
    major,
    minor: +m[2],
    patch: +m[3],
    pre,
    iter,
    build: m[5] || null,
  };
}

// Precedence, semver §11:
//   1.0.0-1 < 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0
// plus the date-style iteration (`iter`, see parseSemver), which is newer than
// its release:
//   2026.4.26-beta.3 < 2026.4.26 < 2026.4.26-1 < 2026.4.26-2
// Build metadata never takes part. Returns negative if a<b, positive if a>b,
// 0 if equal. Accepts strings or parsed objects.
export function compareSemver(a, b) {
  const pa = (a && typeof a === 'object' && 'major' in a) ? a : parseSemver(a);
  const pb = (b && typeof b === 'object' && 'major' in b) ? b : parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // Equal x.y.z. Order from oldest → newest:
  //   prerelease  <  no-suffix release  <  date-style numeric iteration
  if (!pa.pre && !pb.pre) return 0;
  // Date-style iterations are POST-release: always newer than no-suffix and
  // newer than prereleases.
  if (pa.iter != null && pb.iter == null) return  1;
  if (pa.iter == null && pb.iter != null) return -1;
  if (pa.iter != null && pb.iter != null) return pa.iter - pb.iter;
  // Neither side is an iteration. Semver §11.3: a release is greater than its
  // prereleases.
  if (!pa.pre &&  pb.pre) return  1;
  if ( pa.pre && !pb.pre) return -1;
  // Both are prereleases — compare identifiers per semver §11.4.
  const ia = pa.pre.split('.');
  const ib = pb.pre.split('.');
  const len = Math.max(ia.length, ib.length);
  for (let i = 0; i < len; i++) {
    if (i >= ia.length) return -1; // shorter set has lower precedence
    if (i >= ib.length) return  1;
    const xa = ia[i], xb = ib[i];
    const na = /^\d+$/.test(xa), nb = /^\d+$/.test(xb);
    if (na && nb) {
      const da = +xa, db = +xb;
      if (da !== db) return da - db;
    } else if (na && !nb) {
      return -1; // numeric < alphanumeric
    } else if (!na && nb) {
      return  1;
    } else {
      if (xa !== xb) return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

export function semverNewer(a, b) {
  // True iff b is strictly newer than a. Falls back to false if either side
  // can't be parsed — same defensive contract as the prior implementation.
  if (a == null || b == null) return false;
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return false;
  return compareSemver(pa, pb) < 0;
}

// ── SynaBun's own release scheme ──
//
// Plain semver ordering puts every date-style release ABOVE 2.x (2026 > 2).
// Without the rule below a 2.x install would be offered the last date-style
// release as an "update", and the click-to-update flow would act on it.
//
// The rule: a date-style version is always older than a semver-era one. Two
// versions of the same scheme compare by compareSemver.
//
// Only SynaBun's own versions go through these functions. The CLI tools
// SynaBun watches (Claude Code, Codex, Gemini, OpenCode) keep plain
// compareSemver / semverNewer.

/** True for a date-style SynaBun version (`2026.9.5`, `v.2026.07.34`, `2026.4.26-1`). */
export function isDateStyleSynabunVersion(version) {
  const parsed = (version && typeof version === 'object' && 'major' in version) ? version : parseSemver(version);
  return !!parsed && parsed.major >= SYNABUN_DATE_VERSION_MIN_MAJOR;
}

/**
 * The canonical spelling of a version, which is how npm names a published one:
 * no `v` / `v.` prefix, no zero padding, no build metadata
 * (`v.2026.09.05` -> `2026.9.5`, `v2.0.1+build.7` -> `2.0.1`). Null when the
 * input is not a version.
 * @returns {string | null}
 */
export function formatSynabunVersion(version) {
  const parsed = (version && typeof version === 'object' && 'major' in version) ? version : parseSemver(version);
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.pre ? `-${parsed.pre}` : ''}`;
}

/**
 * The channel a SynaBun version belongs to. Semver era: any suffix is a
 * prerelease (`2.0.0-1`, `2.0.0-beta.1`). Date-style: a numeric iteration
 * (`2026.4.26-1`) was a stable release, only an alpha / beta / rc suffix was a
 * prerelease. A string that is not a version counts as stable.
 * @returns {'stable' | 'prerelease'}
 */
export function synabunReleaseChannel(version) {
  const parsed = (version && typeof version === 'object' && 'major' in version) ? version : parseSemver(version);
  return parsed && parsed.pre && parsed.iter == null ? 'prerelease' : 'stable';
}

/**
 * compareSemver for SynaBun's own versions: a date-style version sorts below
 * every semver-era version. Negative if a<b, positive if a>b, 0 if equal.
 */
export function compareSynabunVersion(a, b) {
  const pa = (a && typeof a === 'object' && 'major' in a) ? a : parseSemver(a);
  const pb = (b && typeof b === 'object' && 'major' in b) ? b : parseSemver(b);
  if (pa && pb) {
    const da = isDateStyleSynabunVersion(pa);
    const db = isDateStyleSynabunVersion(pb);
    if (da !== db) return da ? -1 : 1;
  }
  return compareSemver(pa, pb);
}

/** True iff SynaBun version b is strictly newer than a; false when either does not parse. */
export function synabunVersionNewer(a, b) {
  if (a == null || b == null) return false;
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return false;
  return compareSynabunVersion(pa, pb) < 0;
}
