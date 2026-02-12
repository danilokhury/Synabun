import { z } from 'zod';
import {
  categoryExists,
  removeCategory,
  getAllCategories,
  validateCategory,
  getChildCategories,
  updateCategory,
} from '../services/categories.js';
import { countMemories, updatePayloadByFilter } from '../services/qdrant.js';
import { refreshCategorySchemas } from '../index.js';

export const categoryDeleteSchema = {
  name: z
    .string()
    .describe('The custom category name to delete.'),
  reassign_to: z
    .string()
    .optional()
    .describe(
      'If memories exist with this category, reassign them to this category instead of blocking deletion.'
    ),
  reassign_children_to: z
    .string()
    .optional()
    .describe(
      'If deleting a parent category with children, reassign children to this parent (or use empty string "" to make them top-level categories).'
    ),
};

export const categoryDeleteDescription =
  'Delete a memory category. If memories exist with the category, provide reassign_to to move them first.';

export async function handleCategoryDelete(args: {
  name: string;
  reassign_to?: string;
  reassign_children_to?: string;
}) {
  const { name, reassign_to, reassign_children_to } = args;

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

  if (reassign_to) {
    const targetCheck = validateCategory(reassign_to);
    if (!targetCheck.valid) {
      return {
        content: [{ type: 'text' as const, text: `Invalid reassign target: ${targetCheck.error}` }],
      };
    }
    if (reassign_to === name) {
      return {
        content: [{ type: 'text' as const, text: 'Cannot reassign to the same category being deleted.' }],
      };
    }
  }

  // Check if this is a parent category with children
  const children = getChildCategories(name);
  if (children.length > 0 && reassign_children_to === undefined) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Cannot delete parent category "${name}": it has ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} (${children.map(c => c.name).join(', ')}).\n\nProvide reassign_children_to to specify a new parent for them, or use empty string "" to make them top-level categories.`,
        },
      ],
    };
  }

  // Validate reassign_children_to if provided
  if (reassign_children_to !== undefined && reassign_children_to !== '' && !categoryExists(reassign_children_to)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Invalid reassign_children_to: category "${reassign_children_to}" does not exist.`,
        },
      ],
    };
  }

  const memoryCount = await countMemories({
    must: [{ key: 'category', match: { value: name } }],
  });

  if (memoryCount > 0 && !reassign_to) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Cannot delete category "${name}": ${memoryCount} memories use it. Provide reassign_to to move them to another category first.`,
        },
      ],
    };
  }

  if (memoryCount > 0 && reassign_to) {
    await updatePayloadByFilter(
      { must: [{ key: 'category', match: { value: name } }] },
      { category: reassign_to }
    );
  }

  // Handle children reassignment
  let childrenMsg = '';
  if (children.length > 0) {
    const newParent = reassign_children_to === '' ? null : reassign_children_to;
    children.forEach((child) => {
      updateCategory(child.name, { parent: newParent });
    });

    if (reassign_children_to === '') {
      childrenMsg = ` ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} made top-level.`;
    } else {
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
    content: [
      {
        type: 'text' as const,
        text: `Deleted category "${name}".${reassignMsg}${childrenMsg}\n\nRemaining categories (${all.length}): ${all.join(', ')}`,
      },
    ],
  };
}
