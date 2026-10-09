// What SynaBun's own update check found, and what click-to-update does about
// it. Pure: the server fetches the npm registry document and the GitHub
// releases and detects how SynaBun was installed; this module decides
// (tests/synabun-update-plan.test.mjs). Version ordering comes from
// synabun-version.js and is not repeated here.
//
// One rule ties the two halves together: the version the check selected and
// showed is the version the plan installs. The plan pins it (`synabun@2.0.1`)
// and never names a dist-tag, so a tag that moves between the check and the
// click, a `latest` that points at an older or date-style release, or a beta
// channel cannot make npm install anything else. A version npm does not have is
// never auto-installed: that plan is a manual one and says why.

import {
  parseSemver, compareSynabunVersion, synabunVersionNewer, synabunReleaseChannel, formatSynabunVersion,
  isDateStyleSynabunVersion,
} from './synabun-version.js';

/** npm dist-tags read as the prerelease channel, in order of preference. */
export const SYNABUN_NPM_PRERELEASE_TAGS = Object.freeze(['beta', 'next', 'rc', 'alpha']);

const stripTagPrefix = tag => String(tag).replace(/^v\.?/, '');

/**
 * True when the npm registry document lists `version` as a published version
 * (its `versions` map, or a dist-tag pointing at it).
 */
export function npmHasSynabunVersion(npmDocument, version) {
  const wanted = formatSynabunVersion(version);
  if (!wanted || !npmDocument || typeof npmDocument !== 'object') return false;
  const versions = npmDocument.versions;
  if (versions && typeof versions === 'object' && Object.hasOwn(versions, wanted)) return true;
  const tags = npmDocument['dist-tags'];
  if (tags && typeof tags === 'object') {
    for (const value of Object.values(tags)) if (formatSynabunVersion(value) === wanted) return true;
  }
  return false;
}

/** The dist-tag that points at `version`, `latest` first, or null. */
function npmTagFor(npmDocument, version) {
  const wanted = formatSynabunVersion(version);
  const tags = npmDocument?.['dist-tags'];
  if (!wanted || !tags || typeof tags !== 'object') return null;
  for (const name of ['latest', ...SYNABUN_NPM_PRERELEASE_TAGS]) {
    if (tags[name] && formatSynabunVersion(tags[name]) === wanted) return name;
  }
  return null;
}

/**
 * The stable release npm offers. That is `latest`, unless `latest` cannot be
 * one: it is a prerelease, it is not a version, or it is a date-style release
 * while a semver-era stable release is published (a tag left behind by the
 * scheme change). Then it is the newest stable release in `versions`, which
 * no dist-tag names.
 * @returns {{version: string|null, tag: 'latest'|null}}
 */
function npmStableOffer(npmDocument) {
  const doc = npmDocument && typeof npmDocument === 'object' ? npmDocument : {};
  const latest = doc['dist-tags']?.latest || null;
  let newestPublished = null;
  const versions = doc.versions && typeof doc.versions === 'object' ? Object.keys(doc.versions) : [];
  for (const candidate of versions) {
    if (!parseSemver(candidate) || synabunReleaseChannel(candidate) !== 'stable') continue;
    if (!newestPublished || compareSynabunVersion(candidate, newestPublished) > 0) newestPublished = candidate;
  }
  const leftBehind = isDateStyleSynabunVersion(latest) && !!newestPublished && !isDateStyleSynabunVersion(newestPublished);
  if (parseSemver(latest) && synabunReleaseChannel(latest) === 'stable' && !leftBehind) return { version: latest, tag: 'latest' };
  return { version: newestPublished, tag: null };
}

/**
 * Reads the two responses of the update check.
 *
 * @param {object} input
 * @param {string|null} input.current         installed version (package.json)
 * @param {object|null} [input.npmDocument]   the full registry document, or null when the fetch failed
 * @param {object|object[]|null} [input.githubReleases]  `/releases/latest` (one object) or `/releases` (a list), or null
 * @returns the fields of the update cache: channel, what each source offers,
 *   whether either is newer, and `latest`, the one version the UI shows and the
 *   plan installs (`targetOnNpm` says whether npm can install it).
 *   `npmLatestStable` / `npmLatestBeta` are the dist-tags as published;
 *   `npmLatest` is the version npm offers this install's channel.
 */
export function selectSynabunUpdate({ current = null, npmDocument = null, githubReleases = null } = {}) {
  // Any suffix on a semver-era version is a prerelease (`2.0.0-1`,
  // `2.0.0-beta.1`). Only the old date-style iterations (`2026.4.26-1`) were
  // stable releases with a suffix.
  const installedChannel = synabunReleaseChannel(current);

  const tags = (npmDocument && typeof npmDocument === 'object' && npmDocument['dist-tags']) || {};
  const npmLatestStable = tags.latest || null;
  let npmLatestBeta = null;
  let npmLatestBetaTag = null;
  for (const tagName of SYNABUN_NPM_PRERELEASE_TAGS) {
    if (tags[tagName]) {
      npmLatestBeta = tags[tagName];
      npmLatestBetaTag = tagName;
      break;
    }
  }

  let gitLatestRaw = null;
  if (Array.isArray(githubReleases)) {
    // /releases: the newest non-draft entry whose tag is a version. Only a
    // prerelease install asks for the list, so prereleases are included.
    let best = null;
    for (const release of githubReleases) {
      if (release?.draft) continue;
      const tag = release?.tag_name || release?.name || '';
      const parsed = parseSemver(tag);
      if (!parsed) continue;
      if (!best || compareSynabunVersion(parsed, best.parsed) > 0) best = { tag, parsed };
    }
    gitLatestRaw = best?.tag || null;
  } else if (githubReleases && typeof githubReleases === 'object') {
    // /releases/latest: a single object.
    gitLatestRaw = githubReleases.tag_name || githubReleases.name || null;
  }
  const gitLatest = gitLatestRaw ? stripTagPrefix(gitLatestRaw) : null;
  // The channel rule holds for both sources: a stable install is only offered
  // a stable release. `/releases/latest` skips prereleases, so this only
  // matters for a release that was published without the prerelease flag.
  const gitOffer = gitLatest && !(installedChannel === 'stable' && synabunReleaseChannel(gitLatest) === 'prerelease')
    ? gitLatest
    : null;

  // Channel-aware npm target:
  //  - prerelease install: whichever of (stable, beta) is newest. Either is
  //    newer than the installed version; a stable release that supersedes the
  //    beta is offered on purpose.
  //  - stable install: only stable. A beta would look like a downgrade, so
  //    the stable offer is never a prerelease, whatever `latest` points at.
  const stableOffer = npmStableOffer(npmDocument);
  const betaOffer = parseSemver(npmLatestBeta) ? npmLatestBeta : null;
  let npmLatest = null;
  let npmLatestTag = null;
  if (installedChannel === 'prerelease') {
    if (stableOffer.version && betaOffer) {
      if (compareSynabunVersion(betaOffer, stableOffer.version) > 0) {
        npmLatest = betaOffer;
        npmLatestTag = npmLatestBetaTag;
      } else {
        npmLatest = stableOffer.version;
        npmLatestTag = stableOffer.tag;
      }
    } else {
      npmLatest = stableOffer.version || betaOffer;
      npmLatestTag = stableOffer.version ? stableOffer.tag : (betaOffer ? npmLatestBetaTag : null);
    }
  } else {
    npmLatest = stableOffer.version;
    npmLatestTag = stableOffer.tag;
  }

  // synabunVersionNewer, not semverNewer: a date-style release (2026.9.5) is
  // never an update for a semver-era install (2.0.0), whatever a registry tag
  // or a GitHub release still points at.
  const npmUpdateAvailable = !!(npmLatest && synabunVersionNewer(current, npmLatest));
  const gitUpdateAvailable = !!(gitOffer && synabunVersionNewer(current, gitOffer));
  const updateAvailable = npmUpdateAvailable || gitUpdateAvailable;

  // The newer of the two sources, in npm's spelling. This is the one version
  // the UI shows as the target and the install plan pins.
  let newest = null;
  if (npmLatest && gitOffer) {
    newest = compareSynabunVersion(npmLatest, gitOffer) >= 0 ? npmLatest : gitOffer;
  } else {
    newest = npmLatest || gitOffer;
  }
  const latest = formatSynabunVersion(newest) || newest;

  let source = null;
  if (npmUpdateAvailable && gitUpdateAvailable) source = 'both';
  else if (npmUpdateAvailable)                   source = 'npm';
  else if (gitUpdateAvailable)                   source = 'github';

  return {
    installedChannel,
    npmLatestStable,
    npmLatestBeta,
    npmLatestTag,
    npmLatest,
    gitLatest,
    gitLatestRaw,
    latest,
    npmUpdateAvailable,
    gitUpdateAvailable,
    updateAvailable,
    source,
    npmChecked: !!npmDocument && typeof npmDocument === 'object',
    targetOnNpm: updateAvailable ? npmHasSynabunVersion(npmDocument, latest) : false,
    targetNpmTag: updateAvailable ? npmTagFor(npmDocument, latest) : null,
  };
}

/**
 * The click names the version its page showed. The server's plan can be newer
 * than that page (another tab, or the hourly refresh, re-ran the check), and
 * running it would install a version the user never saw. Returns the refusal
 * to send (HTTP 409), or null when the click may proceed. A page that sends no
 * target (an older one) is let through.
 * @returns {{code: 'target-changed', error: string} | null}
 */
export function refuseStaleUpdateClick(installPlan, shownTarget) {
  const shown = typeof shownTarget === 'string' ? formatSynabunVersion(shownTarget) : null;
  if (!shown || !installPlan || shown === installPlan.target) return null;
  return {
    code: 'target-changed',
    error: `The update on screen (v${shown}) is out of date: SynaBun now offers v${installPlan.target}. Nothing was installed. Review the new version and run the update again.`,
  };
}

/**
 * The server-owned action for click-to-update, or null when there is no update.
 *
 * - An npm install whose target npm has: `canAutoUpdate: true` with
 *   `installSpec` pinned to that exact version.
 * - An npm install whose target is only a GitHub release: a manual plan
 *   (`reason: 'not-on-npm'`, or `'npm-unreachable'` when the registry could not
 *   be asked). Nothing else is installed in its place.
 * - Any other kind of install (a checkout): a manual plan
 *   (`reason: 'not-npm-install'`), as before.
 *
 * @param {object} input the fields of selectSynabunUpdate() plus:
 * @param {string|null} input.current
 * @param {{kind: string, remote?: string|null}|null} input.installSource  how SynaBun was installed
 * @param {string} input.repoUrl  the GitHub repository URL
 */
export function buildSynabunInstallPlan({
  current = null,
  installedChannel = 'stable',
  latest = null,
  updateAvailable = false,
  npmChecked = true,
  targetOnNpm = false,
  targetNpmTag = null,
  gitLatestRaw = null,
  installSource = null,
  repoUrl,
} = {}) {
  if (!updateAvailable) return null;

  const kind = installSource?.kind || 'local';
  const version = formatSynabunVersion(latest);
  const target = version || latest;

  if (kind === 'packaged-app') {
    // A packaged application carries its own runtime and dependencies: npm and
    // git never write inside it. A newer build is installed over it instead.
    const releasesUrl = `${repoUrl}/releases`;
    return {
      source: 'github',
      installSource: kind,
      canAutoUpdate: false,
      reason: 'packaged-app',
      current,
      target,
      channel: installedChannel,
      displayCommand: releasesUrl,
      openUrl: releasesUrl,
      manualCommand: null,
      manualHint: `This copy of SynaBun is a packaged application, so v${target} is installed by replacing it with the newer build, not from inside the app. Nothing was installed. Get the build for your system from the releases page and install it over this one; your data stays where it is.`,
    };
  }

  if (kind !== 'npm-global') {
    const clonedHint = kind === 'github-clone'
      ? 'This SynaBun install is a GitHub checkout. Open the repository to pull or reinstall from the correct source.'
      : 'This SynaBun install was not detected as npm. Open the repository for the correct update path.';
    return {
      source: 'github',
      installSource: kind,
      canAutoUpdate: false,
      reason: 'not-npm-install',
      current,
      target,
      channel: installedChannel,
      displayCommand: repoUrl,
      openUrl: repoUrl,
      manualCommand: kind === 'github-clone' ? 'git pull --ff-only' : null,
      manualHint: clonedHint,
      remote: installSource?.remote,
    };
  }

  if (!version || !targetOnNpm) {
    // Newer on GitHub only. Installing whatever npm's `latest` points at would
    // reinstall the current version, or an older one, under the new version's
    // name, so this is a manual update until npm has the release.
    const releaseUrl = gitLatestRaw && version && formatSynabunVersion(gitLatestRaw) === version
      ? `${repoUrl}/releases/tag/${encodeURIComponent(gitLatestRaw)}`
      : `${repoUrl}/releases`;
    return {
      source: 'github',
      installSource: kind,
      canAutoUpdate: false,
      reason: npmChecked ? 'not-on-npm' : 'npm-unreachable',
      current,
      target,
      channel: installedChannel,
      displayCommand: releaseUrl,
      openUrl: releaseUrl,
      manualCommand: null,
      manualHint: npmChecked
        ? `SynaBun v${target} is published on GitHub but is not on npm yet, so it cannot be installed automatically. Nothing was installed. Check for updates again later, or open the release on GitHub.`
        : `SynaBun could not reach npm to confirm that v${target} is published there, so it cannot be installed automatically. Nothing was installed. Check for updates again, or open the release on GitHub.`,
    };
  }

  const installSpec = `synabun@${version}`;
  return {
    source: 'npm',
    installSource: kind,
    canAutoUpdate: true,
    current,
    target: version,
    channel: installedChannel,
    installSpec,
    displayCommand: `npm i -g ${installSpec}`,
    npmTag: targetNpmTag,
  };
}
