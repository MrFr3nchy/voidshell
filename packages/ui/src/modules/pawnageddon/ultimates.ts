/**
 * Per-piece ultimates: the chaos meter spent for one large, rule-breaking act.
 *
 * Each returns the squares it swept as `path`, which the view traces as an
 * animation. The board is mutated in place, because an ultimate is applied to
 * the live game rather than searched over.
 */

import { emptySquares, isWhitePiece } from "./board";
import { PIECE_VALUES } from "./constants";
import type { Piece, PieceKind, Ultimate, UltimateResult } from "./types";

const empty = (): UltimateResult => ({ destroyed: [], spawned: [], path: [] });

const inBoard = (c: number, r: number) => c >= 0 && c < 8 && r >= 0 && r < 8;

export const ULTIMATES: Record<PieceKind, Ultimate> = {
  p: {
    name: "Cannonball",
    icon: "💣",
    desc: "Fires a cannonball up the file — destroys every piece in its path.",
    chaosCost: 20,
    apply(board, col, row, isWhite) {
      const out = empty();
      const dir = isWhite ? -1 : 1;
      for (let r = row + dir; r >= 0 && r < 8; r += dir) {
        out.path.push([col, r]);
        const p = board[r][col];
        if (p !== " ") {
          out.destroyed.push({ col, row: r, piece: p });
          board[r][col] = " ";
        }
      }
      return out;
    },
  },

  n: {
    name: "Cavalry Charge",
    icon: "⚡",
    desc: "Charges all eight L-positions at once, destroying whatever it reaches.",
    chaosCost: 25,
    apply(board, col, row) {
      const out = empty();
      const jumps: [number, number][] = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1],
      ];
      for (const [dc, dr] of jumps) {
        const c = col + dc;
        const r = row + dr;
        if (!inBoard(c, r)) continue;
        out.path.push([c, r]);
        const p = board[r][c];
        if (p !== " ") {
          out.destroyed.push({ col: c, row: r, piece: p });
          board[r][c] = " ";
        }
      }
      return out;
    },
  },

  b: {
    name: "Sacred Flame",
    icon: "🔥",
    desc: "Ignites all four diagonals up to four squares — burns enemy pieces only.",
    chaosCost: 25,
    apply(board, col, row, isWhite) {
      const out = empty();
      for (const [dc, dr] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as [number, number][]) {
        for (let i = 1; i <= 4; i++) {
          const c = col + dc * i;
          const r = row + dr * i;
          if (!inBoard(c, r)) break;
          out.path.push([c, r]);
          const p = board[r][c];
          if (p !== " ") {
            // The flame stops at the first piece either way; it only consumes
            // the piece if it is an enemy.
            if (isWhitePiece(p) !== isWhite) {
              out.destroyed.push({ col: c, row: r, piece: p });
              board[r][c] = " ";
            }
            break;
          }
        }
      }
      return out;
    },
  },

  r: {
    name: "Tower Collapse",
    icon: "💥",
    desc: "The tower falls — destroys every piece in its rank and its file.",
    chaosCost: 30,
    apply(board, col, row) {
      const out = empty();
      for (let c = 0; c < 8; c++) {
        if (c === col) continue;
        out.path.push([c, row]);
        const p = board[row][c];
        if (p !== " ") {
          out.destroyed.push({ col: c, row, piece: p });
          board[row][c] = " ";
        }
      }
      for (let r = 0; r < 8; r++) {
        if (r === row) continue;
        out.path.push([col, r]);
        const p = board[r][col];
        if (p !== " ") {
          out.destroyed.push({ col, row: r, piece: p });
          board[r][col] = " ";
        }
      }
      return out;
    },
  },

  q: {
    name: "Chaos Nova",
    icon: "🌀",
    desc: "Releases a nova — destroys everything within two squares.",
    chaosCost: 35,
    apply(board, col, row) {
      const out = empty();
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (dr === 0 && dc === 0) continue;
          const c = col + dc;
          const r = row + dr;
          if (!inBoard(c, r)) continue;
          out.path.push([c, r]);
          const p = board[r][c];
          if (p !== " ") {
            out.destroyed.push({ col: c, row: r, piece: p });
            board[r][c] = " ";
          }
        }
      }
      return out;
    },
  },

  k: {
    name: "Royal Edict",
    icon: "👑",
    desc: "Resurrects your two most valuable lost pieces onto empty squares.",
    chaosCost: 40,
    apply(board, _col, _row, isWhite, capturedWhite, capturedBlack, rng) {
      const out = empty();
      const lost = [...(isWhite ? capturedWhite : capturedBlack)];
      lost.sort(
        (a, b) =>
          (PIECE_VALUES[b.toLowerCase() as PieceKind] ?? 0) -
          (PIECE_VALUES[a.toLowerCase() as PieceKind] ?? 0)
      );
      const slots = emptySquares(board);
      const n = Math.min(2, lost.length, slots.length);
      for (let i = 0; i < n; i++) {
        const piece = lost[i];
        const idx = Math.floor(rng() * slots.length);
        const [c, r] = slots.splice(idx, 1)[0];
        board[r][c] = piece;
        out.spawned.push({ col: c, row: r, piece });
      }
      return out;
    },
  },
};

export function getUltimate(piece: Piece): Ultimate | null {
  if (piece === " ") return null;
  return ULTIMATES[piece.toLowerCase() as PieceKind] ?? null;
}
