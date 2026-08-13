import { SQUARES, STARTING_POSITION } from "./constants";
import type { Board, Piece, PieceKind } from "./types";

export function newBoard(): Board {
  return STARTING_POSITION.map((row) => [...row]);
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

export function inBounds(col: number, row: number): boolean {
  return col >= 0 && col < SQUARES && row >= 0 && row < SQUARES;
}

export function getPiece(board: Board, col: number, row: number): Piece {
  return board[row][col];
}

export function setPiece(board: Board, col: number, row: number, piece: Piece): void {
  board[row][col] = piece;
}

export function isEmpty(board: Board, col: number, row: number): boolean {
  return board[row][col] === " ";
}

/** Lowercase is white. See the note in types.ts — this is not the FEN convention. */
export function isWhitePiece(p: Piece): boolean {
  return p !== " " && p === p.toLowerCase();
}

export function isBlackPiece(p: Piece): boolean {
  return p !== " " && p === p.toUpperCase();
}

export function kindOf(p: Piece): PieceKind | null {
  return p === " " ? null : (p.toLowerCase() as PieceKind);
}

/** Recolour a piece letter to the given side. */
export function asSide(kind: PieceKind, white: boolean): Piece {
  return (white ? kind : kind.toUpperCase()) as Piece;
}

export function pieceIsSide(board: Board, col: number, row: number, white: boolean): boolean {
  const p = board[row][col];
  if (p === " ") return false;
  return white ? isWhitePiece(p) : isBlackPiece(p);
}

export function findKing(board: Board, white: boolean): [number, number] | null {
  const k: Piece = white ? "k" : "K";
  for (let r = 0; r < SQUARES; r++) {
    for (let c = 0; c < SQUARES; c++) if (board[r][c] === k) return [c, r];
  }
  return null;
}

/** Every square holding a piece, as [col, row]. */
export function occupiedSquares(board: Board): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 0; r < SQUARES; r++) {
    for (let c = 0; c < SQUARES; c++) if (board[r][c] !== " ") out.push([c, r]);
  }
  return out;
}

export function emptySquares(board: Board): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 0; r < SQUARES; r++) {
    for (let c = 0; c < SQUARES; c++) if (board[r][c] === " ") out.push([c, r]);
  }
  return out;
}

export function countPieces(board: Board): number {
  let n = 0;
  for (let r = 0; r < SQUARES; r++) {
    for (let c = 0; c < SQUARES; c++) if (board[r][c] !== " ") n++;
  }
  return n;
}
