import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';

// ═══════════════════════════════════════════
// git — Git operations MCP tool
// ═══════════════════════════════════════════

export const gitSchema = {
  action: z.enum(['status', 'diff', 'commit', 'log', 'branches']).describe(
    'Git action. "status" = branch + changes list. "diff" = raw diff content for analysis. "commit" = stage and commit. "log" = recent commit history. "branches" = list all branches.'
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
};

export const gitDescription =
  'Git repository operations. Actions: "status" shows branch and changed files, "diff" returns raw diff content for analysis, "commit" stages and commits with a message, "log" shows recent commit history, "branches" lists all branches. Use "diff" to analyze changes before generating commit messages.';

export async function handleGit(args: {
  action: string;
  path: string;
  message?: string;
  files?: string[];
  max_lines?: number;
  count?: number;
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
    default:
      return text(`Unknown action: ${args.action}`);
  }
}

async function handleStatus(path: string) {
  const result = await ni.gitStatus(path);
  if (result.error) {
    return text(`Git status failed: ${result.error}`);
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
