/**
 * The game: chess underneath, chaos on top.
 *
 * The chess half lives in `position.ts` and is a pure value transformation.
 * This class owns everything the chess half deliberately knows nothing about —
 * gold, the chaos meter, gear, cards, hazards, phases — and sequences a turn.
 *
 * ## Where this diverges from the original JavaScript
 *
 * The port is faithful except where the original was demonstrably wrong. Each
 * of these was found by testing rather than by reading, and each is called out
 * again at the line that implements it:
 *
 * 1. **En passant only fires for pawns.** Perft caught this: the original
 *    stripped the pawn behind the en-passant square whenever *any* piece landed
 *    there, which both deleted a pawn illegally and, inside the legality
 *    filter, discarded a legal knight move. See `moves.ts`.
 * 2. **Capturing a rook on its home square ends that castling right.** The
 *    original only cleared rights when the rook *moved*.
 * 3. **A shield actually saves the piece.** The original decremented the
 *    shield, announced that it had absorbed the capture, and then overwrote the
 *    piece anyway — so the item's one advertised effect never happened.
 * 4. **Gear does not transfer to its killer.** The original moved the attacker's
 *    gear onto the destination square without clearing the defender's, so
 *    capturing a shielded piece with an unequipped one left the shield behind,
 *    now protecting the capturer.
 * 5. **The poison hazard does something.** The Poison Blade placed a `plague`
 *    hazard and nothing ever triggered on `plague`, so a 4-gold item was inert.
 *
 * Randomness is injected (`Rng`) rather than reached for, so a game can be
 * replayed from a seed — which is what makes the bot in the smoke harness worth
 * running.
 */

import { getPiece, isWhitePiece, kindOf, pieceIsSide, setPiece, countPieces } from "./board";
import {
  CHAOS_MAX,
  DECK_TURN,
  EXTRA_DRAW_COST,
  MAX_PLAYS_PER_TURN,
  SHOP_TURN,
  pieceValue,
} from "./constants";
import { isKingInCheck, legalTargets, moveKey, parseMoveKey, promotionRow } from "./moves";
import { applyMove, initialPosition, outcome, type Position } from "./position";
import { ChaosEngine, type ChaosTurnEvent } from "./chaosEngine";
import { SHIELDS, WEAPONS } from "./equipment";
import { getUltimate } from "./ultimates";
import type {
  Board,
  Card,
  EffectResult,
  Gear,
  GameOver,
  Move,
  Piece,
  Rng,
  UltimateResult,
  Winner,
} from "./types";

export interface GameEvents {
  /** Anything at all changed; the view repaints. */
  change: void;
  turnStart: { whiteToMove: boolean; turn: number };
  moved: { move: Move; captured: Piece; piece: Piece };
  promotionNeeded: Move & { white: boolean };
  check: { white: boolean };
  gameOver: { result: GameOver; winner: Winner };
  phaseUp: { phase: number; name: string };
  chaosEvent: { name: string; desc: string; result: EffectResult };
  ultimate: { col: number; row: number; name: string; icon: string; result: UltimateResult };
  cardPlayed: { card: Card; result: EffectResult };
  blocked: { col: number; row: number };
}

type Listener<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

const gearKey = (col: number, row: number) => `${col},${row}`;

export class PawnGame {
  position: Position = initialPosition();
  selected: [number, number] | null = null;
  validMoves = new Set<string>();

  capturedWhite: Piece[] = [];
  capturedBlack: Piece[] = [];

  turnCount = 0;
  whiteGold = 0;
  blackGold = 0;
  whiteChaos = 0;
  blackChaos = 0;

  turnMessages: string[] = [];
  gameOver: GameOver = null;
  winner: Winner = null;

  freeDrawsRemaining = 0;
  cardsPlayedThisTurn = 0;

  readonly chaos: ChaosEngine;

  pieceWeapons = new Map<string, Gear>();
  pieceShields = new Map<string, Gear>();

  /** A move awaiting a promotion choice. */
  pendingPromotion: Move | null = null;

  private listeners = new Map<keyof GameEvents, Set<(p: never) => void>>();

  constructor(private readonly rng: Rng = Math.random) {
    this.chaos = new ChaosEngine(rng);
  }

  // ── Events ──

  on<K extends keyof GameEvents>(type: K, fn: Listener<K>): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn as (p: never) => void);
    this.listeners.set(type, set);
    return () => set.delete(fn as (p: never) => void);
  }

  private emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      (fn as Listener<K>)(payload);
    }
  }

  private changed(): void {
    this.emit("change", undefined);
  }

  // ── Views onto the state ──

  get board(): Board {
    return this.position.board;
  }
  get whiteToMove(): boolean {
    return this.position.whiteToMove;
  }
  get whiteHand(): Card[] {
    return this.chaos.whiteHand;
  }
  get blackHand(): Card[] {
    return this.chaos.blackHand;
  }
  get currentHand(): Card[] {
    return this.whiteToMove ? this.chaos.whiteHand : this.chaos.blackHand;
  }
  get chaosPct(): number {
    return Math.min(100, ((this.whiteChaos + this.blackChaos) / (CHAOS_MAX * 2)) * 100);
  }
  get phase(): number {
    return this.chaos.phase;
  }
  get phaseName(): string {
    return this.chaos.phaseName;
  }
  get piecesRemaining(): number {
    return countPieces(this.board);
  }
  get currentGold(): number {
    return this.whiteToMove ? this.whiteGold : this.blackGold;
  }
  get currentChaos(): number {
    return this.whiteToMove ? this.whiteChaos : this.blackChaos;
  }
  get shopUnlocked(): boolean {
    return this.turnCount >= SHOP_TURN;
  }
  get deckUnlocked(): boolean {
    return this.turnCount >= DECK_TURN;
  }
  /** Is the side to move in check right now? */
  get inCheck(): boolean {
    return isKingInCheck(this.board, this.whiteToMove);
  }

  getWeaponAt(col: number, row: number): Gear | null {
    return this.pieceWeapons.get(gearKey(col, row)) ?? null;
  }

  getShieldAt(col: number, row: number): Gear | null {
    return this.pieceShields.get(gearKey(col, row)) ?? null;
  }

  // ── Turn flow ──

  /** Run the opening turn. Call once, after wiring listeners. */
  start(): void {
    this.startTurn();
  }

  private startTurn(): void {
    this.turnMessages = [];
    this.freeDrawsRemaining = 0;
    this.cardsPlayedThisTurn = 0;

    const events: ChaosTurnEvent[] = this.chaos.onTurnStart(
      this.turnCount,
      this.chaosPct,
      this.piecesRemaining,
      this.board,
      this.whiteToMove
    );
    this.turnMessages.push(...this.chaos.turnLog);

    for (const ev of events) {
      if (ev.type === "phaseUp") this.emit("phaseUp", { phase: ev.phase, name: ev.name });
      else {
        this.absorbResult(ev.result);
        this.emit("chaosEvent", { name: ev.event.name, desc: ev.event.desc, result: ev.result });
      }
    }

    // A chaos event can end the game outright by removing the last legal move
    // or the king itself, and the turn must not continue as though it hadn't.
    if (this.settleOutcome()) return;

    if (this.deckUnlocked) {
      const hand = this.currentHand;
      if (hand.length < this.chaos.maxHandSize) this.chaos.drawCard(this.whiteToMove);
    }

    this.emit("turnStart", { whiteToMove: this.whiteToMove, turn: this.turnCount });
    this.changed();
  }

  /** Record checkmate or stalemate if the side to move has nothing left. Returns true if the game ended. */
  private settleOutcome(): boolean {
    const result = outcome(this.position);
    if (!result) return false;
    this.gameOver = result;
    this.winner = result === "checkmate" ? (this.whiteToMove ? "black" : "white") : null;
    this.emit("gameOver", { result: this.gameOver, winner: this.winner });
    this.changed();
    return true;
  }

  // ── Input ──

  clickSquare(col: number, row: number): void {
    if (this.gameOver || this.pendingPromotion) return;

    if (this.chaos.isFrozen(col, row) && pieceIsSide(this.board, col, row, this.whiteToMove)) {
      this.turnMessages.push("That piece is frozen!");
      this.changed();
      return;
    }

    if (this.selected) {
      const [sc, sr] = this.selected;
      if (this.validMoves.has(moveKey(col, row))) {
        const piece = getPiece(this.board, sc, sr);
        const move: Move = { fromCol: sc, fromRow: sr, toCol: col, toRow: row };
        this.selected = null;
        this.validMoves = new Set();
        if (kindOf(piece) === "p" && row === promotionRow(isWhitePiece(piece))) {
          this.pendingPromotion = move;
          this.emit("promotionNeeded", { ...move, white: isWhitePiece(piece) });
          this.changed();
          return;
        }
        this.playMove(move);
        return;
      }
    }

    if (pieceIsSide(this.board, col, row, this.whiteToMove)) {
      this.selected = [col, row];
      this.validMoves = legalTargets(
        this.board,
        col,
        row,
        this.position.rights,
        this.position.ep
      );
    } else {
      this.selected = null;
      this.validMoves = new Set();
    }
    this.changed();
  }

  choosePromotion(kind: "q" | "r" | "b" | "n"): void {
    const move = this.pendingPromotion;
    if (!move) return;
    this.pendingPromotion = null;
    const white = isWhitePiece(getPiece(this.board, move.fromCol, move.fromRow));
    this.playMove({ ...move, promoteTo: (white ? kind : kind.toUpperCase()) as Piece });
  }

  // ── Making a move ──

  playMove(move: Move): void {
    if (this.gameOver) return;
    const { fromCol, fromRow, toCol, toRow } = move;
    const piece = getPiece(this.board, fromCol, fromRow);
    if (piece === " ") return;
    const white = isWhitePiece(piece);

    const targetKey = gearKey(toCol, toRow);
    const defenderShield = this.pieceShields.get(targetKey);
    const defenderWarded = this.chaos.isShielded(toCol, toRow);
    const targetOccupied = getPiece(this.board, toCol, toRow) !== " ";

    // (3) A shield saves the piece. The original consumed the shield, said so,
    // and overwrote the piece regardless — which made the item's only effect
    // cosmetic. Here the capture is refused outright: the attacker stays put,
    // the shield is spent, and the turn still passes, so blocking costs the
    // attacker a tempo rather than nothing.
    if (targetOccupied && (defenderShield || defenderWarded)) {
      if (defenderShield) {
        defenderShield.uses--;
        if (defenderShield.uses <= 0) this.pieceShields.delete(targetKey);
        this.turnMessages.push("🛡️ Shield absorbed the capture!");
      } else {
        this.chaos.clearMutation(toCol, toRow);
        this.turnMessages.push("✨ A ward absorbed the capture!");
      }
      this.selected = null;
      this.validMoves = new Set();
      this.emit("blocked", { col: toCol, row: toRow });
      this.passTurn();
      this.endTurn();
      return;
    }

    const { next, effects } = applyMove(this.position, move);
    const captured = effects.captured;
    this.position = next;

    // Weapons fire on a capture and are spent by it.
    const fromKey = gearKey(fromCol, fromRow);
    const weapon = captured !== " " ? this.pieceWeapons.get(fromKey) : undefined;
    const weaponId = weapon?.id ?? null;
    if (weapon) {
      weapon.uses--;
      if (weapon.uses <= 0) this.pieceWeapons.delete(fromKey);
    }

    if (captured !== " ") {
      const value = pieceValue(captured);
      const bonus = weaponId === "sword" ? 3 : 0;
      if (bonus) this.turnMessages.push("⚔️ Sword strike! +3 gold!");
      if (white) {
        this.whiteChaos = Math.min(CHAOS_MAX, this.whiteChaos + value);
        this.whiteGold += value + bonus;
      } else {
        this.blackChaos = Math.min(CHAOS_MAX, this.blackChaos + value);
        this.blackGold += value + bonus;
      }
      const at = effects.capturedAt!;
      this.chaos.onPieceCaptured(at.col, at.row);
      this.recordCapture(captured);

      if (weaponId === "bomb") this.detonate(toCol, toRow);
      if (weaponId === "poison") {
        // (5) `plague` is now a hazard that actually triggers — see
        // ChaosEngine.checkHazardOnMove.
        this.chaos.placeHazard(toCol, toRow, "plague", 4);
        this.turnMessages.push("☠️ Poison left on the square!");
      }
    }

    // (4) Clear whatever the defender was carrying before moving the attacker's
    // gear across, or a shield outlives its owner and protects its killer.
    if (effects.capturedAt) {
      this.pieceWeapons.delete(gearKey(effects.capturedAt.col, effects.capturedAt.row));
      this.pieceShields.delete(gearKey(effects.capturedAt.col, effects.capturedAt.row));
    }
    this.migrateGear(fromCol, fromRow, toCol, toRow);
    this.chaos.onPieceMove(fromCol, fromRow, toCol, toRow);

    const hazard = this.chaos.checkHazardOnMove(toCol, toRow, this.board, white);
    if (hazard) {
      this.absorbResult(hazard);
      this.turnMessages.push(...hazard.messages);
      this.chaos.onPieceCaptured(toCol, toRow);
      this.pieceWeapons.delete(gearKey(toCol, toRow));
      this.pieceShields.delete(gearKey(toCol, toRow));
    }

    this.selected = null;
    this.validMoves = new Set();
    this.emit("moved", { move, captured, piece });
    this.endTurn();
  }

  /** A bomb takes the eight neighbours of the square it went off on. */
  private detonate(col: number, row: number): void {
    const exploded: Piece[] = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || c > 7 || r < 0 || r > 7) continue;
        const p = getPiece(this.board, c, r);
        if (p === " ") continue;
        setPiece(this.board, c, r, " ");
        this.chaos.onPieceCaptured(c, r);
        this.pieceWeapons.delete(gearKey(c, r));
        this.pieceShields.delete(gearKey(c, r));
        this.recordCapture(p);
        exploded.push(p);
      }
    }
    if (exploded.length) {
      this.turnMessages.push(`💣 BOOM! The blast took ${exploded.length} adjacent piece(s)!`);
    }
  }

  private recordCapture(piece: Piece): void {
    if (piece === " ") return;
    if (isWhitePiece(piece)) this.capturedWhite.push(piece);
    else this.capturedBlack.push(piece);
  }

  private migrateGear(fromCol: number, fromRow: number, toCol: number, toRow: number): void {
    const from = gearKey(fromCol, fromRow);
    const to = gearKey(toCol, toRow);
    const weapon = this.pieceWeapons.get(from);
    if (weapon) {
      this.pieceWeapons.delete(from);
      this.pieceWeapons.set(to, weapon);
    }
    const shield = this.pieceShields.get(from);
    if (shield) {
      this.pieceShields.delete(from);
      this.pieceShields.set(to, shield);
    }
  }

  /**
   * Hand the move to the other side without moving a piece.
   *
   * `applyMove` does this as part of advancing the position, so an ordinary
   * move never needs it — but an ultimate and a blocked capture both consume a
   * turn without producing a move, and both left the same player on the clock
   * until this existed. The en-passant square is cleared for the same reason it
   * is after any non-pawn move: the chance to take it lasts exactly one reply.
   */
  private passTurn(): void {
    this.position = {
      ...this.position,
      whiteToMove: !this.position.whiteToMove,
      ep: null,
    };
  }

  /** Hand the turn over and run everything that happens at the start of the next one. */
  private endTurn(): void {
    this.turnCount++;
    if (this.settleOutcome()) return;
    if (isKingInCheck(this.board, this.whiteToMove)) {
      this.turnMessages.push("Check!");
      this.emit("check", { white: this.whiteToMove });
    }
    this.startTurn();
  }

  private absorbResult(result: EffectResult): void {
    this.whiteGold = Math.max(0, this.whiteGold + result.goldChanges.white);
    this.blackGold = Math.max(0, this.blackGold + result.goldChanges.black);
    this.whiteChaos = Math.min(CHAOS_MAX, Math.max(0, this.whiteChaos + result.chaosChanges.white));
    this.blackChaos = Math.min(CHAOS_MAX, Math.max(0, this.blackChaos + result.chaosChanges.black));
    for (const d of result.destroyed) {
      this.recordCapture(d.piece);
      this.pieceWeapons.delete(gearKey(d.col, d.row));
      this.pieceShields.delete(gearKey(d.col, d.row));
    }
    // A piece that was teleported or swapped takes its gear with it.
    for (const t of result.teleported) this.migrateGear(t.fromCol, t.fromRow, t.toCol, t.toRow);
  }

  // ── Equipment ──

  equip(col: number, row: number, id: string, kind: "weapon" | "shield"): boolean {
    if (this.gameOver) return false;
    const piece = getPiece(this.board, col, row);
    if (piece === " " || isWhitePiece(piece) !== this.whiteToMove) return false;
    const item = kind === "weapon" ? WEAPONS[id] : SHIELDS[id];
    if (!item) return false;

    const gold = this.currentGold;
    if (gold < item.cost) {
      this.turnMessages.push(`Need ${item.cost} gold for ${item.name}`);
      this.changed();
      return false;
    }
    if (this.whiteToMove) this.whiteGold -= item.cost;
    else this.blackGold -= item.cost;

    const map = kind === "weapon" ? this.pieceWeapons : this.pieceShields;
    map.set(gearKey(col, row), { id, uses: item.uses });
    this.turnMessages.push(`${item.icon} Equipped ${item.name}`);
    this.changed();
    return true;
  }

  // ── Ultimates ──

  useUltimate(col: number, row: number): UltimateResult | null {
    if (this.gameOver) return null;
    const piece = getPiece(this.board, col, row);
    if (piece === " ") return null;
    const white = isWhitePiece(piece);
    if (white !== this.whiteToMove) return null;

    const ult = getUltimate(piece);
    if (!ult) return null;

    const chaos = white ? this.whiteChaos : this.blackChaos;
    if (chaos < ult.chaosCost) {
      this.turnMessages.push(
        `Need ${ult.chaosCost} chaos for ${ult.name} (have ${Math.round(chaos)})`
      );
      this.changed();
      return null;
    }
    if (white) this.whiteChaos = Math.max(0, this.whiteChaos - ult.chaosCost);
    else this.blackChaos = Math.max(0, this.blackChaos - ult.chaosCost);

    const result = ult.apply(
      this.board,
      col,
      row,
      white,
      this.capturedWhite,
      this.capturedBlack,
      this.rng
    );
    for (const d of result.destroyed) {
      this.recordCapture(d.piece);
      this.chaos.onPieceCaptured(d.col, d.row);
      this.pieceWeapons.delete(gearKey(d.col, d.row));
      this.pieceShields.delete(gearKey(d.col, d.row));
    }
    this.turnMessages.push(`${ult.icon} ${ult.name} — ${result.destroyed.length} destroyed`);
    this.emit("ultimate", { col, row, name: ult.name, icon: ult.icon, result });

    this.selected = null;
    this.validMoves = new Set();
    // An ultimate is the side's action for the turn, so it hands the move over
    // exactly as a move would.
    this.passTurn();
    this.endTurn();
    return result;
  }

  // ── Cards ──

  drawCard(): Card | null {
    if (this.gameOver) return null;
    const hand = this.currentHand;
    if (hand.length >= this.chaos.maxHandSize) {
      this.turnMessages.push("Hand is full!");
      this.changed();
      return null;
    }
    if (this.freeDrawsRemaining > 0) this.freeDrawsRemaining--;
    else {
      if (this.currentGold < EXTRA_DRAW_COST) {
        this.turnMessages.push(`Need ${EXTRA_DRAW_COST} gold to draw`);
        this.changed();
        return null;
      }
      if (this.whiteToMove) this.whiteGold -= EXTRA_DRAW_COST;
      else this.blackGold -= EXTRA_DRAW_COST;
    }
    const card = this.chaos.drawCard(this.whiteToMove);
    this.changed();
    return card;
  }

  playCard(cardId: string): boolean {
    if (this.gameOver) return false;
    if (this.cardsPlayedThisTurn >= MAX_PLAYS_PER_TURN) {
      this.turnMessages.push("Already played a card this turn!");
      this.changed();
      return false;
    }
    const played = this.chaos.playCard(cardId, this.board, this.whiteToMove);
    if (!played) return false;
    this.cardsPlayedThisTurn++;
    this.absorbResult(played.result);
    this.turnMessages.push(...played.result.messages);
    for (let i = 0; i < played.result.cardsDrawn; i++) this.freeDrawsRemaining++;
    this.emit("cardPlayed", { card: played.card, result: played.result });
    // A card can remove the last legal move, or a king.
    if (!this.settleOutcome()) this.changed();
    return true;
  }

  /** Targets for the selected piece, as `[col,row]` pairs — for the view. */
  highlightedSquares(): [number, number][] {
    return [...this.validMoves].map(parseMoveKey);
  }
}
