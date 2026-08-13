/**
 * The chaos engine: phases, the deck, per-square mutations and hazards.
 *
 * It owns everything that happens to the board without either player moving a
 * piece. `onTurnStart` is the whole clock — it advances the phase, ages every
 * mutation and hazard, and rolls for an event.
 */

import { applyEffects } from "./effects";
import { CARDS } from "./cards";
import { EVENTS } from "./events";
import type { Board, Card, ChaosEvent, EffectResult, Hazard, Mutation, Rng } from "./types";

/**
 * A phase unlocks when *any* of its three triggers is met, so a fast, bloody
 * game escalates as readily as a long slow one.
 */
const PHASE_TRIGGERS: Record<number, { minTurn: number; minChaos: number; maxPieces: number }> = {
  1: { minTurn: 0, minChaos: 0, maxPieces: 32 },
  2: { minTurn: 8, minChaos: 15, maxPieces: 28 },
  3: { minTurn: 18, minChaos: 35, maxPieces: 22 },
  4: { minTurn: 30, minChaos: 55, maxPieces: 16 },
  5: { minTurn: 45, minChaos: 80, maxPieces: 10 },
};

const PHASE_NAMES: Record<number, string> = {
  1: "Opening",
  2: "Strange Happenings",
  3: "Board Instability",
  4: "Tactical Mayhem",
  5: "Pawnageddon",
};

export const MAX_HAND_SIZE = 7;
const DECK_SIZE = 40;

export type ChaosTurnEvent =
  | { type: "phaseUp"; phase: number; name: string }
  | { type: "chaosEvent"; event: ChaosEvent; result: EffectResult };

function weightedPick<T extends { weight?: number }>(items: T[], rng: Rng): T {
  const total = items.reduce((s, i) => s + (i.weight ?? 1), 0);
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight ?? 1;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const key = (col: number, row: number) => `${col},${row}`;

export class ChaosEngine {
  phase = 1;
  phaseName = PHASE_NAMES[1];
  turnLog: string[] = [];

  whiteHand: Card[] = [];
  blackHand: Card[] = [];
  readonly maxHandSize = MAX_HAND_SIZE;

  /** Per-square state, keyed `"col,row"`. */
  mutations = new Map<string, Mutation>();
  hazards = new Map<string, Hazard>();

  private deck: Card[] = [];
  private deckIndex = 0;
  private eventCooldowns = new Map<string, number>();
  private lastEventTurn = -99;

  constructor(private readonly rng: Rng = Math.random) {
    this.buildDeck();
  }

  // ── Phases ──

  updatePhase(turn: number, chaosPct: number, piecesRemaining: number): boolean {
    let next = 1;
    for (let p = 5; p >= 1; p--) {
      const t = PHASE_TRIGGERS[p];
      if (turn >= t.minTurn || chaosPct >= t.minChaos || piecesRemaining <= t.maxPieces) {
        next = p;
        break;
      }
    }
    const rose = next > this.phase;
    this.phase = next;
    this.phaseName = PHASE_NAMES[next];
    return rose;
  }

  // ── Deck ──

  private buildDeck(): void {
    // The deck starts life holding only what the early phases can throw, three
    // copies of each, cut to forty. Later cards arrive by rebuild, not by being
    // shuffled in from the start.
    const pool = CARDS.filter((c) => c.phase <= 3);
    this.deck = shuffle([...pool, ...pool, ...pool], this.rng).slice(0, DECK_SIZE);
    this.deckIndex = 0;
  }

  drawCard(playerWhite: boolean): Card | null {
    if (this.deckIndex >= this.deck.length) this.buildDeck();
    const hand = playerWhite ? this.whiteHand : this.blackHand;
    if (hand.length >= this.maxHandSize) return null;
    const card = this.deck[this.deckIndex++];
    hand.push({ ...card });
    return card;
  }

  playCard(
    cardId: string,
    board: Board,
    playerWhite: boolean,
    chosenSquare: [number, number] | null = null,
    chosenPiece: [number, number] | null = null
  ): { card: Card; result: EffectResult } | null {
    const hand = playerWhite ? this.whiteHand : this.blackHand;
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return null;
    const card = hand.splice(idx, 1)[0];
    const result = applyEffects(card.effects, board, playerWhite, this.rng, chosenSquare, chosenPiece);
    this.absorb(result);
    this.turnLog = [`Card: ${card.name}`, ...result.messages];
    return { card, result };
  }

  /** Move a result's mutations and hazards into the live per-square maps. */
  private absorb(result: EffectResult): void {
    for (const m of result.mutationsApplied) this.mutations.set(key(m.col, m.row), m);
    for (const h of result.hazardsPlaced) this.hazards.set(key(h.col, h.row), h);
  }

  // ── The turn clock ──

  onTurnStart(
    turn: number,
    chaosPct: number,
    piecesRemaining: number,
    board: Board,
    whiteToMove: boolean
  ): ChaosTurnEvent[] {
    this.turnLog = [];
    const events: ChaosTurnEvent[] = [];

    if (this.updatePhase(turn, chaosPct, piecesRemaining)) {
      this.turnLog.push(`⚡ Phase ${this.phase}: ${this.phaseName}!`);
      events.push({ type: "phaseUp", phase: this.phase, name: this.phaseName });
    }

    // Age everything with a duration. Collected first, because deleting from a
    // Map while iterating it is the kind of thing that works until it doesn't.
    for (const [k, m] of [...this.mutations]) {
      m.duration--;
      if (m.duration <= 0) this.mutations.delete(k);
    }
    for (const [k, h] of [...this.hazards]) {
      h.duration--;
      if (h.duration <= 0) this.hazards.delete(k);
    }
    for (const [id, cd] of [...this.eventCooldowns]) {
      if (cd - 1 <= 0) this.eventCooldowns.delete(id);
      else this.eventCooldowns.set(id, cd - 1);
    }

    // From phase 2, every third turn gets a roll, and the odds climb with the
    // phase.
    if (this.phase >= 2 && turn > 0 && turn % 3 === 0 && turn !== this.lastEventTurn) {
      const chance = 0.2 + (this.phase - 1) * 0.1;
      if (this.rng() < chance) {
        const ev = this.pickEvent();
        if (ev) {
          const result = applyEffects(ev.effects, board, whiteToMove, this.rng);
          this.absorb(result);
          this.lastEventTurn = turn;
          this.eventCooldowns.set(ev.id, ev.cooldown || 4);
          this.turnLog.push(`🌪 ${ev.name}: ${ev.desc}`);
          events.push({ type: "chaosEvent", event: ev, result });
        }
      }
    }

    return events;
  }

  private pickEvent(): ChaosEvent | null {
    const available = EVENTS.filter(
      (e) => e.phase <= this.phase && (this.eventCooldowns.get(e.id) ?? 0) <= 0
    );
    return available.length ? weightedPick(available, this.rng) : null;
  }

  // ── Per-square state ──

  isFrozen(col: number, row: number): boolean {
    return this.mutations.get(key(col, row))?.type === "freeze";
  }

  isShielded(col: number, row: number): boolean {
    return this.mutations.get(key(col, row))?.type === "shield";
  }

  clearMutation(col: number, row: number): void {
    this.mutations.delete(key(col, row));
  }

  onPieceMove(fromCol: number, fromRow: number, toCol: number, toRow: number): void {
    const from = key(fromCol, fromRow);
    const m = this.mutations.get(from);
    if (!m) return;
    this.mutations.delete(from);
    this.mutations.set(key(toCol, toRow), { ...m, col: toCol, row: toRow });
  }

  onPieceCaptured(col: number, row: number): void {
    this.mutations.delete(key(col, row));
    this.hazards.delete(key(col, row));
  }

  placeHazard(col: number, row: number, id: string, duration: number): void {
    this.hazards.set(key(col, row), { id, col, row, duration });
  }

  /** Fire whatever is sitting on the square a piece just landed on. */
  checkHazardOnMove(col: number, row: number, board: Board, playerWhite: boolean): EffectResult | null {
    const haz = this.hazards.get(key(col, row));
    if (!haz) return null;
    if (haz.id !== "fire" && haz.id !== "lava" && haz.id !== "plague") return null;
    const result = applyEffects(
      [{ type: "destroy", target: "chosen_piece" }],
      board,
      playerWhite,
      this.rng,
      null,
      [col, row]
    );
    result.messages.unshift(`🔥 ${haz.id.toUpperCase()} hazard triggered!`);
    return result;
  }

  getMutationAt(col: number, row: number): Mutation | null {
    return this.mutations.get(key(col, row)) ?? null;
  }

  getHazardAt(col: number, row: number): Hazard | null {
    return this.hazards.get(key(col, row)) ?? null;
  }

  hazardList(): Hazard[] {
    return [...this.hazards.values()];
  }
}
