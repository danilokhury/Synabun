import { z } from 'zod';
export declare const tictactoeSchema: {
    action: z.ZodEnum<["start", "move", "state", "end"]>;
    cell: z.ZodOptional<z.ZodNumber>;
    piece: z.ZodOptional<z.ZodEnum<["X", "O"]>>;
};
export declare const tictactoeDescription = "Play Tic Tac Toe on the whiteboard. Actions: \"start\" sets up the board (piece defaults to X), \"move\" places the current turn's piece in cell 1-9, \"state\" shows the current board, \"end\" closes the game. The board renders visually on the whiteboard. X always goes first. Returns ASCII board + game status after each action.";
export declare function handleTictactoe(args: {
    action: string;
    cell?: number;
    piece?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=tictactoe-tools.d.ts.map