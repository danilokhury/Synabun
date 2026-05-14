import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PROFILE_PRESETS, VALID_GROUPS, resolveProfileGroups, getActiveProfile, applyProfile, persistProfile } from './services/profiles.js';
export { PROFILE_PRESETS, VALID_GROUPS, resolveProfileGroups, getActiveProfile, applyProfile, persistProfile };
export declare function registerTools(server: McpServer): {
    rememberTool: import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool;
    recallTool: import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool;
    reflectTool: import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool;
    memoriesTool: import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool;
};
export declare function trackToolUsage(toolName: string): void;
export declare function getToolUsageSummary(): {
    counts: Record<string, number>;
    profile: string;
    activeGroups: string[];
    recommendation: string;
};
export declare function createMcpServer(forceProfile?: string): McpServer;
export declare function refreshCategorySchemas(): void;
//# sourceMappingURL=index.d.ts.map