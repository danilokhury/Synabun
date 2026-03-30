/**
 * Image MCP tool registration barrel.
 * General-purpose image staging — list, clear, and manage images in data/images/.
 */
import { imageStagedSchema, imageStagedDescription, handleImageStaged, } from './image-tools.js';
/**
 * Register all image MCP tools on the given server instance.
 */
export function registerImageTools(server) {
    server.tool('image_staged', imageStagedDescription, imageStagedSchema, handleImageStaged);
}
//# sourceMappingURL=image.js.map