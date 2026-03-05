import { z } from 'zod';
import { validateCategoryName, addCategory, getAllCategories, getCategories, categoryExists, updateCategory, removeCategory, validateCategory, getChildCategories, getParentCategories, getCategoryTree, } from '../services/categories.js';
import { countMemories, updatePayloadByFilter } from '../services/sqlite.js';
import { refreshCategorySchemas } from '../index.js';
export const categorySchema = {
    action: z
        .enum(['create', 'update', 'delete', 'list'])
        .describe('Action to perform: create, update, delete, or list categories.'),
    name: z
        .string()
        .optional()
        .describe('Category name (required for create/update/delete).'),
    description: z
        .string()
        .optional()
        .describe('Category description (required for create, optional for update).'),
    is_parent: z
        .boolean()
        .optional()
        .describe('Make this a parent/cluster category (create only).'),
    parent: z
        .string()
        .optional()
        .describe('Parent category name. Empty string "" to remove parent.'),
    color: z
        .string()
        .optional()
        .describe('Color hex code, e.g. "#3b82f6". Empty string "" to remove.'),
    new_name: z
        .string()
        .optional()
        .describe('Rename category to this (update only).'),
    reassign_to: z
        .string()
        .optional()
        .describe('Reassign memories to this category before deleting (delete only).'),
    reassign_children_to: z
        .string()
        .optional()
        .describe('Reassign child categories to this parent when deleting a parent. Empty string "" for top-level (delete only).'),
    format: z
        .enum(['flat', 'tree', 'parents-only'])
        .optional()
        .describe('Output format for list action: flat, tree (default), or parents-only.'),
};
export const categoryDescription = 'Manage memory categories. Actions: create, update, delete, list. Categories persist across sessions.';
// ── Create ──────────────────────────────────────────────────────
async function handleCreate(args) {
    if (!args.name) {
        return { content: [{ type: 'text', text: 'name is required for create action.' }] };
    }
    if (!args.description?.trim()) {
        return { content: [{ type: 'text', text: 'description is required for create action.' }] };
    }
    const nameCheck = validateCategoryName(args.name);
    if (!nameCheck.valid) {
        return { content: [{ type: 'text', text: nameCheck.error }] };
    }
    if (args.color && !/^#[0-9a-f]{6}$/i.test(args.color)) {
        return { content: [{ type: 'text', text: 'Invalid color format. Use hex format: #rrggbb (e.g., #3b82f6)' }] };
    }
    addCategory(args.name, args.description.trim(), args.parent, args.color, args.is_parent);
    refreshCategorySchemas();
    const all = getAllCategories();
    let msg = `Created category "${args.name}" (${args.description.trim()})`;
    if (args.is_parent)
        msg += ` as a parent category`;
    if (args.parent)
        msg += ` under "${args.parent}" cluster`;
    if (args.color)
        msg += ` with color ${args.color}`;
    msg += `.\n\nAll categories (${all.length}): ${all.join(', ')}`;
    return { content: [{ type: 'text', text: msg }] };
}
// ── Update ──────────────────────────────────────────────────────
async function handleUpdate(args) {
    const { name, new_name, description, parent, color } = args;
    if (!name) {
        return { content: [{ type: 'text', text: 'name is required for update action.' }] };
    }
    if (!categoryExists(name)) {
        return {
            content: [{ type: 'text', text: `Category "${name}" does not exist. Available: ${getAllCategories().join(', ')}` }],
        };
    }
    if (new_name) {
        const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
        const MIN_LENGTH = 2;
        const MAX_LENGTH = 30;
        if (new_name.length < MIN_LENGTH || new_name.length > MAX_LENGTH) {
            return { content: [{ type: 'text', text: `New category name must be ${MIN_LENGTH}-${MAX_LENGTH} characters. Got ${new_name.length}.` }] };
        }
        if (!NAME_PATTERN.test(new_name)) {
            return { content: [{ type: 'text', text: 'New category name must match /^[a-z][a-z0-9-]*$/ (lowercase, starts with letter, only letters/digits/hyphens).' }] };
        }
        if (new_name !== name && categoryExists(new_name)) {
            return { content: [{ type: 'text', text: `Category "${new_name}" already exists.` }] };
        }
    }
    if (parent !== undefined && parent !== '') {
        if (parent === name) {
            return { content: [{ type: 'text', text: `Cannot set category "${name}" as its own parent. This would create a circular reference.` }] };
        }
        if (!categoryExists(parent)) {
            return { content: [{ type: 'text', text: `Parent category "${parent}" does not exist. Available: ${getAllCategories().join(', ')}` }] };
        }
        const categories = getCategories();
        let currentParent = parent;
        while (currentParent) {
            if (currentParent === (new_name || name)) {
                return { content: [{ type: 'text', text: `Cannot set parent to "${parent}": would create circular dependency.` }] };
            }
            const parentCat = categories.find(c => c.name === currentParent);
            currentParent = parentCat?.parent || '';
        }
    }
    if (color !== undefined && color !== '' && !/^#[0-9a-f]{6}$/i.test(color)) {
        return { content: [{ type: 'text', text: 'Invalid color format. Use hex format: #rrggbb (e.g., #3b82f6) or empty string to remove.' }] };
    }
    const children = getChildCategories(name);
    const isBecomingChild = parent !== undefined && parent !== '';
    let warningMsg = '';
    if (children.length > 0 && isBecomingChild) {
        warningMsg = `\n\nWarning: This category has ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} (${children.map(c => c.name).join(', ')}). Making it a child category will create nested levels.`;
    }
    const updates = {};
    if (new_name !== undefined)
        updates.new_name = new_name;
    if (description !== undefined)
        updates.description = description;
    if (parent !== undefined)
        updates.parent = parent === '' ? null : parent;
    if (color !== undefined)
        updates.color = color === '' ? null : color;
    updateCategory(name, updates);
    refreshCategorySchemas();
    const all = getAllCategories();
    let msg = `Updated category "${name}"`;
    if (new_name)
        msg += ` → "${new_name}"`;
    msg += ':';
    const changes = [];
    if (description !== undefined)
        changes.push(`description: "${description}"`);
    if (parent !== undefined)
        changes.push(`parent: ${parent === '' ? 'none (top-level)' : `"${parent}"`}`);
    if (color !== undefined)
        changes.push(`color: ${color === '' ? 'auto-assigned' : color}`);
    if (changes.length > 0) {
        msg += '\n  ' + changes.join('\n  ');
    }
    msg += warningMsg;
    msg += `\n\nAll categories (${all.length}): ${all.join(', ')}`;
    return { content: [{ type: 'text', text: msg }] };
}
// ── Delete ──────────────────────────────────────────────────────
async function handleDelete(args) {
    const { name, reassign_to, reassign_children_to } = args;
    if (!name) {
        return { content: [{ type: 'text', text: 'name is required for delete action.' }] };
    }
    if (!categoryExists(name)) {
        return {
            content: [{ type: 'text', text: `Category "${name}" does not exist. Available: ${getAllCategories().join(', ')}` }],
        };
    }
    if (reassign_to) {
        const targetCheck = validateCategory(reassign_to);
        if (!targetCheck.valid) {
            return { content: [{ type: 'text', text: `Invalid reassign target: ${targetCheck.error}` }] };
        }
        if (reassign_to === name) {
            return { content: [{ type: 'text', text: 'Cannot reassign to the same category being deleted.' }] };
        }
    }
    const children = getChildCategories(name);
    if (children.length > 0 && reassign_children_to === undefined) {
        return {
            content: [{
                    type: 'text',
                    text: `Cannot delete parent category "${name}": it has ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} (${children.map(c => c.name).join(', ')}).\n\nProvide reassign_children_to to specify a new parent for them, or use empty string "" to make them top-level categories.`,
                }],
        };
    }
    if (reassign_children_to !== undefined && reassign_children_to !== '' && !categoryExists(reassign_children_to)) {
        return {
            content: [{ type: 'text', text: `Invalid reassign_children_to: category "${reassign_children_to}" does not exist.` }],
        };
    }
    const memoryCount = await countMemories({
        must: [{ key: 'category', match: { value: name } }],
    });
    if (memoryCount > 0 && !reassign_to) {
        return {
            content: [{
                    type: 'text',
                    text: `Cannot delete category "${name}": ${memoryCount} memories use it. Provide reassign_to to move them to another category first.`,
                }],
        };
    }
    if (memoryCount > 0 && reassign_to) {
        await updatePayloadByFilter({ must: [{ key: 'category', match: { value: name } }] }, { category: reassign_to });
    }
    let childrenMsg = '';
    if (children.length > 0) {
        const newParent = reassign_children_to === '' ? null : reassign_children_to;
        children.forEach((child) => {
            updateCategory(child.name, { parent: newParent });
        });
        if (reassign_children_to === '') {
            childrenMsg = ` ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} made top-level.`;
        }
        else {
            childrenMsg = ` ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} reassigned to "${reassign_children_to}".`;
        }
    }
    removeCategory(name);
    refreshCategorySchemas();
    const all = getAllCategories();
    const reassignMsg = memoryCount > 0
        ? ` ${memoryCount} memories reassigned to "${reassign_to}".`
        : '';
    return {
        content: [{
                type: 'text',
                text: `Deleted category "${name}".${reassignMsg}${childrenMsg}\n\nRemaining categories (${all.length}): ${all.join(', ')}`,
            }],
    };
}
// ── List ────────────────────────────────────────────────────────
async function handleList(args) {
    const format = args.format || 'tree';
    const categories = getCategories();
    if (format === 'flat') {
        const lines = categories.map((cat) => {
            let line = `- ${cat.name}: ${cat.description}`;
            if (cat.parent)
                line += ` (parent: ${cat.parent})`;
            if (cat.color)
                line += ` [${cat.color}]`;
            return line;
        });
        return {
            content: [{ type: 'text', text: `All categories (${categories.length}):\n\n${lines.join('\n')}` }],
        };
    }
    if (format === 'parents-only') {
        const parents = getParentCategories();
        const lines = parents.map((cat) => {
            const children = getChildCategories(cat.name);
            let line = `- ${cat.name}: ${cat.description}`;
            if (cat.color)
                line += ` [${cat.color}]`;
            if (children.length > 0) {
                line += ` (${children.length} children)`;
            }
            return line;
        });
        return {
            content: [{ type: 'text', text: `Parent categories (${parents.length}):\n\n${lines.join('\n')}` }],
        };
    }
    // Tree format (default)
    const tree = getCategoryTree();
    const parents = getParentCategories();
    const lines = [];
    parents.forEach((parent) => {
        const children = tree[parent.name] || [];
        let parentLine = `## ${parent.name}`;
        if (parent.color)
            parentLine += ` [${parent.color}]`;
        parentLine += `\n${parent.description}`;
        lines.push(parentLine);
        if (children.length > 0) {
            children.forEach((child) => {
                let childLine = `  - ${child.name}: ${child.description}`;
                if (child.color)
                    childLine += ` [${child.color}]`;
                lines.push(childLine);
            });
        }
        else {
            lines.push('  (no children)');
        }
        lines.push('');
    });
    const orphans = categories.filter((c) => !c.parent && !parents.find((p) => p.name === c.name));
    if (orphans.length > 0) {
        lines.push('## Uncategorized');
        orphans.forEach((cat) => {
            let line = `  - ${cat.name}: ${cat.description}`;
            if (cat.color)
                line += ` [${cat.color}]`;
            lines.push(line);
        });
    }
    return {
        content: [{
                type: 'text',
                text: `Category Tree (${categories.length} total, ${parents.length} parent clusters):\n\n${lines.join('\n')}`,
            }],
    };
}
// ── Main dispatcher ─────────────────────────────────────────────
export async function handleCategory(args) {
    switch (args.action) {
        case 'create':
            return handleCreate(args);
        case 'update':
            return handleUpdate(args);
        case 'delete':
            return handleDelete(args);
        case 'list':
            return handleList(args);
        default:
            return { content: [{ type: 'text', text: `Unknown action "${args.action}". Use: create, update, delete, list.` }] };
    }
}
//# sourceMappingURL=category.js.map