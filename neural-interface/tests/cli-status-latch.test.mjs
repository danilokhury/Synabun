import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCliInstallCommand,
  recheckCliStatus,
  subscribeCliStatus,
} from '../public/shared/cli-status.js';

// cli-status.js is a browser module, but nothing it touches at import time or
// on these code paths is DOM-bound: the only `document` access lives inside
// the background poller, which never starts while the subscribed tool reports
// installed (see _hasMissingSubscribed).

const CODEX_VERSION = '0.147.0';

function stubToolVersions(tools) {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ checkedAt: new Date().toISOString(), tools }),
  });
  return () => { globalThis.fetch = prior; };
}

const INSTALLED_BREW = {
  'codex': {
    installed: CODEX_VERSION,
    latest: CODEX_VERSION,
    updateAvailable: false,
    installSource: 'brew-cask',
    installCommand: 'brew install --cask codex',
    updateCommand: 'brew upgrade --cask codex',
    canUpdate: true,
  },
};

test('REGRESSION: an explicit re-check notifies subscribers even when the version is unchanged', async () => {
  // This is the deadlock behind the permanently stuck "Codex CLI not
  // installed" banner. A panel latches the banner after a spawn error and can
  // only clear it from this callback. The version does not change across the
  // failure, so under the old change-only _emitChange the callback never
  // fired and the Re-check button was a no-op by construction.
  const restore = stubToolVersions(INSTALLED_BREW);
  const seen = [];
  const unsub = subscribeCliStatus('codex', (info) => seen.push(info?.installed ?? null));

  try {
    // Let the initial subscribe-time fetch settle.
    await recheckCliStatus('codex');
    const afterFirst = seen.length;
    assert.ok(afterFirst >= 1, 'subscriber should have been called at least once');

    // Same version both sides — the case that used to be suppressed.
    const info = await recheckCliStatus('codex');
    assert.equal(info.installed, CODEX_VERSION);
    assert.ok(
      seen.length > afterFirst,
      'an unchanged-version re-check must still notify — otherwise the banner can never clear',
    );
    assert.equal(seen.at(-1), CODEX_VERSION);
  } finally {
    unsub();
    restore();
  }
});

test('recheckCliStatus returns the tool info so callers can clear a latch directly', async () => {
  // The panels no longer depend on the event at all: they read this return
  // value. Belt and braces with the force-emit fix above.
  const restore = stubToolVersions(INSTALLED_BREW);
  try {
    const info = await recheckCliStatus('codex');
    assert.equal(info.installed, CODEX_VERSION);
    assert.equal(info.installSource, 'brew-cask');
  } finally {
    restore();
  }
});

test('a missing tool still reports installed=null', async () => {
  const restore = stubToolVersions({
    'codex': { installed: null, latest: '0.147.0', installSource: 'unknown', canUpdate: false },
  });
  try {
    const info = await recheckCliStatus('codex');
    assert.equal(info.installed, null);
  } finally {
    restore();
  }
});

test('install command follows the channel the server detected, not hardcoded npm', async () => {
  // A Homebrew user told to `npm install -g` would end up with a second,
  // conflicting install that may not even win PATH.
  const restore = stubToolVersions(INSTALLED_BREW);
  try {
    await recheckCliStatus('codex');
    assert.equal(getCliInstallCommand('codex'), 'brew install --cask codex');
  } finally {
    restore();
  }
});

test('install command falls back to npm before the first server response', async () => {
  const restore = stubToolVersions({
    'gemini': { installed: null, installSource: 'unknown' },
  });
  try {
    await recheckCliStatus('gemini');
    // No installCommand in this payload — the built-in default applies.
    assert.equal(getCliInstallCommand('gemini'), 'npm install -g @google/gemini-cli');
  } finally {
    restore();
  }
});
