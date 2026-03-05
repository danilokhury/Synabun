import { z } from 'zod';
import { softDeleteMemory, getMemory } from '../services/sqlite.js';
import { invalidateCache } from '../services/neural-interface.js';
export const forgetSchema = {
    memory_id: z
        .string()
        .describe('The memory ID to move to trash. Use the full UUID from recall results.'),
};
export const forgetDescription = 'Move a specific memory to trash by ID. The memory can be restored from the Neural Interface trash panel or via the restore tool. Use this to clean up outdated, incorrect, or superseded information.';
export async function handleForget(args) {
    const memoryId = args.memory_id;
    const existing = await getMemory(memoryId);
    if (!existing) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Memory "${memoryId}" not found. Use recall to search for the memory first.`,
                },
            ],
        };
    }
    const payload = existing.payload;
    if (payload.trashed_at) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Memory [${memoryId.slice(0, 8)}] is already in trash (trashed ${payload.trashed_at}).`,
                },
            ],
        };
    }
    await softDeleteMemory(memoryId);
    // Invalidate Neural Interface link cache (fire-and-forget)
    invalidateCache('forget');
    return {
        content: [
            {
                type: 'text',
                text: `Moved to trash [${memoryId.slice(0, 8)}]: "${(payload.content ?? '(empty)').slice(0, 80)}..." — can be restored from the Neural Interface trash panel or via the restore tool.`,
            },
        ],
    };
}
//# sourceMappingURL=forget.js.map