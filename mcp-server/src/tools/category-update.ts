import { z } from 'zod';
import {
  categoryExists,
  updateCategory,
  getAllCategories,
  getCategories,
  getChildCategories,
} from '../services/categories.js';
import { refreshCategorySchemas } from '../index.js';

export const categoryUpdateSchema = {
  name: z
    .string()
    .describe('The category name to update'),
  new_name: z
    .string()
    .optional()
    .describe('New name for the category (must follow naming rules: lowercase, starts with letter, only letters/digits/hyphens, 2-30 chars)'),
  description: z
    .string()
    .optional()
    .describe('New description for the category'),
  parent: z
    .string()
    .optional()
    .describe('New parent category name (use empty string "" to remove parent and make it a top-level category)'),
  color: z
    .string()
    .optional()
    .describe('New color hex code (e.g., "#3b82f6"). Use empty string "" to remove custom color and use auto-assigned color.'),
};

export const categoryUpdateDescription =
  'Update a category\'s properties (name, description, parent, color). Provide only the fields you want to change.';

export async function handleCategoryUpdate(args: {
  name: string;
  new_name?: string;
  description?: string;
  parent?: string;
  color?: string;
}) {
  const { name, new_name, description, parent, color } = args;

  if (!categoryExists(name)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Category "${name}" does not exist. Available: ${getAllCategories().join(', ')}`,
        },
      ],
    };
  }

  // If renaming, check new name validity
  if (new_name) {
    const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
    const MIN_LENGTH = 2;
    const MAX_LENGTH = 30;

    if (new_name.length < MIN_LENGTH || new_name.length > MAX_LENGTH) {
      return {
        content: [{
          type: 'text' as const,
          text: `New category name must be ${MIN_LENGTH}-${MAX_LENGTH} characters. Got ${new_name.length}.`
        }]
      };
    }
    if (!NAME_PATTERN.test(new_name)) {
      return {
        content: [{
          type: 'text' as const,
          text: 'New category name must match /^[a-z][a-z0-9-]*$/ (lowercase, starts with letter, only letters/digits/hyphens).'
        }]
      };
    }
    if (new_name !== name && categoryExists(new_name)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Category "${new_name}" already exists.`
        }]
      };
    }
  }

  // Validate parent if provided
  if (parent !== undefined && parent !== '') {
    // Check for self-reference first
    if (parent === name) {
      return {
        content: [{
          type: 'text' as const,
          text: `Cannot set category "${name}" as its own parent. This would create a circular reference.`
        }]
      };
    }

    if (!categoryExists(parent)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Parent category "${parent}" does not exist. Available: ${getAllCategories().join(', ')}`
        }]
      };
    }

    // Check for circular dependency
    const categories = getCategories();
    let currentParent = parent;
    while (currentParent) {
      if (currentParent === (new_name || name)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Cannot set parent to "${parent}": would create circular dependency.`
          }]
        };
      }
      const parentCat = categories.find(c => c.name === currentParent);
      currentParent = parentCat?.parent || '';
    }
  }

  // Validate color format if provided
  if (color !== undefined && color !== '' && !/^#[0-9a-f]{6}$/i.test(color)) {
    return {
      content: [{
        type: 'text' as const,
        text: 'Invalid color format. Use hex format: #rrggbb (e.g., #3b82f6) or empty string to remove.'
      }]
    };
  }

  // Check if updating a parent category that has children
  const children = getChildCategories(name);
  const isBecomingChild = parent !== undefined && parent !== '';

  let warningMsg = '';
  if (children.length > 0 && isBecomingChild) {
    warningMsg = `\n\nWarning: This category has ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} (${children.map(c => c.name).join(', ')}). Making it a child category will create nested levels.`;
  }

  // Perform the update
  const updates: {
    new_name?: string;
    description?: string;
    parent?: string | null;
    color?: string | null;
  } = {};

  if (new_name !== undefined) updates.new_name = new_name;
  if (description !== undefined) updates.description = description;
  if (parent !== undefined) updates.parent = parent === '' ? null : parent;
  if (color !== undefined) updates.color = color === '' ? null : color;

  updateCategory(name, updates);
  refreshCategorySchemas();

  const all = getAllCategories();
  let msg = `Updated category "${name}"`;
  if (new_name) msg += ` → "${new_name}"`;
  msg += ':';

  const changes: string[] = [];
  if (description !== undefined) changes.push(`description: "${description}"`);
  if (parent !== undefined) changes.push(`parent: ${parent === '' ? 'none (top-level)' : `"${parent}"`}`);
  if (color !== undefined) changes.push(`color: ${color === '' ? 'auto-assigned' : color}`);

  if (changes.length > 0) {
    msg += '\n  ' + changes.join('\n  ');
  }

  msg += warningMsg;
  msg += `\n\nAll categories (${all.length}): ${all.join(', ')}`;

  return {
    content: [
      {
        type: 'text' as const,
        text: msg,
      },
    ],
  };
}
