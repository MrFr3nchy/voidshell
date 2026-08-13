/**
 * Chess movement, underneath the chaos.
 *
 * Pawnageddon's rules break the game open on purpose, but they break it
 * *relative to chess* — so the layer they act on has to be real chess or none
 * of the deviations mean anything. This file is therefore held to published
 * perft counts (`tools/pawnageddon-perft.mts`), not to "looks about right".
 *
 * It was measured before it was ported, and the answer was worth having: the
 * original generator is correct. It matches every published node count at the
 * five standard positions, with one exception that turned out to be a real
 * bug and is fixed below — see `legalTargets`.
 *
 * Two structural notes:
 *
 * **A target square is not a move.** The generator answers "where may this
 * piece go", which is what a board UI wants for highlighting. A *promotion* is
 * four different moves onto one square, so anything counting moves — perft,
 * the bot — has to expand them. `allLegalMoves` is that expansion, and it
 * exists precisely so nothing has to remember to do it by hand.
 *
 * **Attack detection is not move generation.** The original asked "can this
 * piece move to that square" to decide whether a square was attacked, which is
 * subtly wrong for pawns in both directions: a pawn attacks both its forward
 * diagonals whether or not anything is standing on them, and a pawn's push
 * attacks nothing at all. `attacked` implements the real rule.
 */

import { SQUARES } from "./constants";
import { findKing, inBounds, isWhitePiece, pieceIsSide } from "./board";
import type { Board, CastlingRights, EnPassant, Move, Piece } from "./types";

const KNIGHT_OFFSETS: [number, number][] = [
  [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2],
];
const KING_OFFSETS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];
const ROOK_DIRS: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const BISHOP_DIRS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** The key a target square is held under. `"3,4"` is col 3, row 4. */
export function moveKey(col: number, row: number): string {
  return `${col},${row}`;
}

export function parseMoveKey(key: string): [number, number] {
  const [c, r] = key.split(",").map(Number);
  return [c, r];
}

/** White pawns move up the board (row decreasing), black pawns down. */
function forward(white: boolean): number {
  return white ? -1 : 1;
}

/** The row a side's pawns start on. */
function pawnStartRow(white: boolean): number {
  return white ? 6 : 1;
}

/** The row a side's pawns promote on. */
export function promotionRow(white: boolean): number {
  return white ? 0 : 7;
}

function mine(p: Piece, white: boolean): boolean {
  return p !== " " && isWhitePiece(p) === white;
}

function enemy(p: Piece, white: boolean): boolean {
  return p !== " " && isWhitePiece(p) !== white;
}

/**
 * Is (col,row) attacked by `byWhite`?
 *
 * Scanned outward from the square rather than by generating every enemy move,
 * which is the same answer for a fraction of the work — and the work matters,
 * because this runs inside the legality filter for every candidate move.
 */
export function attacked(board: Board, col: number, row: number, byWhite: boolean): boolean {
  // Step *back* along the attacker's forward direction to find its square.
  const back = -forward(byWhite);
  for (const dc of [-1, 1]) {
    const c = col + dc;
    const r = row + back;
    if (inBounds(c, r) && board[r][c] === (byWhite ? "p" : "P")) return true;
  }
  for (const [dc, dr] of KNIGHT_OFFSETS) {
    const c = col + dc;
    const r = row + dr;
    if (inBounds(c, r) && board[r][c] === (byWhite ? "n" : "N")) return true;
  }
  for (const [dc, dr] of KING_OFFSETS) {
    const c = col + dc;
    const r = row + dr;
    if (inBounds(c, r) && board[r][c] === (byWhite ? "k" : "K")) return true;
  }
  const rays: [[number, number][], string][] = [[ROOK_DIRS, "rq"], [BISHOP_DIRS, "bq"]];
  for (const [dirs, kinds] of rays) {
    for (const [dc, dr] of dirs) {
      let c = col + dc;
      let r = row + dr;
      while (inBounds(c, r)) {
        const p = board[r][c];
        if (p !== " ") {
          if (mine(p, byWhite) && kinds.includes(p.toLowerCase())) return true;
          break;
        }
        c += dc;
        r += dr;
      }
    }
  }
  return false;
}

export function isKingInCheck(board: Board, white: boolean): boolean {
  const pos = findKing(board, white);
  if (!pos) return false;
  return attacked(board, pos[0], pos[1], !white);
}

/** Target squares for the piece on (col,row), ignoring whether the king is left hanging. */
export function pseudoLegalTargets(
  board: Board,
  col: number,
  row: number,
  rights: CastlingRights,
  ep: EnPassant
): Set<string> {
  const piece = board[row][col];
  const out = new Set<string>();
  if (piece === " ") return out;

  const white = isWhitePiece(piece);
  const kind = piece.toLowerCase();

  if (kind === "p") {
    const fwd = forward(white);
    if (inBounds(col, row + fwd) && board[row + fwd][col] === " ") {
      out.add(moveKey(col, row + fwd));
      if (row === pawnStartRow(white) && board[row + 2 * fwd][col] === " ") {
        out.add(moveKey(col, row + 2 * fwd));
      }
    }
    for (const dc of [-1, 1]) {
      const c = col + dc;
      const r = row + fwd;
      if (!inBounds(c, r)) continue;
      if (enemy(board[r][c], white)) out.add(moveKey(c, r));
      else if (ep && ep[0] === c && ep[1] === r) out.add(moveKey(c, r));
    }
  } else if (kind === "n") {
    for (const [dc, dr] of KNIGHT_OFFSETS) {
      const c = col + dc;
      const r = row + dr;
      if (inBounds(c, r) && !mine(board[r][c], white)) out.add(moveKey(c, r));
    }
  } else if (kind === "k") {
    for (const [dc, dr] of KING_OFFSETS) {
      const c = col + dc;
      const r = row + dr;
      if (inBounds(c, r) && !mine(board[r][c], white)) out.add(moveKey(c, r));
    }
    castlingTargets(board, col, row, white, rights, out);
  } else {
    const dirs =
      kind === "r" ? ROOK_DIRS : kind === "b" ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
    for (const [dc, dr] of dirs) {
      let c = col + dc;
      let r = row + dr;
      while (inBounds(c, r)) {
        const p = board[r][c];
        if (p === " ") out.add(moveKey(c, r));
        else {
          if (enemy(p, white)) out.add(moveKey(c, r));
          break;
        }
        c += dc;
        r += dr;
      }
    }
  }
  return out;
}

function castlingTargets(
  board: Board,
  col: number,
  row: number,
  white: boolean,
  rights: CastlingRights,
  out: Set<string>
): void {
  const home = white ? 7 : 0;
  if (col !== 4 || row !== home) return;
  // Castling out of check is illegal, and it is cheaper to ask once here than
  // to let the legality filter discover it twice.
  if (attacked(board, 4, home, !white)) return;

  const rook: Piece = white ? "r" : "R";
  const kingside = white ? rights.white_kingside : rights.black_kingside;
  const queenside = white ? rights.white_queenside : rights.black_queenside;

  if (
    kingside &&
    board[home][5] === " " &&
    board[home][6] === " " &&
    board[home][7] === rook &&
    !attacked(board, 5, home, !white) &&
    !attacked(board, 6, home, !white)
  ) {
    out.add(moveKey(6, home));
  }
  if (
    queenside &&
    board[home][1] === " " &&
    board[home][2] === " " &&
    board[home][3] === " " &&
    board[home][0] === rook &&
    !attacked(board, 3, home, !white) &&
    !attacked(board, 2, home, !white)
  ) {
    out.add(moveKey(2, home));
  }
}

/**
 * Target squares that don't leave your own king in check.
 *
 * The en-passant guard on the moving piece is the bug the perft run found, and
 * it is worth naming because it cost a legal move rather than merely miscounting
 * one. The original cleared the pawn behind the en-passant square whenever
 * *anything* landed there, so simulating a knight's move onto that square also
 * deleted a pawn — and if that pawn happened to be blocking a bishop, the
 * simulation reported a check that does not exist and the knight move was
 * discarded. It is a one-line condition and the position it breaks
 * (`r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1` after Nf3d4 c7c5) is
 * pinned in the perft harness.
 */
export function legalTargets(
  board: Board,
  col: number,
  row: number,
  rights: CastlingRights,
  ep: EnPassant
): Set<string> {
  const piece = board[row][col];
  const legal = new Set<string>();
  if (piece === " ") return legal;

  const white = isWhitePiece(piece);
  const isPawn = piece.toLowerCase() === "p";

  for (const key of pseudoLegalTargets(board, col, row, rights, ep)) {
    const [tc, tr] = parseMoveKey(key);
    const trial = board.map((r) => [...r]);
    trial[tr][tc] = piece;
    trial[row][col] = " ";
    // Only a pawn captures en passant.
    if (isPawn && ep && tc === ep[0] && tr === ep[1]) {
      trial[tr + (white ? 1 : -1)][tc] = " ";
    }
    // Castling moves the rook too, and the rook's new square can matter to a
    // discovered check along the back rank.
    if (piece.toLowerCase() === "k" && col === 4 && Math.abs(tc - col) === 2) {
      if (tc === 6) {
        trial[tr][5] = trial[tr][7];
        trial[tr][7] = " ";
      } else {
        trial[tr][3] = trial[tr][0];
        trial[tr][0] = " ";
      }
    }
    if (!isKingInCheck(trial, white)) legal.add(key);
  }
  return legal;
}

/**
 * Every legal move for `white`, with promotions expanded into their four
 * choices. This is the list to count, search or play at random; `legalTargets`
 * is the one to highlight.
 */
export function allLegalMoves(
  board: Board,
  white: boolean,
  rights: CastlingRights,
  ep: EnPassant
): Move[] {
  const out: Move[] = [];
  const back = promotionRow(white);
  for (let r = 0; r < SQUARES; r++) {
    for (let c = 0; c < SQUARES; c++) {
      if (!pieceIsSide(board, c, r, white)) continue;
      const isPawn = board[r][c].toLowerCase() === "p";
      for (const key of legalTargets(board, c, r, rights, ep)) {
        const [tc, tr] = parseMoveKey(key);
        if (isPawn && tr === back) {
          for (const kind of ["q", "r", "b", "n"]) {
            out.push({
              fromCol: c,
              fromRow: r,
              toCol: tc,
              toRow: tr,
              promoteTo: (white ? kind : kind.toUpperCase()) as Piece,
            });
          }
        } else {
          out.push({ fromCol: c, fromRow: r, toCol: tc, toRow: tr });
        }
      }
    }
  }
  return out;
}

export function noLegalMoves(
  board: Board,
  white: boolean,
  rights: CastlingRights,
  ep: EnPassant
): boolean {
  for (let r = 0; r < SQUARES; r++) {
    for (let c = 0; c < SQUARES; c++) {
      if (!pieceIsSide(board, c, r, white)) continue;
      if (legalTargets(board, c, r, rights, ep).size > 0) return false;
    }
  }
  return true;
}

/**
 * Castling rights after a move, given the squares it touched.
 *
 * The `to` half is the one the original missed: capturing a rook on its home
 * square ends that side's right just as surely as moving it does, and perft
 * catches the omission four nodes deep from the opening position.
 */
export function rightsAfter(
  rights: CastlingRights,
  piece: Piece,
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number
): CastlingRights {
  const next = { ...rights };
  const kind = piece.toLowerCase();
  if (kind === "k") {
    if (isWhitePiece(piece)) {
      next.white_kingside = false;
      next.white_queenside = false;
    } else {
      next.black_kingside = false;
      next.black_queenside = false;
    }
  }
  const corners: [number, number, keyof CastlingRights][] = [
    [0, 7, "white_queenside"],
    [7, 7, "white_kingside"],
    [0, 0, "black_queenside"],
    [7, 0, "black_kingside"],
  ];
  for (const [c, r, key] of corners) {
    if ((fromCol === c && fromRow === r) || (toCol === c && toRow === r)) next[key] = false;
  }
  return next;
}
