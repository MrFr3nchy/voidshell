/** Gear a piece can carry. Bought with gold, spent by using it. */

import type { Shield, Weapon } from "./types";

export const WEAPONS: Record<string, Weapon> = {
  sword: {
    id: "sword",
    name: "Sword",
    icon: "⚔️",
    cost: 3,
    desc: "+3 gold on your next capture",
    uses: 1,
  },
  bomb: {
    id: "bomb",
    name: "Bomb",
    icon: "💣",
    cost: 5,
    desc: "Next capture explodes — destroys all adjacent pieces too",
    uses: 1,
  },
  poison: {
    id: "poison",
    name: "Poison Blade",
    icon: "☠️",
    cost: 4,
    desc: "Each capture leaves a poison hazard on that square (3 uses)",
    uses: 3,
  },
};

export const SHIELDS: Record<string, Shield> = {
  iron: {
    id: "iron",
    name: "Iron Shield",
    icon: "🛡️",
    cost: 4,
    desc: "Blocks the next capture attempt — the piece survives once",
    uses: 1,
  },
  magic: {
    id: "magic",
    name: "Magic Ward",
    icon: "✨",
    cost: 6,
    desc: "Blocks the next chaos event targeting this piece",
    uses: 1,
  },
};

export const WEAPON_LIST = Object.values(WEAPONS);
export const SHIELD_LIST = Object.values(SHIELDS);
