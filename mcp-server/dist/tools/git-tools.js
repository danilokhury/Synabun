import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
// ═══════════════════════════════════════════
// git — Git operations MCP tool
// ═══════════════════════════════════════════
export const gitSchema = {
    action: z.enum(['status', 'diff', 'commit', 'log', 'branches']).describe('Git action. "status" = branch + changes list. "diff" = raw diff content for analysis. "commit" = stage and commit. "log" = recent commit history. "branches" = list all branches.'),
    path: z.string().describe('Absolute path to the git repository working directory.'),
    message: z.string().optional().describe('Commit message (required for "commit" action).'),
    files: z.array(z.string()).optional().describe('Specific files to stage for "commit". If omitted, stages all changes (git add -A).'),
    max_lines: z.number().optional().describe('Max lines of diff output (default 500). Only used for "diff" action.'),
    count: z.number().optional().describe('Number of commits to return (default 10). Only used for "log" action.'),
};
export const gitDescription = 'Git repository operations. Actions: "status" shows branch and changed files, "diff" returns raw diff content for analysis, "commit" stages and commits with a message, "log" shows recent commit history, "branches" lists all branches. Use "diff" to analyze changes before generating commit messages.';
export async function handleGit(args) {
    if (!args.path) {
        return { content: [{ type: 'text', text: 'path is required' }] };
    }
    switch (args.action) {
        case 'status': return handleStatus(args.path);
        case 'diff': return handleDiff(args.path, args.max_lines);
        case 'commit': return handleCommit(args.path, args.message, args.files);
        case 'log': return handleLog(args.path, args.count);
        case 'branches': return handleBranches(args.path);
        default:
            return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }] };
    }
}
async function handleStatus(path) {
    const result = await ni.gitStatus(path);
    if (result.error) {
        return { content: [{ type: 'text', text: `Git status failed: ${result.error}` }] };
    }
    if (!result.isGit) {
        return { content: [{ type: 'text', text: `Not a git repository: ${path}` }] };
    }
    const changes = (result.changes || []);
    const grouped = {};
    for (const c of changes) {
        const key = c.status + (c.staged ? ' (staged)' : '');
        if (!grouped[key])
            grouped[key] = [];
        grouped[key].push(c.path);
    }
    let text = `Branch: ${result.branch}\nChanges: ${changes.length} file${changes.length !== 1 ? 's' : ''}\n`;
    for (const [status, files] of Object.entries(grouped)) {
        text += `\n${status}:\n${files.map(f => '  ' + f).join('\n')}\n`;
    }
    if (changes.length === 0)
        text += '\nWorking tree clean.';
    return { content: [{ type: 'text', text: text.trim() }] };
}
async function handleDiff(path, maxLines) {
    const result = await ni.gitDiff(path, maxLines);
    if (result.error) {
        return { content: [{ type: 'text', text: `Git diff failed: ${result.error}` }] };
    }
    const parts = [`Branch: ${result.branch}`];
    const diff = result.diff;
    const stagedDiff = result.stagedDiff;
    const untrackedFiles = (result.untrackedFiles || []);
    if (diff)
        parts.push('\n--- Unstaged changes ---\n' + diff);
    if (stagedDiff)
        parts.push('\n--- Staged changes ---\n' + stagedDiff);
    if (untrackedFiles.length > 0)
        parts.push('\n--- Untracked files ---\n' + untrackedFiles.join('\n'));
    if (!diff && !stagedDiff && untrackedFiles.length === 0)
        parts.push('\nNo changes.');
    if (result.truncated)
        parts.push('\n(output truncated)');
    return { content: [{ type: 'text', text: parts.join('\n') }] };
}
async function handleCommit(path, message, files) {
    if (!message) {
        return { content: [{ type: 'text', text: 'message is required for commit action' }] };
    }
    const result = await ni.gitCommit(path, message, files);
    if (result.error) {
        return { content: [{ type: 'text', text: `Commit failed: ${result.error}` }] };
    }
    return { content: [{ type: 'text', text: `Committed: ${message}\n\n${result.output || ''}`.trim() }] };
}
async function handleLog(path, count) {
    const result = await ni.gitLog(path, count);
    if (result.error) {
        return { content: [{ type: 'text', text: `Git log failed: ${result.error}` }] };
    }
    const commits = (result.commits || []);
    if (commits.length === 0) {
        return { content: [{ type: 'text', text: 'No commits found.' }] };
    }
    const text = commits.map(c => `${c.hash} ${c.message}`).join('\n');
    return { content: [{ type: 'text', text: `Recent commits:\n\n${text}` }] };
}
async function handleBranches(path) {
    const result = await ni.gitBranches(path);
    if (result.error) {
        return { content: [{ type: 'text', text: `Failed to list branches: ${result.error}` }] };
    }
    const branches = (result.branches || []);
    const current = result.current || '';
    const text = branches.map(b => (b === current ? `* ${b}` : `  ${b}`)).join('\n');
    return { content: [{ type: 'text', text: `Branches:\n\n${text}` }] };
}
//# sourceMappingURL=git-tools.js.map