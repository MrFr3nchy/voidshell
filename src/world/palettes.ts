/** A sky palette. The compositor consumes these through `patchWorld`. */
export interface Palette {
  cool: number;
  warm: number;
  voidColor: number;
  intensity: number;
}

/**
 * Named skies. Shared by the Settings app (which paints them) and Aurora Forge
 * (which restores the last one at boot), so there is exactly one source of
 * truth for what "abyss" means.
 */
export const PALETTES: Record<string, Palette> = {
  spectral: { cool: 0x4fe3d0, warm: 0xc05cff, voidColor: 0x05060c, intensity: 1.0 },
  ember: { cool: 0xff8a5c, warm: 0xffd166, voidColor: 0x0c0605, intensity: 1.1 },
  abyss: { cool: 0x2b4cff, warm: 0x00e0ff, voidColor: 0x02030a, intensity: 0.85 },
  bloom: { cool: 0xff5c9c, warm: 0x9d7bff, voidColor: 0x0a0410, intensity: 1.2 },
  verdant: { cool: 0x4fe36b, warm: 0xd6ff5c, voidColor: 0x040a06, intensity: 0.95 },
  rust: { cool: 0xff6b4f, warm: 0x8c3bff, voidColor: 0x0d0407, intensity: 1.05 },
  glacier: { cool: 0x8fd4ff, warm: 0xe6f2ff, voidColor: 0x040810, intensity: 0.8 },
  vhs: { cool: 0x00ffd5, warm: 0xff2fb9, voidColor: 0x07020f, intensity: 1.35 },
};

export const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;
