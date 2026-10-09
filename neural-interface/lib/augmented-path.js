// PATH augmented with the directories CLIs actually install into.
//
// SynaBun is frequently launched from Finder/launchd rather than a login shell,
// and that process inherits a minimal PATH — typically no ~/.local/bin and no
// Homebrew. Any `which claude` / bare-command spawn under that PATH fails even
// though the CLI is installed, so every lookup and spawn that needs to find a
// user-installed binary goes through here first.
//
// Extracted from server.js so the model catalog can share it: discovery spawns
// the CLI by name too, and without this a daemon-started server silently
// degrades to the static fallback model list. The version-skew guard has the
// same dependency — it compares the installed CLI against the release the Agent
// SDK was built for, and a CLI it cannot resolve reads as "nothing to compare".
//
// SYNABUN_TOOL_DISCOVERY=path turns the additions off: the tools are then looked
// for on the PATH this process was given and nowhere else. It is what a check
// of "nothing is installed" needs on a machine where something is (the
// packaged application's own run), and what a user sets to make SynaBun see
// exactly their PATH.

import os from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { existsSync } from 'node:fs';

export function getAugmentedPath() {
  if (process.env.SYNABUN_TOOL_DISCOVERY === 'path') return process.env.PATH || '';
  const home = os.homedir();
  const npmPrefix = process.env.NPM_CONFIG_PREFIX || process.env.npm_config_prefix || '';
  const extra = process.platform === 'win32'
    ? [
      process.env.APPDATA ? join(process.env.APPDATA, 'npm') : join(home, 'AppData', 'Roaming', 'npm'),
      npmPrefix,
      dirname(process.execPath),
    ]
    : [
      join(home, '.local', 'bin'),
      '/usr/local/bin',
      // Homebrew (Apple Silicon + Linuxbrew) and Bun. Absent here, a
      // brew-installed CLI is invisible whenever SynaBun is launched from
      // Finder/launchd rather than a shell that already exported them.
      '/opt/homebrew/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      join(home, '.linuxbrew', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.npm-global', 'bin'),
      npmPrefix ? join(npmPrefix, 'bin') : '',
    ];
  // Where the tools' own installers put them, for a PATH that names none of it:
  // Claude Code's native installer (also on Windows), its older local install,
  // OpenCode's install script. After the user's PATH, so that they never
  // outrank a choice the user made there.
  const fallback = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.opencode', 'bin'),
  ];
  const entries = [
    ...extra.filter(d => d && existsSync(d)),
    ...(process.env.PATH || '').split(delimiter),
    ...fallback.filter(d => existsSync(d)),
  ];
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry) return false;
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(delimiter);
}
