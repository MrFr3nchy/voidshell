import type { KernelContext, VoidModule } from "../../kernel/types";

/**
 * Aurora is the proof that "theme" is not a screen — it's a module.
 *
 * It used to be an app with its own window. Now it publishes its controls into
 * the settings registry and disappears into the background, which is the more
 * honest shape: the thing that owns the colours is a service, and the Settings
 * app is just one possible face for it. Anything else on the bus could retune
 * the sky the same way, through the same public `patchWorld` syscall.
 */
interface Preset {
  cool: string;
  warm: string;
  voidColor: string;
  intensity: number;
  stars: number;
}

const PRESETS: Record<string, Preset> = {
  spectral: { cool: "#4fe3d0", warm: "#c05cff", voidColor: "#05060c", intensity: 1.0, stars: 0.55 },
  ember: { cool: "#ff8a5c", warm: "#ffd166", voidColor: "#0c0605", intensity: 1.1, stars: 0.4 },
  abyss: { cool: "#2b4cff", warm: "#00e0ff", voidColor: "#02030a", intensity: 0.85, stars: 0.8 },
  bloom: { cool: "#ff5c9c", warm: "#9d7bff", voidColor: "#0a0410", intensity: 1.2, stars: 0.5 },
  moss: { cool: "#3ad18b", warm: "#d8ff6e", voidColor: "#030906", intensity: 0.95, stars: 0.45 },
  ash: { cool: "#8e97b5", warm: "#cfd7ee", voidColor: "#07080c", intensity: 0.6, stars: 0.9 },
  vhs: { cool: "#ff2d95", warm: "#00f0ff", voidColor: "#0b0018", intensity: 1.35, stars: 0.25 },
};

export const K = {
  preset: "appearance.preset",
  cool: "appearance.cool",
  warm: "appearance.warm",
  voidColor: "appearance.void",
  intensity: "appearance.intensity",
  stars: "appearance.stars",
  grain: "appearance.grain",
  tintChrome: "appearance.tintChrome",
};

export const aurora: VoidModule = {
  manifest: {
    id: "aurora",
    name: "Aurora",
    kind: "world",
    glyph: "\u274b",
    blurb: "owns the colour of the sky",
    version: "0.2.0",
  },

  activate(ctx: KernelContext) {
    const base = PRESETS.spectral;

    ctx.defineSetting({
      key: K.preset,
      label: "palette",
      kind: "select",
      group: "Appearance",
      order: 10,
      default: "spectral",
      hint: "a starting point \u2014 tweak any colour below and you're off-preset",
      options: Object.keys(PRESETS).map((v) => ({ value: v, label: v })),
    });
    ctx.defineSetting({ key: K.cool, label: "cool pole", kind: "color", group: "Appearance", order: 20, default: base.cool });
    ctx.defineSetting({ key: K.warm, label: "warm pole", kind: "color", group: "Appearance", order: 21, default: base.warm });
    ctx.defineSetting({ key: K.voidColor, label: "the void itself", kind: "color", group: "Appearance", order: 22, default: base.voidColor });
    ctx.defineSetting({
      key: K.intensity,
      label: "aurora intensity",
      kind: "slider",
      group: "Appearance",
      order: 30,
      default: base.intensity,
      min: 0,
      max: 1.5,
      step: 0.01,
    });
    ctx.defineSetting({
      key: K.stars,
      label: "star density",
      kind: "slider",
      group: "Appearance",
      order: 31,
      default: base.stars,
      min: 0,
      max: 1,
      step: 0.01,
    });
    ctx.defineSetting({
      key: K.grain,
      label: "film grain",
      kind: "slider",
      group: "Appearance",
      order: 32,
      default: 0.02,
      min: 0,
      max: 0.08,
      step: 0.002,
      hint: "a little noise stops wide gradients from banding",
    });
    ctx.defineSetting({
      key: K.tintChrome,
      label: "tint the interface too",
      kind: "toggle",
      group: "Appearance",
      order: 40,
      default: true,
      hint: "panels, buttons and glows borrow the sky's palette",
    });

    const apply = () => {
      const cool = ctx.state.get<string>(K.cool, base.cool);
      const warm = ctx.state.get<string>(K.warm, base.warm);
      const voidColor = ctx.state.get<string>(K.voidColor, base.voidColor);

      ctx.patchWorld({
        cool: hexToNum(cool),
        warm: hexToNum(warm),
        voidColor: hexToNum(voidColor),
        intensity: ctx.state.get<number>(K.intensity, base.intensity),
        stars: ctx.state.get<number>(K.stars, base.stars),
        grain: ctx.state.get<number>(K.grain, 0.02),
      });

      // The chrome follows the sky. It's the difference between "a theme" and
      // "the whole environment agreed on something".
      const root = document.documentElement;
      if (ctx.state.get<boolean>(K.tintChrome, true)) {
        root.style.setProperty("--cyan", cool);
        root.style.setProperty("--magenta", warm);
        root.style.setProperty("--void-0", voidColor);
      } else {
        root.style.removeProperty("--cyan");
        root.style.removeProperty("--magenta");
        root.style.removeProperty("--void-0");
      }
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", voidColor);
    };

    const offs = [K.cool, K.warm, K.voidColor, K.intensity, K.stars, K.grain, K.tintChrome].map(
      (k) => ctx.state.subscribe(k, apply)
    );

    offs.push(
      ctx.state.subscribe(K.preset, (value) => {
        const preset = PRESETS[String(value)];
        if (!preset) return;
        ctx.state.set(K.cool, preset.cool);
        ctx.state.set(K.warm, preset.warm);
        ctx.state.set(K.voidColor, preset.voidColor);
        ctx.state.set(K.intensity, preset.intensity);
        ctx.state.set(K.stars, preset.stars);
      })
    );

    ctx.defineCommand({
      id: "aurora.cycle",
      label: "cycle palette",
      hint: "next sky",
      glyph: "\u274b",
      run: (c) => {
        const names = Object.keys(PRESETS);
        const cur = c.state.get<string>(K.preset, "spectral");
        const next = names[(names.indexOf(cur) + 1) % names.length];
        c.state.set(K.preset, next);
        c.notify(`palette \u2192 ${next}`, "good");
      },
    });

    apply();
    return () => offs.forEach((off) => off());
  },
};

function hexToNum(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(n) ? n : 0x000000;
}
