import { z } from 'zod';
import {
  validateCategoryName,
  addCategory,
  getAllCategories,
} from '../services/categories.js';
import { refreshCategorySchemas } from '../index.js';

export const categoryCreateSchema = {
  name: z
    .string()
    .describe(
      'Category name: lowercase, starts with letter, only letters/digits/hyphens, 2-30 chars. Example: "devops"'
    ),
  description: z
    .string()
    .describe(
      'Short description of what this category is for. Example: "CI/CD, infrastructure, deployments"'
    ),
  parent: z
    .string()
    .optional()
    .describe(
      'Optional parent category name for clustering. Example: "development" to group under Development cluster'
    ),
  color: z
    .string()
    .optional()
    .describe(
      'Optional color hex code for visual grouping. Example: "#3b82f6" (blue). If omitted, auto-assigns from palette.'
    ),
  is_parent: z
    .boolean()
    .optional()
    .describe(
      'Set to true to make this a parent/cluster category that groups child categories under it. Parent categories are top-level organizational branches.'
    ),
};

export const categoryCreateDescription =
  'Create a new memory category. Categories persist across sessions.';

export async function handleCategoryCreate(args: {
  name: string;
  description: string;
  parent?: string;
  color?: string;
  is_parent?: boolean;
}) {
  const nameCheck = validateCategoryName(args.name);
  if (!nameCheck.valid) {
    return {
      content: [{ type: 'text' as const, text: nameCheck.error! }],
    };
  }

  if (!args.description.trim()) {
    return {
      content: [{ type: 'text' as const, text: 'Description cannot be empty.' }],
    };
  }

  // Validate color format if provided
  if (args.color && !/^#[0-9a-f]{6}$/i.test(args.color)) {
    return {
      content: [{ type: 'text' as const, text: 'Invalid color format. Use hex format: #rrggbb (e.g., #3b82f6)' }],
    };
  }

  addCategory(args.name, args.description.trim(), args.parent, args.color, args.is_parent);
  refreshCategorySchemas();

  const all = getAllCategories();
  let msg = `Created category "${args.name}" (${args.description.trim()})`;
  if (args.is_parent) msg += ` as a parent category`;
  if (args.parent) msg += ` under "${args.parent}" cluster`;
  if (args.color) msg += ` with color ${args.color}`;
  msg += `.\n\nAll categories (${all.length}): ${all.join(', ')}`;

  return {
    content: [
      {
        type: 'text' as const,
        text: msg,
      },
    ],
  };
}
