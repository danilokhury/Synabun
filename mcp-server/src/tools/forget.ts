import { z } from 'zod';
import { deleteMemory, getMemory } from '../services/qdrant.js';
import type { MemoryPayload } from '../types.js';

export const forgetSchema = {
  memory_id: z
    .string()
    .describe(
      'The memory ID to delete. Use the full UUID from recall results.'
    ),
};

export const forgetDescription =
  'Remove a specific memory by ID. Use this to clean up outdated, incorrect, or superseded information.';

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
  await deleteMemory(memoryId);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Forgotten [${memoryId.slice(0, 8)}]: "${payload.content.slice(0, 80)}..."`,
      },
    ],
  };
}
