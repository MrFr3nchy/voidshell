import type { Board, CastlingRights, Piece, PieceKind } from "./types";

export const SQUARES = 8;

export const PIECE_VALUES: Record<PieceKind, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** The cap on each side's chaos meter. Both ultimates and cards spend from it. */
export const CHAOS_MAX = 100;

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** Turn numbers at which the deck and the shop come online. */
export const DECK_TURN = 8;
export const SHOP_TURN = 4;

export const EXTRA_DRAW_COST = 3;
export const MAX_PLAYS_PER_TURN = 1;

export const STARTING_POSITION: Board = [
  ["R", "N", "B", "Q", "K", "B", "N", "R"],
  ["P", "P", "P", "P", "P", "P", "P", "P"],
  [" ", " ", " ", " ", " ", " ", " ", " "],
  [" ", " ", " ", " ", " ", " ", " ", " "],
  [" ", " ", " ", " ", " ", " ", " ", " "],
  [" ", " ", " ", " ", " ", " ", " ", " "],
  ["p", "p", "p", "p", "p", "p", "p", "p"],
  ["r", "n", "b", "q", "k", "b", "n", "r"],
];

export function defaultCastlingRights(): CastlingRights {
  return {
    white_kingside: true,
    white_queenside: true,
    black_kingside: true,
    black_queenside: true,
  };
}

export function pieceValue(ch: Piece): number {
  if (ch === " ") return 0;
  return PIECE_VALUES[ch.toLowerCase() as PieceKind] ?? 0;
}

/** Algebraic name of a square, for the move log. */
export function squareName(col: number, row: number): string {
  return `${FILES[col]}${SQUARES - row}`;
}

/**
 * The board's own colours, carried over from the original so the game looks
 * like itself. Everything *around* the board — panel, text, accents — comes
 * from `ctx.stage.palette()` instead, so the app still sits inside the theme.
 */
export const LIGHT_SQUARE = "#f0d9b5";
export const DARK_SQUARE = "#b58863";
export const HIGHLIGHT_SEL = "#f6f669";
export const HIGHLIGHT_MOVE = "#7fc97f";
export const HIGHLIGHT_CAP = "#e05c5c";
export const CHECK_TINT = "#e05c5c";
