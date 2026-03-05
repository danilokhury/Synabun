import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getCategories as getCategoriesFromDb, saveCategories as saveCategoriesToDb } from './sqlite.js';
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MIN_LENGTH = 2;
const MAX_LENGTH = 30;
// Callback to notify when categories change externally
let onExternalChangeCallback = null;
// Rich color palette for category visualization (36 distinct colors)
const COLOR_PALETTE = [
    // Blues & Cyans
    '#3b82f6', // Blue
    '#0ea5e9', // Sky
    '#06b6d4', // Cyan
    '#0891b2', // Dark Cyan
    '#1e40af', // Deep Blue
    '#38bdf8', // Light Sky
    // Purples & Violets
    '#8b5cf6', // Purple
    '#a855f7', // Violet
    '#6366f1', // Indigo
    '#c084fc', // Light Purple
    '#7c3aed', // Deep Violet
    '#d946ef', // Fuchsia
    // Pinks & Roses
    '#ec4899', // Pink
    '#f43f5e', // Rose
    '#db2777', // Deep Pink
    '#f472b6', // Light Pink
    '#be185d', // Dark Rose
    '#fb7185', // Coral Pink
    // Reds & Oranges
    '#ef4444', // Red
    '#f97316', // Orange
    '#dc2626', // Dark Red
    '#fb923c', // Light Orange
    '#b91c1c', // Crimson
    '#fdba74', // Peach
    // Yellows & Ambers
    '#eab308', // Yellow
    '#f59e0b', // Amber
    '#fbbf24', // Gold
    '#fcd34d', // Light Yellow
    '#d97706', // Dark Amber
    '#fde047', // Bright Yellow
    // Greens
    '#22c55e', // Green
    '#10b981', // Emerald
    '#84cc16', // Lime
    '#4ade80', // Light Green
    '#059669', // Dark Emerald
    '#14b8a6', // Teal
];
let cachedCategories = null;
let fileWatcher = null;
let watchedFilePath = null;
export function invalidateCategoryCache() {
    cachedCategories = null;
}
export function setOnExternalChange(callback) {
    onExternalChangeCallback = callback;
}
/**
 * Start watching the per-connection categories cache file.
 * Re-entrant: if the active connection changed, stops the old watcher and starts a new one.
 */
export function startWatchingCategories() {
    const filePath = getCategoriesPath();
    // If already watching the correct file, do nothing
    if (fileWatcher && watchedFilePath === filePath)
        return;
    // Stop old watcher if switching files
    stopWatchingCategories();
    // Ensure the cache file exists — start empty (SQLite is source of truth)
    if (!fs.existsSync(filePath)) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        saveCategoriesToDisk([]);
    }
    fileWatcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
            // Invalidate cache and notify
            invalidateCategoryCache();
            if (onExternalChangeCallback) {
                onExternalChangeCallback();
            }
        }
    });
    watchedFilePath = filePath;
}
export function stopWatchingCategories() {
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = null;
    }
    watchedFilePath = null;
}
/**
 * Returns the categories cache file path.
 * Single file since we use one SQLite database (no multi-connection concept).
 */
function getCategoriesPath() {
    return path.join(config.dataDir, 'custom-categories.json');
}
function loadCategoriesFromDisk() {
    const filePath = getCategoriesPath();
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data.version === 1 && Array.isArray(data.categories)) {
            return data.categories;
        }
        return [];
    }
    catch {
        return [];
    }
}
function saveCategoriesToDisk(categories) {
    const filePath = getCategoriesPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const data = { version: 1, categories };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    // Fire-and-forget write-through to SQLite (source of truth)
    saveCategoriesToDb(categories).catch((err) => {
        console.error('Failed to sync categories to SQLite:', err instanceof Error ? err.message : err);
    });
}
/**
 * Initialize the local category cache for the active connection.
 * If the per-connection cache file doesn't exist, tries to load from database first,
 * then falls back to the old global file, then starts empty.
 */
export async function initCategoryCache() {
    const filePath = getCategoriesPath();
    if (fs.existsSync(filePath)) {
        // Cache file exists, just load it
        invalidateCategoryCache();
        return;
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // Try loading from SQLite (source of truth)
    const dbCategories = await getCategoriesFromDb();
    if (dbCategories) {
        const data = { version: 1, categories: dbCategories };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        invalidateCategoryCache();
        return;
    }
    // Database empty — start with empty categories
    const data = { version: 1, categories: [] };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    invalidateCategoryCache();
}
/**
 * Call after a connection switch to re-point the file watcher
 * at the new connection's category file and sync from database if needed.
 */
export async function switchCategoryConnection() {
    invalidateCategoryCache();
    await initCategoryCache();
    startWatchingCategories(); // Will detect different path and re-watch
}
export function getCategories() {
    if (cachedCategories === null) {
        cachedCategories = loadCategoriesFromDisk();
    }
    return cachedCategories;
}
/** @deprecated Use getCategories() instead. Kept for backward compatibility. */
export function getCustomCategories() {
    return getCategories();
}
export function getAllCategories() {
    return getCategories().map((c) => c.name);
}
export function getCategoryDescription(name) {
    const cat = getCategories().find((c) => c.name === name);
    return cat?.description || '';
}
export function categoryExists(name) {
    return getAllCategories().includes(name);
}
export function validateCategoryName(name) {
    if (name.length < MIN_LENGTH || name.length > MAX_LENGTH) {
        return { valid: false, error: `Category name must be ${MIN_LENGTH}-${MAX_LENGTH} characters. Got ${name.length}.` };
    }
    if (!NAME_PATTERN.test(name)) {
        return { valid: false, error: `Category name must match /^[a-z][a-z0-9-]*$/ (lowercase, starts with letter, only letters/digits/hyphens).` };
    }
    if (categoryExists(name)) {
        return { valid: false, error: `Category "${name}" already exists.` };
    }
    return { valid: true };
}
export function validateCategory(name) {
    if (categoryExists(name)) {
        return { valid: true };
    }
    const all = getAllCategories();
    return {
        valid: false,
        error: `Unknown category "${name}". Valid categories: ${all.join(', ')}`,
    };
}
export function addCategory(name, description, parent, color, is_parent) {
    const cats = getCategories();
    const newCat = {
        name,
        description,
        created_at: new Date().toISOString(),
    };
    if (parent)
        newCat.parent = parent;
    if (color)
        newCat.color = color;
    if (is_parent)
        newCat.is_parent = true;
    cats.push(newCat);
    cachedCategories = cats;
    saveCategoriesToDisk(cats);
}
export function removeCategory(name) {
    const cats = getCategories().filter((c) => c.name !== name);
    cachedCategories = cats;
    saveCategoriesToDisk(cats);
}
export function updateCategory(name, updates) {
    const cats = getCategories();
    const catIndex = cats.findIndex((c) => c.name === name);
    if (catIndex === -1) {
        throw new Error(`Category "${name}" not found`);
    }
    const cat = cats[catIndex];
    // If renaming, update all children that reference this category as parent
    if (updates.new_name && updates.new_name !== name) {
        cats.forEach((c) => {
            if (c.parent === name) {
                c.parent = updates.new_name;
            }
        });
        cat.name = updates.new_name;
    }
    // Update other fields
    if (updates.description !== undefined) {
        cat.description = updates.description;
    }
    if (updates.parent !== undefined) {
        if (updates.parent === null) {
            delete cat.parent;
        }
        else {
            cat.parent = updates.parent;
        }
    }
    if (updates.color !== undefined) {
        if (updates.color === null) {
            delete cat.color;
        }
        else {
            cat.color = updates.color;
        }
    }
    if (updates.is_parent !== undefined) {
        if (updates.is_parent) {
            cat.is_parent = true;
        }
        else {
            delete cat.is_parent;
        }
    }
    cachedCategories = cats;
    saveCategoriesToDisk(cats);
}
export function buildCategoryDescription() {
    const cats = getCategories();
    const parentCats = cats.filter((c) => c.is_parent);
    const childCats = cats.filter((c) => c.parent);
    const standaloneCats = cats.filter((c) => !c.is_parent && !c.parent);
    const lines = [];
    // Parent categories with their children
    for (const parent of parentCats) {
        const children = childCats.filter((c) => c.parent === parent.name);
        lines.push(`[${parent.name}] (parent) — ${parent.description}`);
        if (children.length > 0) {
            for (const child of children) {
                lines.push(`  ${child.name}=${child.description}`);
            }
        }
    }
    // Standalone categories (no parent, not a parent)
    if (standaloneCats.length > 0) {
        for (const cat of standaloneCats) {
            lines.push(`${cat.name}=${cat.description}`);
        }
    }
    return 'Read each category description as a guideline for what belongs there. Match your memory to the most specific category. Parent categories group related children.\n' + lines.join(', ');
}
// Parent/child category helpers
export function getParentCategories() {
    return getCategories().filter((c) => !c.parent);
}
export function getChildCategories(parentName) {
    return getCategories().filter((c) => c.parent === parentName);
}
export function getCategoryTree() {
    const parents = getParentCategories();
    const tree = {};
    // Add parent categories
    parents.forEach((parent) => {
        tree[parent.name] = getChildCategories(parent.name);
    });
    // Add standalone categories (no parent)
    const orphans = getCategories().filter((c) => !c.parent && !tree[c.name]);
    if (orphans.length > 0) {
        tree['_uncategorized'] = orphans;
    }
    return tree;
}
export function assignColor(categoryName) {
    const cats = getCategories();
    const cat = cats.find((c) => c.name === categoryName);
    if (cat?.color)
        return cat.color;
    // Auto-assign from palette based on hash
    const hash = categoryName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return COLOR_PALETTE[hash % COLOR_PALETTE.length];
}
export function updateCategoryColor(name, color) {
    const cats = getCategories();
    const cat = cats.find((c) => c.name === name);
    if (cat) {
        cat.color = color;
        cachedCategories = cats;
        saveCategoriesToDisk(cats);
    }
}
export function getCategoryWithMeta(name) {
    const cat = getCategories().find((c) => c.name === name);
    if (!cat)
        return null;
    return {
        ...cat,
        color: cat.color || assignColor(name),
    };
}
//# sourceMappingURL=categories.js.map