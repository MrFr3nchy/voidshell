/**
 * What's on the floor.
 *
 * This is the entire cost of adding a game: write it against `GameDef`, import
 * it, put it in the array. The launcher, the high-score table, the command
 * palette entry and the keyboard all pick it up from here without being told.
 */

import type { GameDef } from "./types";
import { joustGame } from "./games/joust";
import { pacmanGame } from "./games/pacman";
import { galagaGame } from "./games/galaga";
import { missileGame } from "./games/missile";

/**
 * Ordered oldest first, which is also roughly easiest first. The shelf reads
 * as a floor plan rather than as an array, and the two games from 1980 sit
 * next to each other where they belong.
 */
export const CABINETS: GameDef[] = [pacmanGame, missileGame, galagaGame, joustGame];

export function cabinet(id: string): GameDef | undefined {
  return CABINETS.find((c) => c.id === id);
}
