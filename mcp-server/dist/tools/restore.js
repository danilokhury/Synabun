import { z } from 'zod';
import { restoreMemory, getMemory } from '../services/sqlite.js';
export const restoreSchema = {
    memory_id: z
        .string()
        .describe('The memory ID to restore from trash. Use the full UUID.'),
};
export const restoreDescription = 'Restore a trashed memory by ID. Use this to undo a forget operation.';
export async function handleRestore(args) {
    const memoryId = args.memory_id;
    const existing = await getMemory(memoryId);
    if (!existing) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Memory "${memoryId}" not found.`,
                },
            ],
        };
    }
    const payload = existing.payload;
    if (!payload.trashed_at) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Memory [${memoryId.slice(0, 8)}] is not in trash.`,
                },
            ],
        };
    }
    await restoreMemory(memoryId);
    return {
        content: [
            {
                type: 'text',
                text: `Restored [${memoryId.slice(0, 8)}]: "${payload.content.slice(0, 80)}..."`,
            },
        ],
    };
}
//# sourceMappingURL=restore.js.map