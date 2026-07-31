/**
 * What's on the floor.
 *
 * This is the entire cost of adding a game: write it against `GameDef`, import
 * it, put it in the array. The launcher, the high-score table, the command
 * palette entry and the keyboard all pick it up from here without being told.
 */

import type { GameDef } from "./types";
import { joustGame } from "./games/joust";

export const CABINETS: GameDef[] = [joustGame];

export function cabinet(id: string): GameDef | undefined {
  return CABINETS.find((c) => c.id === id);
}
