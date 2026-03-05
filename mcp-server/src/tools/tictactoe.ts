import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  tictactoeSchema, tictactoeDescription, handleTictactoe,
} from './tictactoe-tools.js';

/**
 * Register the TicTacToe MCP tool on the given server instance.
 * Single tool with action-based dispatch: start, move, state, end.
 */
export function registerTicTacToeTools(server: McpServer) {
  server.tool('tictactoe', tictactoeDescription, tictactoeSchema, handleTictactoe);
}
