/**
 * The cabinet contract.
 *
 * Arcade is a launcher, not a game. Everything specific to a title lives
 * behind this interface, and everything generic — the canvas, the frame loop,
 * the letterboxing, the keyboard, the high-score table, pause, mute — is the
 * cabinet's problem and is written exactly once. Adding a second game is one
 * file and one line in `registry.ts`; it is not a change to this module.
 *
 * A `Game` is deliberately given no DOM and no access to the kernel. It gets a
 * delta, a pad, and a 2D context already scaled to its own pixel grid. That is
 * the whole surface, which is what makes the games portable and the cabinet
 * responsible for anything that could misbehave inside the void.
 */

/** The stick and the buttons, as a game thinks about them. */
export type GameKey = "left" | "right" | "up" | "down" | "flap" | "start" | "back";

export interface Pad {
  /** Held at this instant. */
  down(key: GameKey): boolean;
  /**
   * Went down since the previous frame — one `true` per physical press, no
   * matter how long it is held. Joust's flap is a per-press impulse and a
   * held-key reading would turn it into a jetpack, so the distinction is not
   * cosmetic.
   */
  hit(key: GameKey): boolean;
}

/** What the cabinet lends a game. */
export interface GameHost {
  /** The best score this cabinet has ever recorded, across sessions. */
  hiScore(): number;
  /** Record a final score. Returns true when it took the record. */
  submit(score: number): boolean;
  /** Whether the player has muted the cabinet. Games must check before sound. */
  muted(): boolean;
  /** Publish the readout under the canvas: label/value pairs, redrawn on change. */
  facts(rows: { label: string; value: string }[]): void;
}

export interface Game {
  /** Advance the simulation. Not called while paused. */
  update(dt: number, pad: Pad): void;
  /**
   * Draw one frame. The transform is already set so that (0,0)–(width,height)
   * is the whole playfield, scaled by a whole number and centred; smoothing is
   * already off and the playfield is already clipped.
   */
  draw(g: CanvasRenderingContext2D): void;
  /** Optional teardown — timers, buffers, anything the GC won't get. */
  dispose?(): void;
}

export interface GameDef {
  id: string;
  name: string;
  /** When the original stood in an arcade. Shown on the cabinet card. */
  year: string;
  glyph: string;
  /** One line for the cabinet card. */
  blurb: string;
  /** Controls, one line each. */
  controls: string[];
  /**
   * Internal resolution. The cabinet letterboxes and integer-scales this onto
   * whatever size the panel happens to be, so a game never has to think about
   * the window it is in and never renders at a fractional scale.
   */
  width: number;
  height: number;
  create(host: GameHost): Game;
}
