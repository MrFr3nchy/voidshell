/**
 * A chess position, and the one function that advances it.
 *
 * Kept separate from `GameState` so that the chess underneath the game is a
 * pure value transformation with nothing else attached — which is what lets
 * the perft harness exercise the very code the game plays through, rather than
 * a reimplementation of it that could drift.
 */

import { cloneBoard, isWhitePiece, newBoard } from "./board";
import { allLegalMoves, isKingInCheck, noLegalMoves, rightsAfter } from "./moves";
import { defaultCastlingRights } from "./constants";
import type { Board, CastlingRights, EnPassant, Move, Piece } from "./types";

export interface Position {
  board: Board;
  whiteToMove: boolean;
  rights: CastlingRights;
  ep: EnPassant;
}

export function initialPosition(): Position {
  return {
    board: newBoard(),
    whiteToMove: true,
    rights: defaultCastlingRights(),
    ep: null,
  };
}

/** What a move did, beyond moving the piece. */
export interface MoveEffects {
  captured: Piece;
  /** Where the captured piece stood — not the destination, for en passant. */
  capturedAt: { col: number; row: number } | null;
  castled: "kingside" | "queenside" | null;
  enPassant: boolean;
}

/**
 * Apply `move`, returning the new position and what happened.
 *
 * The board is copied rather than mutated: perft walks a tree, and the game
 * wants an undo-able history. At these depths the copy is not the bottleneck —
 * the legality filter is.
 */
export function applyMove(pos: Position, move: Move): { next: Position; effects: MoveEffects } {
  const { fromCol, fromRow, toCol, toRow, promoteTo } = move;
  const board = cloneBoard(pos.board);
  const piece = board[fromRow][fromCol];
  const white = isWhitePiece(piece);
  const kind = piece.toLowerCase();

  const isEnPassant =
    kind === "p" && pos.ep !== null && pos.ep[0] === toCol && pos.ep[1] === toRow;

  let captured: Piece = " ";
  let capturedAt: MoveEffects["capturedAt"] = null;
  if (isEnPassant) {
    const capRow = toRow + (white ? 1 : -1);
    captured = board[capRow][toCol];
    capturedAt = { col: toCol, row: capRow };
    board[capRow][toCol] = " ";
  } else if (board[toRow][toCol] !== " ") {
    captured = board[toRow][toCol];
    capturedAt = { col: toCol, row: toRow };
  }

  let castled: MoveEffects["castled"] = null;
  if (kind === "k" && fromCol === 4 && Math.abs(toCol - fromCol) === 2) {
    if (toCol === 6) {
      board[toRow][5] = board[toRow][7];
      board[toRow][7] = " ";
      castled = "kingside";
    } else {
      board[toRow][3] = board[toRow][0];
      board[toRow][0] = " ";
      castled = "queenside";
    }
  }

  board[toRow][toCol] = promoteTo ?? piece;
  board[fromRow][fromCol] = " ";

  const doubleStep = kind === "p" && Math.abs(toRow - fromRow) === 2;

  return {
    next: {
      board,
      whiteToMove: !pos.whiteToMove,
      rights: rightsAfter(pos.rights, piece, fromCol, fromRow, toCol, toRow),
      ep: doubleStep ? [toCol, (fromRow + toRow) / 2] : null,
    },
    effects: { captured, capturedAt, castled, enPassant: isEnPassant },
  };
}

export function legalMovesFor(pos: Position): Move[] {
  return allLegalMoves(pos.board, pos.whiteToMove, pos.rights, pos.ep);
}

export function inCheck(pos: Position): boolean {
  return isKingInCheck(pos.board, pos.whiteToMove);
}

/** `null` while the game is live. */
export function outcome(pos: Position): "checkmate" | "stalemate" | null {
  if (!noLegalMoves(pos.board, pos.whiteToMove, pos.rights, pos.ep)) return null;
  return inCheck(pos) ? "checkmate" : "stalemate";
}

export function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const move of legalMovesFor(pos)) {
    nodes += perft(applyMove(pos, move).next, depth - 1);
  }
  return nodes;
}

/**
 * Parse a FEN into a position.
 *
 * **This is where the two conventions meet.** FEN says uppercase is white and
 * lists rank 8 first; the board says lowercase is white and stores rank 8 at
 * row 0. So the ranks line up already and only the case has to flip. Used by
 * the perft harness, which is the only thing that speaks FEN.
 */
export function fromFen(fen: string): Position {
  const [placement, side, castling, epSquare] = fen.trim().split(/\s+/);
  const board: Board = placement.split("/").map((rank) => {
    const row: Piece[] = [];
    for (const ch of rank) {
      if (ch >= "1" && ch <= "8") {
        for (let i = 0; i < Number(ch); i++) row.push(" ");
      } else {
        row.push((ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) as Piece);
      }
    }
    return row;
  });
  const rights: CastlingRights = {
    white_kingside: castling.includes("K"),
    white_queenside: castling.includes("Q"),
    black_kingside: castling.includes("k"),
    black_queenside: castling.includes("q"),
  };
  const ep: EnPassant =
    epSquare && epSquare !== "-"
      ? ["abcdefgh".indexOf(epSquare[0]), 8 - Number(epSquare[1])]
      : null;
  return { board, whiteToMove: side === "w", rights, ep };
}
