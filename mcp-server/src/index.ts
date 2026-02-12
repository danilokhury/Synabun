#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureCollection } from './services/qdrant.js';
import { rememberSchema, rememberDescription, handleRemember, buildRememberSchema } from './tools/remember.js';
import { recallSchema, recallDescription, handleRecall, buildRecallSchema } from './tools/recall.js';
import { forgetSchema, forgetDescription, handleForget } from './tools/forget.js';
import { reflectSchema, reflectDescription, handleReflect, buildReflectSchema } from './tools/reflect.js';
import { memoriesSchema, memoriesDescription, handleMemories, buildMemoriesSchema } from './tools/memories.js';
import { categoryCreateSchema, categoryCreateDescription, handleCategoryCreate } from './tools/category-create.js';
import { categoryDeleteSchema, categoryDeleteDescription, handleCategoryDelete } from './tools/category-delete.js';
import { categoryUpdateSchema, categoryUpdateDescription, handleCategoryUpdate } from './tools/category-update.js';
import { categoryListSchema, categoryListDescription, handleCategoryList } from './tools/category-list.js';
import { invalidateCategoryCache } from './services/categories.js';

const server = new McpServer({
  name: 'claude-memory',
  version: '1.1.0',
});

// Store tool references so we can update schemas dynamically
const rememberTool = server.tool('remember', rememberDescription, rememberSchema, handleRemember);
const recallTool = server.tool('recall', recallDescription, recallSchema, handleRecall);
server.tool('forget', forgetDescription, forgetSchema, handleForget);
const reflectTool = server.tool('reflect', reflectDescription, reflectSchema, handleReflect);
const memoriesTool = server.tool('memories', memoriesDescription, memoriesSchema, handleMemories);
server.tool('category_create', categoryCreateDescription, categoryCreateSchema, handleCategoryCreate);
server.tool('category_update', categoryUpdateDescription, categoryUpdateSchema, handleCategoryUpdate);
server.tool('category_delete', categoryDeleteDescription, categoryDeleteSchema, handleCategoryDelete);
server.tool('category_list', categoryListDescription, categoryListSchema, handleCategoryList);

// Refresh all tool schemas that reference category descriptions.
// Called after any category change so Claude sees updated guidelines.
export function refreshCategorySchemas() {
  invalidateCategoryCache();
  rememberTool.update({ paramsSchema: buildRememberSchema() });
  recallTool.update({ paramsSchema: buildRecallSchema() });
  reflectTool.update({ paramsSchema: buildReflectSchema() });
  memoriesTool.update({ paramsSchema: buildMemoriesSchema() });
}

async function main() {
  try {
    await ensureCollection();
  } catch (err) {
    console.error(
      'Warning: Could not connect to Qdrant on startup.',
      err instanceof Error ? err.message : err
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error starting memory server:', err);
  process.exit(1);
});
