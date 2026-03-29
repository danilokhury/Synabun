/**
 * General-purpose image staging MCP tools.
 * Browse, list, and manage images in SynaBun's data/images/ directory.
 * Images arrive via paste in the Neural Interface chat area.
 * Any skill or tool can use staged images (Leonardo references, social posts, etc.).
 */
import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';
// ═══════════════════════════════════════════
// image_staged — list, clear, remove staged images
// ═══════════════════════════════════════════
export const imageStagedSchema = {
    action: z.enum(['list', 'clear', 'remove']).describe('Action: "list" = show all images with paths. "clear" = delete all attachment images. "remove" = delete a specific image.'),
    filename: z.string().optional().describe('Filename to remove (for "remove" action).'),
    type: z.enum(['all', 'attachment', 'screenshot', 'whiteboard', 'paste']).optional().describe('Filter by image type. Default: "all". "attachment" = images pasted in chat.'),
};
export const imageStagedDescription = 'List, clear, or remove images from SynaBun\'s image store (data/images/). Images arrive when users paste them in the Neural Interface chat. ' +
    'Use "list" to see available images with their full absolute paths — these paths can be passed to browser_upload, Read, or any tool that accepts file paths. ' +
    'Use "clear" to delete all attachment-type images (auto-clear after use). Use "remove" to delete a specific file.';
export async function handleImageStaged(args) {
    const { action, filename, type } = args;
    if (action === 'list') {
        const result = await ni.listImages();
        if (result.error)
            return text(`Failed to list images: ${result.error}`);
        const images = (result.images || []);
        if (images.length === 0)
            return text('No images in store.');
        // Filter by type if requested
        const filter = type || 'all';
        const filtered = filter === 'all' ? images : images.filter(i => i.type === filter);
        if (filtered.length === 0)
            return text(`No images of type "${filter}" found.`);
        const lines = filtered.map((img, i) => {
            const sizeKb = Math.round(img.size / 1024);
            const age = _relativeAge(img.modifiedAt);
            const path = img.path || img.filename;
            return `${i + 1}. [${img.type}] ${img.filename} (${sizeKb}KB, ${age})\n   Path: ${path}`;
        });
        return text(`Images: ${filtered.length}${filter !== 'all' ? ` (${filter})` : ''}\n\n${lines.join('\n\n')}`);
    }
    if (action === 'remove') {
        if (!filename)
            return text('Filename required for "remove" action.');
        const result = await ni.deleteImage(filename);
        if (result.error)
            return text(`Failed to remove: ${result.error}`);
        return text(`Removed: ${filename}`);
    }
    if (action === 'clear') {
        // List all attachment images, then delete each
        const result = await ni.listImages();
        if (result.error)
            return text(`Failed to list images: ${result.error}`);
        const images = (result.images || []);
        const attachments = images.filter(i => i.type === 'attachment');
        if (attachments.length === 0)
            return text('No attachment images to clear.');
        let removed = 0;
        for (const img of attachments) {
            const r = await ni.deleteImage(img.filename);
            if (!r.error)
                removed++;
        }
        return text(`Cleared ${removed}/${attachments.length} attachment image(s).`);
    }
    return text(`Unknown action: ${action}`);
}
function _relativeAge(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000)
        return 'just now';
    if (diff < 3600000)
        return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000)
        return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
}
//# sourceMappingURL=image-tools.js.map