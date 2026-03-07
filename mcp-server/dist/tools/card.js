import { cardListSchema, cardListDescription, handleCardList, cardOpenSchema, cardOpenDescription, handleCardOpen, cardCloseSchema, cardCloseDescription, handleCardClose, cardUpdateSchema, cardUpdateDescription, handleCardUpdate, cardScreenshotSchema, cardScreenshotDescription, handleCardScreenshot, } from './card-tools.js';
/**
 * Register all 5 card MCP tools on the given server instance.
 * These tools let Claude list, open, close, move/resize/compact/pin,
 * and screenshot memory cards in the Neural Interface.
 */
export function registerCardTools(server) {
    server.tool('card_list', cardListDescription, cardListSchema, handleCardList);
    server.tool('card_open', cardOpenDescription, cardOpenSchema, handleCardOpen);
    server.tool('card_close', cardCloseDescription, cardCloseSchema, handleCardClose);
    server.tool('card_update', cardUpdateDescription, cardUpdateSchema, handleCardUpdate);
    server.tool('card_screenshot', cardScreenshotDescription, cardScreenshotSchema, handleCardScreenshot);
}
//# sourceMappingURL=card.js.map