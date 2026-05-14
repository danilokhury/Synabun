/**
 * Profile state and logic — shared between index.ts (registration) and tools/profile.ts.
 * Extracted to its own module to avoid circular imports.
 */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare const PROFILE_PRESETS: Record<string, string[]>;
export declare const VALID_GROUPS: Set<string>;
export declare const PROFILE_PATH: string;
export declare function isClaudeCode(): boolean;
export declare function setOnProfileChanged(fn: (() => void) | null): void;
export declare function resolveProfileGroups(profileName: string): Set<string>;
export declare function readInitialProfile(): string;
export declare function getActiveProfile(): {
    profile: string;
    activeGroups: string[];
};
export declare function getActiveProfileName(): string;
export declare function getActiveGroups(): Set<string>;
export declare function getToolGroups(): Map<string, RegisteredTool[]>;
export declare function setActiveState(profileName: string, groups: Set<string>): void;
export declare function setToolGroup(name: string, tools: RegisteredTool[]): void;
export declare function applyProfile(profileName: string): {
    profile: string;
    enabled: string[];
    disabled: string[];
    totalTools: number;
};
export declare function persistProfile(profileName: string): void;
//# sourceMappingURL=profiles.d.ts.map