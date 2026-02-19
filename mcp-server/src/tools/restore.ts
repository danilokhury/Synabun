import { z } from 'zod';
import { restoreMemory, getMemory } from '../services/qdrant.js';
import type { MemoryPayload } from '../types.js';

export const restoreSchema = {
  memory_id: z
    .string()
    .describe(
      'The memory ID to restore from trash. Use the full UUID.'
    ),
};

export const restoreDescription =
  'Restore a trashed memory by ID. Use this to undo a forget operation.';

export async function handleRestore(args: { memory_id: string }) {
  const memoryId = args.memory_id;

  const existing = await getMemory(memoryId);
  if (!existing) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory "${memoryId}" not found.`,
        },
      ],
    };
  }

  const payload = existing.payload as unknown as MemoryPayload;

  if (!payload.trashed_at) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory [${memoryId.slice(0, 8)}] is not in trash.`,
        },
      ],
    };
  }

  await restoreMemory(memoryId);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Restored [${memoryId.slice(0, 8)}]: "${payload.content.slice(0, 80)}..."`,
      },
    ],
  };
}
