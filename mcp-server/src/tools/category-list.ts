import { z } from 'zod';
import {
  getCategories,
  getParentCategories,
  getChildCategories,
  getCategoryTree,
} from '../services/categories.js';

export const categoryListSchema = {
  format: z
    .enum(['flat', 'tree', 'parents-only'])
    .optional()
    .describe('Output format: "flat" (all categories), "tree" (hierarchical), "parents-only" (top-level categories only). Default: "tree"'),
};

export const categoryListDescription =
  'List all memory categories. Returns hierarchical tree by default, showing parent categories and their children.';

export async function handleCategoryList(args: { format?: 'flat' | 'tree' | 'parents-only' }) {
  const format = args.format || 'tree';
  const categories = getCategories();

  if (format === 'flat') {
    const lines = categories.map((cat) => {
      let line = `- ${cat.name}: ${cat.description}`;
      if (cat.parent) line += ` (parent: ${cat.parent})`;
      if (cat.color) line += ` [${cat.color}]`;
      return line;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `All categories (${categories.length}):\n\n${lines.join('\n')}`,
        },
      ],
    };
  }

  if (format === 'parents-only') {
    const parents = getParentCategories();
    const lines = parents.map((cat) => {
      const children = getChildCategories(cat.name);
      let line = `- ${cat.name}: ${cat.description}`;
      if (cat.color) line += ` [${cat.color}]`;
      if (children.length > 0) {
        line += ` (${children.length} children)`;
      }
      return line;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Parent categories (${parents.length}):\n\n${lines.join('\n')}`,
        },
      ],
    };
  }

  // Tree format (default)
  const tree = getCategoryTree();
  const parents = getParentCategories();
  const lines: string[] = [];

  parents.forEach((parent) => {
    const children = tree[parent.name] || [];
    let parentLine = `## ${parent.name}`;
    if (parent.color) parentLine += ` [${parent.color}]`;
    parentLine += `\n${parent.description}`;

    lines.push(parentLine);

    if (children.length > 0) {
      children.forEach((child) => {
        let childLine = `  - ${child.name}: ${child.description}`;
        if (child.color) childLine += ` [${child.color}]`;
        lines.push(childLine);
      });
    } else {
      lines.push('  (no children)');
    }

    lines.push(''); // Empty line between clusters
  });

  // Add orphaned categories (no parent, not in tree)
  const orphans = categories.filter((c) => !c.parent && !parents.find((p) => p.name === c.name));
  if (orphans.length > 0) {
    lines.push('## Uncategorized');
    orphans.forEach((cat) => {
      let line = `  - ${cat.name}: ${cat.description}`;
      if (cat.color) line += ` [${cat.color}]`;
      lines.push(line);
    });
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: `Category Tree (${categories.length} total, ${parents.length} parent clusters):\n\n${lines.join('\n')}`,
      },
    ],
  };
}
