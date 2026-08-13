/**
 * The shapes the game is made of.
 *
 * **Coordinates are the original game's, deliberately.** Row 0 is rank 8 and
 * **lowercase is white** — the opposite of FEN, where uppercase is white. The
 * port keeps both conventions so every rule below can be read against the
 * JavaScript it came from; converting would have made the diff unauditable for
 * no gain, and the one place the distinction matters (parsing a FEN, in the
 * perft harness) converts explicitly and says so.
 */

export type PieceKind = "p" | "n" | "b" | "r" | "q" | "k";

/** A square's contents: a piece letter, or a space for empty. */
export type Piece =
  | "p" | "n" | "b" | "r" | "q" | "k"   // white
  | "P" | "N" | "B" | "R" | "Q" | "K"   // black
  | " ";

export const EMPTY = " " as const;

/** `board[row][col]`, row 0 = rank 8. */
export type Board = Piece[][];

export interface Square {
  col: number;
  row: number;
}

export interface CastlingRights {
  white_kingside: boolean;
  white_queenside: boolean;
  black_kingside: boolean;
  black_queenside: boolean;
}

/** The square a pawn may be captured *on*, not the pawn's square. */
export type EnPassant = [col: number, row: number] | null;

/** A move, as the rules deal in them. `promoteTo` is set only for promotions. */
export interface Move {
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  promoteTo?: Piece;
}

/**
 * Every source of randomness in the game goes through one of these.
 *
 * The chaos deck, the event roll and half the effects are random by design,
 * which makes the whole game untestable unless the randomness is injectable.
 * `Math.random` is the default; the harness passes a seeded one so a bot run
 * is reproducible and a failure can be replayed.
 */
export type Rng = () => number;

export interface Destroyed {
  col: number;
  row: number;
  piece: Piece;
}

export interface Spawned {
  col: number;
  row: number;
  piece: Piece;
}

export interface Teleported {
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
}

export interface Transformed {
  col: number;
  row: number;
  oldPiece: Piece;
  newPiece: Piece;
}

export interface Hazard {
  id: string;
  col: number;
  row: number;
  duration: number;
}

export interface Mutation {
  type: "freeze" | "shield";
  col: number;
  row: number;
  duration: number;
}

export interface ResourceChange {
  white: number;
  black: number;
}

/** What an effect, a card or an ultimate did to the board. */
export interface EffectResult {
  destroyed: Destroyed[];
  spawned: Spawned[];
  teleported: Teleported[];
  transformed: Transformed[];
  goldChanges: ResourceChange;
  chaosChanges: ResourceChange;
  cardsDrawn: number;
  hazardsPlaced: Hazard[];
  mutationsApplied: Mutation[];
  messages: string[];
  extraTurns: number;
}

export type EffectType =
  | "destroy" | "spawn" | "teleport" | "swap" | "transform"
  | "gold" | "chaos" | "steal_gold" | "place_hazard"
  | "freeze" | "shield" | "clone" | "extra_turn" | "draw_cards";

export type TargetSelector =
  | "random_self" | "random_enemy" | "random_any" | "any_piece"
  | "all_pawns" | "all_pieces" | "self_piece" | "enemy_piece" | "chosen_piece";

export interface Effect {
  type: EffectType;
  target?: TargetSelector;
  player?: "self" | "opponent" | "both";
  amount?: number;
  count?: number;
  radius?: number;
  duration?: number;
  piece?: PieceKind;
  into?: PieceKind;
  hazard_id?: string;
  /**
   * Present on three spawn effects in the card data and ignored by the engine,
   * which always picks a random empty square unless the caller named one. Kept
   * so the data stays a faithful copy rather than a quietly edited one.
   */
  square?: "random_empty";
}

export interface Card {
  id: string;
  name: string;
  desc: string;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  phase: number;
  weight: number;
  tags: string[];
  effects: Effect[];
}

export interface ChaosEvent {
  id: string;
  name: string;
  desc: string;
  rarity: Card["rarity"];
  phase: number;
  weight: number;
  cooldown: number;
  effects: Effect[];
}

export interface Weapon {
  id: string;
  name: string;
  icon: string;
  cost: number;
  desc: string;
  uses: number;
}

export interface Shield {
  id: string;
  name: string;
  icon: string;
  cost: number;
  desc: string;
  uses: number;
}

/** A piece's equipped gear, with the uses it has left. */
export interface Gear {
  id: string;
  uses: number;
}

export interface Ultimate {
  name: string;
  icon: string;
  desc: string;
  chaosCost: number;
  apply(
    board: Board,
    col: number,
    row: number,
    isWhite: boolean,
    capturedWhite: Piece[],
    capturedBlack: Piece[],
    rng: Rng
  ): UltimateResult;
}

export interface UltimateResult {
  destroyed: Destroyed[];
  spawned: Spawned[];
  /** Squares the effect swept, for the animation to trace. */
  path: [col: number, row: number][];
}

export type GameOver = "checkmate" | "stalemate" | null;
export type Winner = "white" | "black" | null;
