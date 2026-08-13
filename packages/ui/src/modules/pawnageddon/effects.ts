/**
 * The effect engine: structured effect records applied to the board.
 *
 * Cards, chaos events, hazards and a couple of the weapons all reduce to the
 * same handful of verbs, which is why the content files are pure data. An
 * effect never decides anything about turn order or resources directly — it
 * reports what it did in an `EffectResult` and the game applies the
 * consequences, so the same record can be replayed, logged or animated.
 */

import { emptySquares, isWhitePiece } from "./board";
import { squareName } from "./constants";
import type {
  Board,
  Effect,
  EffectResult,
  Piece,
  PieceKind,
  ResourceChange,
  Rng,
  TargetSelector,
} from "./types";

export function emptyResult(): EffectResult {
  return {
    destroyed: [],
    spawned: [],
    teleported: [],
    transformed: [],
    goldChanges: { white: 0, black: 0 },
    chaosChanges: { white: 0, black: 0 },
    cardsDrawn: 0,
    hazardsPlaced: [],
    mutationsApplied: [],
    messages: [],
    extraTurns: 0,
  };
}

const inBoard = (c: number, r: number) => c >= 0 && c < 8 && r >= 0 && r < 8;

/** Fisher-Yates, then take the first `n`. */
function sample<T>(arr: T[], n: number, rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function matching(board: Board, selector: TargetSelector, playerWhite: boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p === " ") continue;
      const white = isWhitePiece(p);
      if (selector === "random_self" && white === playerWhite) out.push([c, r]);
      else if (selector === "random_enemy" && white !== playerWhite) out.push([c, r]);
      else if (selector === "random_any" || selector === "any_piece") out.push([c, r]);
      else if (selector === "all_pawns" && p.toLowerCase() === "p") out.push([c, r]);
      else if (selector === "all_pieces") out.push([c, r]);
    }
  }
  return out;
}

function randomEmpty(board: Board, rng: Rng): [number, number] | null {
  const empties = emptySquares(board);
  return empties.length ? empties[Math.floor(rng() * empties.length)] : null;
}

function resolveTargets(
  effect: Effect,
  board: Board,
  playerWhite: boolean,
  chosenPiece: [number, number] | null,
  rng: Rng
): [number, number][] {
  const target = effect.target ?? "random_enemy";
  // These four name a square the caller already picked, rather than describing
  // a set to draw from.
  if (target === "self_piece" || target === "enemy_piece" || target === "any_piece" || target === "chosen_piece") {
    return chosenPiece ? [chosenPiece] : [];
  }
  const pieces = matching(board, target, playerWhite);
  if (target.startsWith("all_")) return pieces;
  const count = effect.count ?? 1;
  return pieces.length ? sample(pieces, Math.min(count, pieces.length), rng) : [];
}

function applyResource(
  changes: ResourceChange,
  who: Effect["player"],
  amount: number,
  callerWhite: boolean
): void {
  if (who === "opponent") changes[callerWhite ? "black" : "white"] += amount;
  else if (who === "both") {
    changes.white += amount;
    changes.black += amount;
  } else changes[callerWhite ? "white" : "black"] += amount;
}

export function applyEffect(
  effect: Effect,
  board: Board,
  playerWhite: boolean,
  result: EffectResult,
  chosenSquare: [number, number] | null,
  chosenPiece: [number, number] | null,
  rng: Rng
): void {
  const targets = () => resolveTargets(effect, board, playerWhite, chosenPiece, rng);

  switch (effect.type) {
    case "destroy": {
      const radius = effect.radius ?? 0;
      for (const [c, r] of targets()) {
        if (radius > 0) {
          for (let dr = -radius; dr <= radius; dr++) {
            for (let dc = -radius; dc <= radius; dc++) {
              const nc = c + dc;
              const nr = r + dr;
              if (!inBoard(nc, nr)) continue;
              const p = board[nr][nc];
              if (p !== " ") {
                board[nr][nc] = " ";
                result.destroyed.push({ col: nc, row: nr, piece: p });
              }
            }
          }
        } else {
          const p = board[r][c];
          if (p !== " ") {
            board[r][c] = " ";
            result.destroyed.push({ col: c, row: r, piece: p });
            result.messages.push(`${p} at ${squareName(c, r)} destroyed`);
          }
        }
      }
      break;
    }

    case "spawn": {
      const kind = (effect.piece ?? "p") as PieceKind;
      const piece = (playerWhite ? kind : kind.toUpperCase()) as Piece;
      const sq = chosenSquare ?? randomEmpty(board, rng);
      if (sq) {
        board[sq[1]][sq[0]] = piece;
        result.spawned.push({ col: sq[0], row: sq[1], piece });
        result.messages.push(`Spawned ${piece} at ${squareName(sq[0], sq[1])}`);
      }
      break;
    }

    case "teleport": {
      for (const [c, r] of targets()) {
        const dest = randomEmpty(board, rng);
        if (!dest) continue;
        const p = board[r][c];
        board[r][c] = " ";
        board[dest[1]][dest[0]] = p;
        result.teleported.push({ fromCol: c, fromRow: r, toCol: dest[0], toRow: dest[1] });
        result.messages.push(
          `${p} teleported ${squareName(c, r)} → ${squareName(dest[0], dest[1])}`
        );
      }
      break;
    }

    case "swap": {
      const pieces = matching(board, effect.target ?? "random_any", playerWhite);
      if (pieces.length >= 2) {
        const [[ac, ar], [bc, br]] = sample(pieces, 2, rng);
        const pa = board[ar][ac];
        const pb = board[br][bc];
        board[ar][ac] = pb;
        board[br][bc] = pa;
        result.teleported.push({ fromCol: ac, fromRow: ar, toCol: bc, toRow: br });
        result.messages.push(`Swapped ${pa} and ${pb}`);
      }
      break;
    }

    case "transform": {
      const into = (effect.into ?? "q") as PieceKind;
      for (const [c, r] of targets()) {
        const old = board[r][c];
        if (old === " ") continue;
        const next = (isWhitePiece(old) ? into : into.toUpperCase()) as Piece;
        board[r][c] = next;
        result.transformed.push({ col: c, row: r, oldPiece: old, newPiece: next });
        result.messages.push(`${old} at ${squareName(c, r)} → ${next}`);
      }
      break;
    }

    case "gold": {
      const amount = effect.amount ?? 1;
      applyResource(result.goldChanges, effect.player ?? "self", amount, playerWhite);
      result.messages.push(`${amount > 0 ? "+" : ""}${amount} gold`);
      break;
    }

    case "chaos":
      applyResource(result.chaosChanges, effect.player ?? "self", effect.amount ?? 1, playerWhite);
      break;

    case "steal_gold": {
      const amount = effect.amount ?? 3;
      applyResource(result.goldChanges, "self", amount, playerWhite);
      applyResource(result.goldChanges, "opponent", -amount, playerWhite);
      result.messages.push(`Stole ${amount} gold`);
      break;
    }

    case "place_hazard": {
      const sq = chosenSquare ?? randomEmpty(board, rng);
      if (sq) {
        const id = effect.hazard_id ?? "fire";
        result.hazardsPlaced.push({ id, col: sq[0], row: sq[1], duration: effect.duration ?? 3 });
        result.messages.push(`Hazard '${id}' placed at ${squareName(sq[0], sq[1])}`);
      }
      break;
    }

    case "freeze":
      for (const [c, r] of targets()) {
        result.mutationsApplied.push({ type: "freeze", col: c, row: r, duration: effect.duration ?? 2 });
        result.messages.push(`Frozen ${squareName(c, r)}`);
      }
      break;

    case "shield":
      for (const [c, r] of targets()) {
        result.mutationsApplied.push({ type: "shield", col: c, row: r, duration: effect.duration ?? 3 });
      }
      break;

    case "clone":
      for (const [c, r] of targets()) {
        const p = board[r][c];
        const sq = randomEmpty(board, rng);
        if (sq && p !== " ") {
          board[sq[1]][sq[0]] = p;
          result.spawned.push({ col: sq[0], row: sq[1], piece: p });
          result.messages.push(`Cloned ${p}`);
        }
      }
      break;

    case "extra_turn":
      result.extraTurns += 1;
      result.messages.push("Extra turn!");
      break;

    case "draw_cards":
      result.cardsDrawn += effect.count ?? 1;
      break;
  }
}

export function applyEffects(
  effects: Effect[],
  board: Board,
  playerWhite: boolean,
  rng: Rng,
  chosenSquare: [number, number] | null = null,
  chosenPiece: [number, number] | null = null
): EffectResult {
  const result = emptyResult();
  for (const effect of effects) {
    applyEffect(effect, board, playerWhite, result, chosenSquare, chosenPiece, rng);
  }
  return result;
}
