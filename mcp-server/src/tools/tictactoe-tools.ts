import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';

// ═══════════════════════════════════════════
// tictactoe — Dedicated TicTacToe MCP tool
// ═══════════════════════════════════════════

export const tictactoeSchema = {
  action: z.enum(['start', 'move', 'state', 'end']).describe(
    'Game action. "start" = set up board (optional piece: X or O). "move" = place piece (requires cell 1-9). "state" = get current board. "end" = tear down game.'
  ),
  cell: z.number().min(1).max(9).optional().describe(
    'Cell number 1-9 (required for "move" action). Layout:\n  1 | 2 | 3\n  ---------\n  4 | 5 | 6\n  ---------\n  7 | 8 | 9'
  ),
  piece: z.enum(['X', 'O']).optional().describe(
    'Which piece you play as (for "start" action). Default: X. X always goes first.'
  ),
};

export const tictactoeDescription =
  'Play Tic Tac Toe on the whiteboard. Actions: "start" sets up the board (piece defaults to X), "move" places the current turn\'s piece in cell 1-9, "state" shows the current board, "end" closes the game. The board renders visually on the whiteboard. X always goes first. Returns ASCII board + game status after each action.';

export async function handleTictactoe(args: { action: string; cell?: number; piece?: string }) {
  switch (args.action) {
    case 'start':
      return handleStart(args.piece);
    case 'move':
      return handleMove(args.cell);
    case 'state':
      return handleState();
    case 'end':
      return handleEnd();
    default:
      return text(`Unknown action: ${args.action}`);
  }
}

async function handleStart(piece?: string) {
  const result = await ni.tictactoeStart(piece);
  if (result.error) {
    return text(`Failed to start game: ${result.error}`);
  }

  const msg = `Game started! You are ${result.piece}.\n\n${result.ascii}\n\nTurn: ${result.turn} | Status: ${result.status}`;
  return text(msg);
}

async function handleMove(cell?: number) {
  if (cell === undefined) {
    return text('cell is required for move action (1-9)');
  }

  const result = await ni.tictactoeMove(cell);
  if (result.error) {
    return text(`Move failed: ${result.error}`);
  }

  let statusLine = `Turn: ${result.turn} | Status: ${result.status}`;
  if (result.winner) {
    statusLine = `Status: ${result.winner} wins!`;
  } else if (result.status === 'draw') {
    statusLine = 'Status: draw';
  }

  const msg = `${result.ascii}\n\n${statusLine}`;
  return text(msg);
}

async function handleState() {
  const result = await ni.tictactoeState();
  if (result.error) {
    return text(`Failed to get state: ${result.error}`);
  }

  if (!result.active) {
    return text('No active TicTacToe game. Use action "start" to begin.');
  }

  let statusLine = `Turn: ${result.turn} | Status: ${result.status} | You are: ${result.piece}`;
  if (result.winner) {
    statusLine = `Status: ${result.winner} wins! | You were: ${result.piece}`;
  } else if (result.status === 'draw') {
    statusLine = `Status: draw | You were: ${result.piece}`;
  }

  const msg = `${result.ascii}\n\n${statusLine}`;
  return text(msg);
}

async function handleEnd() {
  const result = await ni.tictactoeEnd();
  if (result.error) {
    return text(`Failed to end game: ${result.error}`);
  }

  return text('Game ended. Board cleared.');
}
