import { z } from 'zod';
import { softDeleteMemory, getMemory } from '../services/qdrant.js';
import type { MemoryPayload } from '../types.js';

export const forgetSchema = {
  memory_id: z
    .string()
    .describe(
      'The memory ID to move to trash. Use the full UUID from recall results.'
    ),
};

export const forgetDescription =
  'Move a specific memory to trash by ID. The memory can be restored from the Neural Interface trash panel or via the restore tool. Use this to clean up outdated, incorrect, or superseded information.';

export async function handleForget(args: { memory_id: string }) {
  const memoryId = args.memory_id;

  const existing = await getMemory(memoryId);
  if (!existing) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory "${memoryId}" not found. Use recall to search for the memory first.`,
        },
      ],
    };
  }

  const payload = existing.payload as unknown as MemoryPayload;

  if (payload.trashed_at) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory [${memoryId.slice(0, 8)}] is already in trash (trashed ${payload.trashed_at}).`,
        },
      ],
    };
  }

  await softDeleteMemory(memoryId);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Moved to trash [${memoryId.slice(0, 8)}]: "${(payload.content ?? '(empty)').slice(0, 80)}..." — can be restored from the Neural Interface trash panel or via the restore tool.`,
      },
    ],
  };
}
