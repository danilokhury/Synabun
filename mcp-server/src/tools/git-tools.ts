import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod/v3';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';

// ═══════════════════════════════════════════
// git — Git operations MCP tool
// ═══════════════════════════════════════════

export const gitSchema = {
  action: z.enum(['status', 'diff', 'commit', 'log', 'branches', 'worktrees', 'team']).describe(
    'Git action. "status" = branch + changes list. "diff" = raw diff content for analysis. "commit" = stage and commit. "log" = recent commit history. "branches" = list all branches. "worktrees" = the repository\'s worktrees, with the ones SynaBun made for a team marked (read-only). "team" = a team\'s branches and how far each slice is joined on its integration branch; without `team`, the teams found in the repository (read-only).'
  ),
  path: z.string().describe(
    'Absolute path to the git repository working directory.'
  ),
  message: z.string().optional().describe(
    'Commit message (required for "commit" action).'
  ),
  files: z.array(z.string()).optional().describe(
    'Specific files to stage for "commit". If omitted, stages all changes (git add -A).'
  ),
  max_lines: z.number().optional().describe(
    'Max lines of diff output (default 500). Only used for "diff" action.'
  ),
  count: z.number().optional().describe(
    'Number of commits to return (default 10). Only used for "log" action.'
  ),
  team: z.string().optional().describe(
    'Team id (lower-case letters, digits and hyphens). Only used for "team": the team to show. Omit to list the teams that have branches in this repository.'
  ),
};

export const gitDescription =
  'Git repository operations. Actions: "status" shows branch and changed files, "diff" returns raw diff content for analysis, "commit" stages and commits with a message, "log" shows recent commit history, "branches" lists all branches, "worktrees" lists the repository\'s worktrees (a team\'s are under .worktrees/<team>/<slice>), "team" shows a team\'s branches and integration status. "worktrees" and "team" only read. Use "diff" to analyze changes before generating commit messages.';

export async function handleGit(args: {
  action: string;
  path: string;
  message?: string;
  files?: string[];
  max_lines?: number;
  count?: number;
  team?: string;
}) {
  if (!args.path) {
    return text('path is required');
  }

  switch (args.action) {
    case 'status': return handleStatus(args.path);
    case 'diff': return handleDiff(args.path, args.max_lines);
    case 'commit': return handleCommit(args.path, args.message, args.files);
    case 'log': return handleLog(args.path, args.count);
    case 'branches': return handleBranches(args.path);
    case 'worktrees': return handleWorktrees(args.path);
    case 'team': return handleTeam(args.path, args.team);
    default:
      return text(`Unknown action: ${args.action}`);
  }
}

async function handleStatus(path: string) {
  const result = await ni.gitStatus(path);
  if (result.error || result.ok === false || result.partial || result.stale || result.timedOut) {
    return text(`Git status incomplete: ${result.error || result.scanState || 'scan unavailable'}. Worktree cleanliness is unknown; refresh and retry.`);
  }
  if (!result.isGit) {
    return text(`Not a git repository: ${path}`);
  }

  const changes = (result.changes || []) as Array<{ path: string; status: string; staged: boolean }>;
  const grouped: Record<string, string[]> = {};
  for (const c of changes) {
    const key = c.status + (c.staged ? ' (staged)' : '');
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(c.path);
  }

  let msg = `Branch: ${result.branch}\nChanges: ${changes.length} file${changes.length !== 1 ? 's' : ''}\n`;
  for (const [status, files] of Object.entries(grouped)) {
    msg += `\n${status}:\n${files.map(f => '  ' + f).join('\n')}\n`;
  }

  if (changes.length === 0) msg += '\nWorking tree clean.';
  return text(msg.trim());
}

async function handleDiff(path: string, maxLines?: number) {
  const result = await ni.gitDiff(path, maxLines);
  if (result.error) {
    return text(`Git diff failed: ${result.error}`);
  }

  const parts: string[] = [`Branch: ${result.branch}`];

  const diff = result.diff as string;
  const stagedDiff = result.stagedDiff as string;
  const untrackedFiles = (result.untrackedFiles || []) as string[];

  if (diff) parts.push('\n--- Unstaged changes ---\n' + diff);
  if (stagedDiff) parts.push('\n--- Staged changes ---\n' + stagedDiff);
  if (untrackedFiles.length > 0) parts.push('\n--- Untracked files ---\n' + untrackedFiles.join('\n'));
  if (!diff && !stagedDiff && untrackedFiles.length === 0) parts.push('\nNo changes.');
  if (result.truncated) parts.push('\n(output truncated)');

  return text(parts.join('\n'));
}

async function handleCommit(path: string, message?: string, files?: string[]) {
  if (!message) {
    return text('message is required for commit action');
  }

  const result = await ni.gitCommit(path, message, files);
  if (result.error) {
    return text(`Commit failed: ${result.error}`);
  }

  return text(`Committed: ${message}\n\n${result.output || ''}`.trim());
}

async function handleLog(path: string, count?: number) {
  const result = await ni.gitLog(path, count);
  if (result.error) {
    return text(`Git log failed: ${result.error}`);
  }

  const commits = (result.commits || []) as Array<{ hash: string; message: string }>;
  if (commits.length === 0) {
    return text('No commits found.');
  }

  const msg = commits.map(c => `${c.hash} ${c.message}`).join('\n');
  return text(`Recent commits:\n\n${msg}`);
}

async function handleBranches(path: string) {
  const result = await ni.gitBranches(path);
  if (result.error) {
    return text(`Failed to list branches: ${result.error}`);
  }

  const branches = (result.branches || []) as string[];
  const current = result.current as string || '';
  const msg = branches.map(b => (b === current ? `* ${b}` : `  ${b}`)).join('\n');
  return text(`Branches:\n\n${msg}`);
}

// ═══════════════════════════════════════════
// Worktrees and teams — what git itself shows, read-only
// ═══════════════════════════════════════════
//
// SynaBun gives every worker of a team its own worktree and branch (neural-interface/lib/teams/):
//
//   <project>/.worktrees/<team>/<slice>        branch synabun/<team>/<slice>
//   <project>/.worktrees/<team>/integration    branch synabun/<team>/integration   (where finished slices are joined)
//
// These two actions show that from the repository alone. They ask git and change nothing: no worktree is made or
// removed, no branch moved, no index written. Creating a team, joining slices and landing are not this tool's.
// git is started by argument array with the rules of a read (neural-interface/lib/git-read.js): no hook, no file
// system monitor program, no signature check, no remote, no optional lock.

const TEAM_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const TEAM_BRANCH = /^synabun\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/;
const INTEGRATION = 'integration';
const WORKTREES_DIR = '.worktrees';
const MAX_WORKTREES = 60;

const READ_OPTIONS = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, '-c', 'log.showSignature=false'];
const READ_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
const AIMING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];
/** The sub-commands these actions use: every one only asks. */
const READ_COMMANDS = new Set(['rev-parse', 'worktree', 'status', 'for-each-ref', 'rev-list', 'cherry', 'merge-base', 'log', 'symbolic-ref']);

interface GitAnswer { ok: boolean; stdout: string; stderr: string }

function readGit(cwd: string, args: string[]): Promise<GitAnswer> {
  if (!READ_COMMANDS.has(args[0]) || (args[0] === 'worktree' && args[1] !== 'list')) return Promise.resolve({ ok: false, stdout: '', stderr: `not a read: git ${args[0]}` });
  const env: Record<string, string | undefined> = { ...process.env, ...READ_ENV };
  for (const name of AIMING_ENV) delete env[name];
  return new Promise((done) => {
    try {
      execFile('git', [...READ_OPTIONS, ...args], { cwd, env, timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false, encoding: 'utf8' }, (error, stdout, stderr) => {
        done({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || (error ? error.message : '')) });
      });
    } catch (error) {
      done({ ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
    }
  });
}

const firstLine = (answer: GitAnswer) => (answer.ok ? answer.stdout.split('\n')[0].trim() : '');
const realOf = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 9) : '—');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface WorktreeEntry {
  path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; locked: boolean; prunable: boolean;
  exists: boolean; main: boolean; team: { teamId: string; sliceId: string } | null; dirty: number | null;
}

/** The folder as a repository: its main checkout and every worktree git knows. A message when it is not one. */
async function repositoryOf(path: string): Promise<{ root: string; worktrees: WorktreeEntry[] } | string> {
  if (!isAbsolute(path)) return 'path must be an absolute path to a git working directory.';
  let isDir = false;
  try { isDir = statSync(path).isDirectory(); } catch { isDir = false; }
  if (!isDir) return `Not a folder: ${path}`;
  const inside = await readGit(path, ['rev-parse', '--is-inside-work-tree']);
  if (firstLine(inside) !== 'true') return `Not a git repository: ${path}`;
  const listed = await readGit(path, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return `Git worktree list failed: ${listed.stderr.trim().slice(0, 300)}`;
  const worktrees: WorktreeEntry[] = [];
  let entry: WorktreeEntry | null = null;
  for (const raw of listed.stdout.split('\n')) {
    if (!raw.trim()) { if (entry) worktrees.push(entry); entry = null; continue; }
    const at = raw.indexOf(' ');
    const key = at < 0 ? raw : raw.slice(0, at);
    const value = at < 0 ? '' : raw.slice(at + 1);
    if (key === 'worktree') {
      if (entry) worktrees.push(entry);
      entry = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, exists: false, main: false, team: null, dirty: null };
      continue;
    }
    if (!entry) continue;
    if (key === 'HEAD') entry.head = value;
    else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') entry.detached = true;
    else if (key === 'bare') entry.bare = true;
    else if (key === 'locked') entry.locked = true;
    else if (key === 'prunable') entry.prunable = true;
  }
  if (entry) worktrees.push(entry);
  if (!worktrees.length) return `Git lists no worktree for ${path}.`;
  // The first entry is the repository's main checkout: a team's worktrees are under its .worktrees folder.
  const root = worktrees[0].path;
  const base = resolve(realOf(root), WORKTREES_DIR);
  worktrees.forEach((each, index) => {
    each.main = index === 0;
    each.exists = existsSync(each.path);
    const parts = relative(base, realOf(each.path)).split(sep);
    if (parts.length === 2 && TEAM_SLUG.test(parts[0]) && TEAM_SLUG.test(parts[1]) && each.branch === `synabun/${parts[0]}/${parts[1]}`) each.team = { teamId: parts[0], sliceId: parts[1] };
  });
  return { root, worktrees };
}

/** How many uncommitted paths a checkout has (untracked ones counted file by file), or null when it cannot be read. */
async function dirtyCount(path: string): Promise<number | null> {
  const status = await readGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok) return null;
  let count = 0;
  const items = status.stdout.split('\0');
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].length < 4) continue;
    count += 1;
    if (items[i][0] === 'R' || items[i][0] === 'C') i += 1;   // the path a rename or copy came from follows
  }
  return count;
}

async function handleWorktrees(path: string) {
  const repo = await repositoryOf(path);
  if (typeof repo === 'string') return text(repo);
  const shown = repo.worktrees.slice(0, MAX_WORKTREES);
  for (const each of shown) if (each.exists && !each.bare) each.dirty = await dirtyCount(each.path);
  const here = realOf(path);
  const lines = shown.map((each) => {
    const what = each.bare ? '(bare)' : each.detached ? `detached at ${short(each.head)}` : `${each.branch || '?'} @ ${short(each.head)}`;
    const notes = [
      each.main ? 'main checkout' : null,
      each.team ? `team ${each.team.teamId} · ${each.team.sliceId === INTEGRATION ? 'integration' : `slice ${each.team.sliceId}`}` : null,
      !each.exists ? 'folder missing' : each.dirty === null ? null : each.dirty === 0 ? 'clean' : `${plural(each.dirty, 'uncommitted file')}`,
      each.locked ? 'locked' : null,
      each.prunable ? 'prunable' : null,
      realOf(each.path) === here ? 'here' : null,
    ].filter(Boolean);
    return `  ${each.path}\n      ${what}${notes.length ? `  (${notes.join(', ')})` : ''}`;
  });
  const teams = [...new Set(repo.worktrees.filter((each) => each.team).map((each) => each.team!.teamId))];
  let msg = `Worktrees of ${repo.root} (${repo.worktrees.length}):\n\n${lines.join('\n')}`;
  if (repo.worktrees.length > shown.length) msg += `\n  … and ${repo.worktrees.length - shown.length} more`;
  msg += teams.length
    ? `\n\nTeams with worktrees here: ${teams.join(', ')}. Use action "team" with one of them for its branches and integration status.`
    : `\n\nNo team worktrees (they would be under ${WORKTREES_DIR}/<team>/<slice>).`;
  return text(msg);
}

async function handleTeam(path: string, team?: string) {
  const repo = await repositoryOf(path);
  if (typeof repo === 'string') return text(repo);
  const refs = await readGit(repo.root, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)', 'refs/heads/synabun/']);
  if (!refs.ok) return text(`Git could not list branches: ${refs.stderr.trim().slice(0, 300)}`);
  const branches = refs.stdout.split('\n').filter(Boolean).map((row) => {
    const [name, head, date, subject] = row.split('\0');
    const match = TEAM_BRANCH.exec(name);
    return match ? { name, head, date, subject: subject || '', teamId: match[1], sliceId: match[2] } : null;
  }).filter((each): each is NonNullable<typeof each> => each !== null);

  if (!team) {
    const byTeam = new Map<string, typeof branches>();
    for (const each of branches) byTeam.set(each.teamId, [...(byTeam.get(each.teamId) || []), each]);
    if (!byTeam.size) return text(`No team branches in ${repo.root} (a team's branches are synabun/<team>/<slice>).`);
    const lines = [...byTeam].map(([teamId, list]) => {
      const slices = list.filter((each) => each.sliceId !== INTEGRATION);
      const integration = list.find((each) => each.sliceId === INTEGRATION);
      const folders = repo.worktrees.filter((each) => each.team?.teamId === teamId).length;
      return `  ${teamId}: ${plural(slices.length, 'slice')} (${slices.map((each) => each.sliceId).join(', ') || 'none'}), integration ${integration ? `@ ${short(integration.head)}` : 'branch missing'}, ${plural(folders, 'worktree')}`;
    });
    return text(`Teams in ${repo.root}:\n\n${lines.join('\n')}\n\nUse action "team" with a team id for its integration status.`);
  }

  const teamId = team.trim().toLowerCase();
  if (!TEAM_SLUG.test(teamId)) return text('team is a team id: lower-case letters, digits and hyphens.');
  const mine = branches.filter((each) => each.teamId === teamId);
  const folders = repo.worktrees.filter((each) => each.team?.teamId === teamId);
  if (!mine.length && !folders.length) return text(`No team "${teamId}" in ${repo.root}: no synabun/${teamId}/* branch and no worktree under ${WORKTREES_DIR}/${teamId}/.`);

  const integration = mine.find((each) => each.sliceId === INTEGRATION) || null;
  const out: string[] = [`Team ${teamId} in ${repo.root}`];
  const folderOf = async (sliceId: string) => {
    const entry = folders.find((each) => each.team?.sliceId === sliceId);
    if (!entry) return 'no worktree';
    if (!entry.exists) return `worktree folder missing (${entry.path})`;
    const dirty = await dirtyCount(entry.path);
    return `worktree ${dirty === null ? 'unreadable' : dirty === 0 ? 'clean' : `has ${plural(dirty, 'uncommitted file')}`}`;
  };

  if (integration) {
    out.push('', `Integration: ${integration.name} @ ${short(integration.head)} — ${integration.subject.slice(0, 100)}`, `  ${await folderOf(INTEGRATION)}`);
  } else {
    out.push('', `Integration: branch synabun/${teamId}/${INTEGRATION} is missing.`);
  }

  const slices = mine.filter((each) => each.sliceId !== INTEGRATION);
  out.push('', slices.length ? 'Slices:' : 'Slices: none (no slice branch).');
  let joined = 0;
  let withWork = 0;
  const mainHead = repo.worktrees[0].head;
  for (const slice of slices) {
    let status = 'integration branch missing';
    if (integration) {
      const base = firstLine(await readGit(repo.root, ['merge-base', integration.head, slice.head]));
      // `git cherry`: a `+` line is a commit of the slice whose change is not on the integration branch.
      const cherry = base ? await readGit(repo.root, ['cherry', integration.head, slice.head, base]) : null;
      const waiting = cherry && cherry.ok ? cherry.stdout.split('\n').filter((row) => row.startsWith('+ ')).length : null;
      if (waiting === null) {
        status = 'could not be compared with the integration branch';
      } else if (base === slice.head) {
        // The slice's head is on the integration branch itself (joined without a copy, or nothing was ever
        // committed on it: then the main checkout's branch has it too).
        const untouched = !!mainHead && firstLine(await readGit(repo.root, ['rev-list', '--count', `${mainHead}..${slice.head}`])) === '0';
        if (untouched) status = 'no commits of its own';
        else { status = 'joined (its branch is on the integration branch)'; joined += 1; withWork += 1; }
      } else {
        const own = Number(firstLine(await readGit(repo.root, ['rev-list', '--count', `${base}..${slice.head}`])) || 0);
        withWork += 1;
        if (waiting === 0) { status = `joined (${plural(own, 'commit')}, all on the integration branch)`; joined += 1; }
        else status = `${plural(waiting, 'commit')} not on the integration branch yet${own > waiting ? ` (${own - waiting} joined)` : ''}`;
      }
    }
    out.push(`  ${slice.sliceId}: ${slice.name} @ ${short(slice.head)} — ${status}; ${await folderOf(slice.sliceId)}`);
  }
  for (const entry of folders.filter((each) => each.team && each.team.sliceId !== INTEGRATION && !slices.some((slice) => slice.sliceId === each.team!.sliceId))) {
    out.push(`  ${entry.team!.sliceId}: worktree ${entry.path} with no branch synabun/${teamId}/${entry.team!.sliceId}`);
  }

  // Where the result would land: the branch the main checkout is on, compared with the integration branch.
  if (integration) {
    const main = repo.worktrees[0];
    if (main.branch && main.head && !TEAM_BRANCH.test(main.branch)) {
      const counts = /^(\d+)\s+(\d+)/.exec(firstLine(await readGit(repo.root, ['rev-list', '--left-right', '--count', `${main.head}...${integration.head}`])));
      if (counts) {
        const [mineOnly, teamOnly] = [Number(counts[1]), Number(counts[2])];
        const how = teamOnly === 0 ? `already has everything on the integration branch`
          : mineOnly === 0 ? `is ${plural(teamOnly, 'commit')} behind the integration branch: it can be fast-forwarded`
            : `has ${plural(mineOnly, 'commit')} the integration branch lacks and lacks ${teamOnly}: landing needs a merge`;
        out.push('', `Landing: ${main.branch} (the main checkout's branch) ${how}.`);
      }
    }
    out.push(`Joined: ${joined} of the ${plural(withWork, 'slice')} with commits of their own ${joined === 1 ? 'is' : 'are'} wholly on the integration branch.`);
  }
  out.push('', 'This is what git shows. Conflicts, test results and whether a team has landed are in SynaBun\'s team record; this tool creates, joins, lands and removes nothing.');
  return text(out.join('\n'));
}
