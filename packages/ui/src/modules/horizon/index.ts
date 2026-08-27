import type { ArrangeMode, KernelContext, StationKind, VoidModule } from "../../kernel/types";

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
  meteorRate: "world.meteorRate",
  starTwinkle: "world.starTwinkle",
  bloom: "world.bloom",
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
    key: "world.radar",
    patch: "radar",
    label: "spatial radar",
    hint: "a heading-up minimap of the void in the corner \u2014 click a blip to fly or face it",
    def: true,
    order: 6,
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
  {
    key: "world.meteors",
    patch: "meteors",
    label: "meteor shower",
    hint: "occasional streaks across the real sky, on their own schedule",
    def: false,
    order: 63,
  },
  {
    key: "world.warp",
    patch: "warp",
    label: "engage warp",
    hint: "the dust stretches into streaks and the sky rushes past",
    def: false,
    order: 64,
  },
  {
    key: "world.cameraRoll",
    patch: "cameraRoll",
    label: "camera roll",
    hint: "a slight bank into a fast turn, like a ship rather than a menu",
    def: true,
    order: 7,
  },
  {
    key: "world.clickEcho",
    patch: "clickEcho",
    label: "click echo",
    hint: "a soft ring where you click in open space",
    def: true,
    order: 8,
  },
  {
    key: "world.inertia",
    patch: "inertia",
    label: "window inertia",
    hint: "a thrown window keeps a little momentum instead of stopping dead",
    def: true,
    order: 26,
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
  { key: "meteorRate", patch: "meteorRate", label: "meteor rate", min: 1, max: 20, step: 1, def: 6, order: 65, hint: "meteors per minute, on average, while the shower is on" },
  { key: "starTwinkle", patch: "starTwinkle", label: "star twinkle", min: 0, max: 1, step: 0.05, def: 0, order: 68, hint: "a faint shimmer in the starfield behind the nebula" },
  { key: "bloom", patch: "bloom", label: "bloom", min: 0.5, max: 2.5, step: 0.05, def: 1, order: 24, hint: "brightens the nebula and every glow together" },
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
    key: "links.pulse",
    patch: "linkPulse",
    label: "thread pulse",
    hint: "brightness breathes instead of sitting flat",
    def: false,
    order: 15,
  },
  {
    key: "links.orbit",
    patch: "linkOrbit",
    label: "new constellations start loose",
    hint: "a loose bond swings the formation around you instead of sliding it sideways, so no member creeps closer than another \u2014 click a thread, or use a window's menu, to harden or loosen one",
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

const STATION_KINDS: { kind: StationKind; label: string; glyph: string }[] = [
  { kind: "rock", label: "found a station \u2014 rocky outpost", glyph: "\u25c9" },
  { kind: "giant", label: "found a station \u2014 gas giant", glyph: "\u25d5" },
  { kind: "ring", label: "found a station \u2014 ring waystation", glyph: "\u29b8" },
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

    ctx.defineSetting({
      key: "world.meteorColor",
      label: "comet colour",
      hint: "tints meteor streaks independent of the sky's warm pole",
      kind: "color",
      group: "World",
      order: 67,
      default: "#ffe6b0",
    });
    offs.push(
      ctx.state.subscribe("world.meteorColor", (v) =>
        ctx.patchWorld({ meteorColor: hexToNum(String(v)) })
      )
    );

    // Warp hum: strung tone() bursts stand in for a loop the audio API
    // deliberately doesn't offer — nothing here holds a context open past a
    // click, it's just retriggered often enough to read as sustained.
    ctx.defineSetting({
      key: "world.warpSound",
      label: "warp hum",
      hint: "a low engine hum while warp is engaged",
      kind: "toggle",
      group: "World",
      order: 66,
      default: true,
    });
    let humTimer: number | undefined;
    const stopHum = () => {
      if (humTimer !== undefined) {
        window.clearInterval(humTimer);
        humTimer = undefined;
      }
    };
    const syncHum = () => {
      const on =
        ctx.state.get<boolean>("world.warp", false) &&
        ctx.state.get<boolean>("world.warpSound", true);
      if (on && humTimer === undefined) {
        humTimer = window.setInterval(() => {
          ctx.audio.tone({
            freq: 55 + Math.random() * 18,
            toFreq: 34,
            wave: "sawtooth",
            gain: 0.05,
            decay: 0.5,
          });
        }, 420);
      } else if (!on) {
        stopHum();
      }
    };
    offs.push(ctx.state.subscribe("world.warp", syncHum));
    offs.push(ctx.state.subscribe("world.warpSound", syncHum));
    offs.push(stopHum);
    syncHum();

    // Screensaver: idles the ambient toggles on, remembers what they were,
    // and puts them back the moment there's real input again.
    ctx.defineSetting({
      key: "world.screensaver",
      label: "screensaver when idle",
      hint: "storms, meteors and warp switch on after a stretch with no input, and back off the moment you touch anything",
      kind: "toggle",
      group: "World",
      order: 70,
      default: false,
    });
    ctx.defineSetting({
      key: "world.screensaverMinutes",
      label: "idle minutes",
      kind: "slider",
      group: "World",
      order: 71,
      default: 5,
      min: 1,
      max: 30,
      step: 1,
    });
    const SCREENSAVER_TOGGLES = ["world.storms", "world.meteors", "world.warp"] as const;
    let screensaverOn = false;
    let saved: Record<string, boolean> | null = null;
    let idleTimer: number | undefined;
    const armIdleTimer = () => {
      if (idleTimer !== undefined) {
        window.clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (!ctx.state.get<boolean>("world.screensaver", false) || screensaverOn) return;
      const minutes = ctx.state.get<number>("world.screensaverMinutes", 5);
      idleTimer = window.setTimeout(() => {
        saved = Object.fromEntries(
          SCREENSAVER_TOGGLES.map((k) => [k, ctx.state.get<boolean>(k, false)])
        );
        screensaverOn = true;
        for (const k of SCREENSAVER_TOGGLES) ctx.state.set(k, true);
      }, minutes * 60_000);
    };
    const wake = () => {
      if (screensaverOn && saved) {
        for (const k of SCREENSAVER_TOGGLES) ctx.state.set(k, saved[k]);
        saved = null;
        screensaverOn = false;
      }
      armIdleTimer();
    };
    const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, wake, { passive: true });
    offs.push(() => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, wake);
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
    });
    offs.push(ctx.state.subscribe("world.screensaver", wake));
    offs.push(ctx.state.subscribe("world.screensaverMinutes", armIdleTimer));
    armIdleTimer();

    // Depth haze and the compass trail are CSS-only: no compositor tunable to
    // own, just a root custom property the stylesheet already multiplies by
    // (--vs-depth-fade, --pip-speed), so patchWorld has nothing to do here.
    ctx.defineSetting({
      key: "world.depthHaze",
      label: "depth haze",
      hint: "distant windows lose a little colour, as if seen through more space",
      kind: "toggle",
      group: "World",
      order: 27,
      default: false,
    });
    ctx.defineSetting({
      key: "world.compassTrail",
      label: "compass trail",
      hint: "an off-screen window swinging past fast glows on its edge pip",
      kind: "toggle",
      group: "World",
      order: 28,
      default: true,
    });
    const root = document.documentElement;
    const applyHaze = () =>
      root.style.setProperty(
        "--vs-haze",
        ctx.state.get<boolean>("world.depthHaze", false) ? "1" : "0"
      );
    const applyCompassTrail = () =>
      root.style.setProperty(
        "--vs-compass-trail",
        ctx.state.get<boolean>("world.compassTrail", true) ? "1" : "0"
      );
    offs.push(ctx.state.subscribe("world.depthHaze", applyHaze));
    offs.push(ctx.state.subscribe("world.compassTrail", applyCompassTrail));
    offs.push(() => {
      root.style.removeProperty("--vs-haze");
      root.style.removeProperty("--vs-compass-trail");
    });
    applyHaze();
    applyCompassTrail();

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

    // Creation and travel live in the command palette, the void's own
    // right-click menu, and the status bar's stations pill \u2014 never behind a
    // window that has to stay open, which is what made travelling anywhere
    // a second time mean reopening the thing that sent you there.
    for (const s of STATION_KINDS) {
      ctx.defineCommand({
        id: `horizon.station.${s.kind}`,
        label: s.label,
        hint: "a fixed place, out where you're looking \u2014 travel to it later from the status bar",
        glyph: s.glyph,
        run: (c) => {
          c.spawnStation(s.kind);
          c.notify("founded \u2014 travel to it from the stations pill", "good");
        },
      });
    }

    ctx.defineCommand({
      id: "horizon.travelHome",
      label: "travel home",
      hint: "back to the sun at the origin, from wherever you've travelled to",
      glyph: "\u2609",
      run: (c) => {
        c.travelHome();
        c.notify("travelling home\u2026", "good");
      },
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
      patch.meteorColor = hexToNum(ctx.state.get<string>("world.meteorColor", "#ffe6b0"));
      ctx.patchWorld(patch);
    };
    flush();

    return () => offs.forEach((off) => off());
  },
};

function hexToNum(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(n) ? n : 0x000000;
}
