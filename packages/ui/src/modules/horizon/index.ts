import type { ArrangeMode, KernelContext, VoidModule } from "../../kernel/types";

/**
 * Horizon owns how the void *behaves*: how fast it turns, how far you can see,
 * how much dust hangs in it, whether windows breathe. Every knob here is a
 * store key wired straight to a compositor uniform or tunable, so a setting is
 * never a special case — it's just shared memory the renderer reads.
 */
interface Knob {
  key: keyof typeof KEYS;
  patch: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  def: number;
  order: number;
}

const KEYS = {
  fov: "world.fov",
  sensitivity: "world.sensitivity",
  smoothing: "world.smoothing",
  fade: "world.fade",
  dust: "world.dust",
  nebulaSpin: "world.nebulaSpin",
  orbitSpeed: "world.orbitSpeed",
  driftAmount: "world.driftAmount",
} as const;

const TOGGLES: {
  key: string;
  patch: string;
  label: string;
  hint: string;
  def: boolean;
  order: number;
}[] = [
  {
    key: "world.compass",
    patch: "compass",
    label: "edge compass",
    hint: "chevrons at the screen edge point to windows behind you \u2014 click one to turn",
    def: true,
    order: 5,
  },
  {
    key: "world.tethers",
    patch: "tethers",
    label: "constellation threads",
    hint: "draw light between linked windows",
    def: true,
    order: 6,
  },
  {
    key: "world.drift",
    patch: "drift",
    label: "ambient drift",
    hint: "windows bob gently in place instead of hanging dead still",
    def: false,
    order: 60,
  },
  {
    key: "world.storms",
    patch: "storms",
    label: "aurora storms",
    hint: "the sky breathes: intensity swells and fades on its own",
    def: false,
    order: 61,
  },
];

const KNOBS: Knob[] = [
  { key: "fov", patch: "fov", label: "field of view", min: 45, max: 105, step: 1, def: 68, order: 10, hint: "wider sees more and warps more" },
  { key: "sensitivity", patch: "sensitivity", label: "look sensitivity", min: 0.25, max: 3, step: 0.05, def: 1, order: 11 },
  { key: "smoothing", patch: "smoothing", label: "camera easing", min: 0.02, max: 0.4, step: 0.01, def: 0.06, order: 12, hint: "low is floaty, high is snappy" },
  { key: "fade", patch: "fade", label: "distance fade", min: 0, max: 0.85, step: 0.01, def: 0.55, order: 20 },
  { key: "dust", patch: "dust", label: "dust motes", min: 0, max: 5000, step: 100, def: 1400, order: 21 },
  { key: "nebulaSpin", patch: "nebulaSpin", label: "nebula rotation", min: 0, max: 4, step: 0.05, def: 1, order: 22 },
  { key: "orbitSpeed", patch: "orbitSpeed", label: "orbital speed", min: 0, max: 5, step: 0.05, def: 1, order: 23 },
  { key: "driftAmount", patch: "driftAmount", label: "drift amount", min: 0, max: 4, step: 0.05, def: 1, order: 62 },
];

const LINK_KNOBS: {
  key: string;
  patch: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  def: number;
  order: number;
}[] = [
  { key: "links.opacity", patch: "linkOpacity", label: "thread brightness", min: 0, max: 1, step: 0.01, def: 0.62, order: 10 },
  { key: "links.width", patch: "linkWidth", label: "thread thickness", min: 0.5, max: 6, step: 0.1, def: 1.4, order: 11 },
  { key: "links.glow", patch: "linkGlow", label: "starlight glow", hint: "the halo bleeding off the thread and its end stars", min: 0, max: 24, step: 1, def: 9, order: 12 },
];

const LINK_TOGGLES: {
  key: string;
  patch: string;
  label: string;
  hint?: string;
  def: boolean;
  order: number;
}[] = [
  { key: "links.labels", patch: "linkLabels", label: "show constellation names", def: true, order: 14 },
  {
    key: "links.orbit",
    patch: "linkOrbit",
    label: "hold sizes steady while dragging",
    hint: "swings a hardened formation around you instead of sliding it sideways, so no member creeps closer than another",
    def: true,
    order: 21,
  },
];

const ARRANGEMENTS: { mode: ArrangeMode; label: string; glyph: string }[] = [
  { mode: "arc", label: "arrange \u2014 arc", glyph: "\u25dc" },
  { mode: "wall", label: "arrange \u2014 wall", glyph: "\u25a6" },
  { mode: "ring", label: "arrange \u2014 ring around you", glyph: "\u25cb" },
  { mode: "scatter", label: "arrange \u2014 scatter", glyph: "\u2237" },
];

export const horizon: VoidModule = {
  manifest: {
    id: "horizon",
    name: "Horizon",
    kind: "world",
    glyph: "\u2637",
    blurb: "owns how the void moves",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    const offs: (() => void)[] = [];

    for (const k of KNOBS) {
      const key = KEYS[k.key];
      ctx.defineSetting({
        key,
        label: k.label,
        hint: k.hint,
        kind: "slider",
        group: "World",
        order: k.order,
        default: k.def,
        min: k.min,
        max: k.max,
        step: k.step,
      });
      offs.push(
        ctx.state.subscribe(key, (v) => ctx.patchWorld({ [k.patch]: Number(v) }))
      );
    }

    for (const t of TOGGLES) {
      ctx.defineSetting({
        key: t.key,
        label: t.label,
        hint: t.hint,
        kind: "toggle",
        group: "World",
        order: t.order,
        default: t.def,
      });
      offs.push(
        ctx.state.subscribe(t.key, (v) => ctx.patchWorld({ [t.patch]: Boolean(v) }))
      );
    }

    for (const k of LINK_KNOBS) {
      ctx.defineSetting({
        key: k.key,
        label: k.label,
        hint: k.hint,
        kind: "slider",
        group: "Links",
        order: k.order,
        default: k.def,
        min: k.min,
        max: k.max,
        step: k.step,
      });
      offs.push(
        ctx.state.subscribe(k.key, (v) => ctx.patchWorld({ [k.patch]: Number(v) }))
      );
    }

    for (const t of LINK_TOGGLES) {
      ctx.defineSetting({
        key: t.key,
        label: t.label,
        hint: t.hint,
        kind: "toggle",
        group: "Links",
        order: t.order,
        default: t.def,
      });
      offs.push(
        ctx.state.subscribe(t.key, (v) => ctx.patchWorld({ [t.patch]: Boolean(v) }))
      );
    }

    ctx.defineSetting({
      key: "links.color",
      label: "colour for new constellations",
      hint: "recolour an existing one from its window menu, or by its thread",
      kind: "color",
      group: "Links",
      order: 13,
      default: "#4fe3d0",
    });
    offs.push(
      ctx.state.subscribe("links.color", (v) => ctx.patchWorld({ linkColor: String(v) }))
    );

    for (const a of ARRANGEMENTS) {
      ctx.defineCommand({
        id: `horizon.arrange.${a.mode}`,
        label: a.label,
        hint: "tidy every window",
        glyph: a.glyph,
        run: (c) => {
          c.arrange(a.mode);
          c.notify(`arranged \u2014 ${a.mode}`, "good");
        },
      });
    }

    ctx.defineCommand({
      id: "horizon.reset",
      label: "recentre the view",
      hint: "face the origin again",
      glyph: "\u2316",
      run: (c) => c.resetView(),
    });

    ctx.defineSetting({
      key: "world.arrange",
      label: "arrange every window",
      kind: "custom",
      group: "World",
      order: 1,
      hint: "one click to gather everything that drifted out of reach",
      render: (root, c) => {
        const row = document.createElement("div");
        row.className = "set-btnrow";
        for (const a of ARRANGEMENTS) {
          const b = document.createElement("button");
          b.className = "set-btn";
          b.textContent = a.mode;
          b.addEventListener("click", () => c.arrange(a.mode));
          row.appendChild(b);
        }
        root.appendChild(row);
      },
    });

    // Push the persisted values into the compositor once at boot.
    const flush = () => {
      const patch: Record<string, unknown> = {};
      for (const k of KNOBS) patch[k.patch] = ctx.state.get<number>(KEYS[k.key], k.def);
      for (const t of TOGGLES) patch[t.patch] = ctx.state.get<boolean>(t.key, t.def);
      for (const k of LINK_KNOBS) patch[k.patch] = ctx.state.get<number>(k.key, k.def);
      for (const t of LINK_TOGGLES) patch[t.patch] = ctx.state.get<boolean>(t.key, t.def);
      patch.linkColor = ctx.state.get<string>("links.color", "#4fe3d0");
      ctx.patchWorld(patch);
    };
    flush();

    return () => offs.forEach((off) => off());
  },
};
