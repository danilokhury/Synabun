interface CustomCategory {
    name: string;
    description: string;
    created_at: string;
    parent?: string;
    color?: string;
    is_parent?: boolean;
}
export declare function invalidateCategoryCache(): void;
export declare function setOnExternalChange(callback: () => void): void;
/**
 * Start watching the per-connection categories cache file.
 * Re-entrant: if the active connection changed, stops the old watcher and starts a new one.
 */
export declare function startWatchingCategories(): void;
export declare function stopWatchingCategories(): void;
/**
 * Initialize the local category cache for the active connection.
 * If the per-connection cache file doesn't exist, tries to load from database first,
 * then falls back to the old global file, then starts empty.
 */
export declare function initCategoryCache(): Promise<void>;
/**
 * Call after a connection switch to re-point the file watcher
 * at the new connection's category file and sync from database if needed.
 */
export declare function switchCategoryConnection(): Promise<void>;
export declare function getCategories(): CustomCategory[];
/** @deprecated Use getCategories() instead. Kept for backward compatibility. */
export declare function getCustomCategories(): CustomCategory[];
export declare function getAllCategories(): string[];
export declare function getCategoryDescription(name: string): string;
export declare function categoryExists(name: string): boolean;
export declare function validateCategoryName(name: string): {
    valid: boolean;
    error?: string;
};
export declare function validateCategory(name: string): {
    valid: boolean;
    error?: string;
};
export declare function addCategory(name: string, description: string, parent?: string, color?: string, is_parent?: boolean): void;
export declare function removeCategory(name: string): void;
export declare function updateCategory(name: string, updates: {
    new_name?: string;
    description?: string;
    parent?: string | null;
    color?: string | null;
    is_parent?: boolean;
}): void;
export declare function buildCategoryDescription(): string;
export declare function getParentCategories(): CustomCategory[];
export declare function getChildCategories(parentName: string): CustomCategory[];
export declare function getCategoryTree(): Record<string, CustomCategory[]>;
export declare function assignColor(categoryName: string): string;
export declare function updateCategoryColor(name: string, color: string): void;
export declare function getCategoryWithMeta(name: string): (CustomCategory & {
    color: string;
}) | null;
export {};
//# sourceMappingURL=categories.d.ts.map