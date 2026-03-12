import { gitSchema, gitDescription, handleGit, } from './git-tools.js';
/**
 * Register the Git MCP tool on the given server instance.
 * Single tool with action-based dispatch: status, diff, commit, log, branches.
 */
export function registerGitTools(server) {
    server.tool('git', gitDescription, gitSchema, handleGit);
}
//# sourceMappingURL=git.js.map