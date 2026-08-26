import type { KernelContext, VoidModule } from "../../kernel/types";

const STAR_COUNT = 360;
const Z_FAR = 1;
const Z_NEAR = 0.04;

/** z-units per second the field closes at, once eased up to. */
const TARGET_SPEED: Record<Regime, number> = { stopped: 0, cruise: 0.16, warp: 1.35 };
const REGIME_ORDER: Regime[] = ["stopped", "cruise", "warp"];
const REGIME_LABEL: Record<Regime, string> = { stopped: "full stop", cruise: "cruise", warp: "warp" };
const REGIME_FLAVOUR: Record<Regime, string> = {
  stopped: "0.00c · holding position",
  cruise: "0.62c · sublight cruise",
  warp: "9.8c · warp drive engaged",
};

type Regime = "stopped" | "cruise" | "warp";

interface Star {
  x: number; // direction from centre, -1..1
  y: number;
  z: number; // distance, Z_NEAR (about to pass you) .. Z_FAR (just spawned)
}

/**
 * A field of stars you fly through, at whatever speed you ask for.
 *
 * Every star only ever moves along one axis — its own distance, `z` — so the
 * classic streak-toward-camera effect falls out of one trick: project the
 * same (x, y) direction at last frame's `z` and this frame's `z`, and draw
 * the line between them. At full stop the two points coincide and you get a
 * dot; at warp they're far apart and you get a streak. No separate "trail"
 * state, no stored history — the streak length *is* how far the star moved,
 * which is also why it can't ever disagree with the actual speed.
 */
export const warp: VoidModule = {
  manifest: {
    id: "warp",
    name: "Warp",
    kind: "app",
    glyph: "≫",
    blurb: "punch it",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "warp.open",
      label: "warp",
      hint: "a field of stars to fly through",
      glyph: "≫",
      run: (c) => c.launch("warp"),
    });
  },

  launch(ctx: KernelContext) {
    const { mount, palette, rgbOf, toolbar, toolButton } = ctx.stage;

    ctx.openSurface({
      title: "warp",
      width: 460,
      height: 360,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);

        const facts = document.createElement("div");
        facts.className = "stage-facts";
        root.appendChild(facts);

        const bar = toolbar(root);

        const respawn = (s: Star) => {
          const r = 0.05 + Math.random() * 0.95;
          const a = Math.random() * Math.PI * 2;
          s.x = Math.cos(a) * r;
          s.y = Math.sin(a) * r;
          s.z = Z_FAR;
        };

        const stars: Star[] = Array.from({ length: STAR_COUNT }, () => {
          const s: Star = { x: 0, y: 0, z: 0 };
          respawn(s);
          s.z = Z_NEAR + Math.random() * (Z_FAR - Z_NEAR); // spread out on first mount
          return s;
        });

        let regime: Regime = "cruise";
        let speed = TARGET_SPEED.cruise;

        const refreshFacts = () => {
          facts.replaceChildren();
          const rows: [string, string][] = [
            ["velocity", REGIME_FLAVOUR[regime]],
            ["regime", REGIME_LABEL[regime]],
          ];
          for (const [label, value] of rows) {
            const row = document.createElement("div");
            row.className = "stage-row";
            const l = document.createElement("span");
            l.className = "stage-label";
            l.textContent = label;
            const v = document.createElement("span");
            v.className = "stage-value";
            v.textContent = value;
            row.append(l, v);
            facts.appendChild(row);
          }
        };

        const stop = mount(stageHost, {
          className: "warp-canvas",
          frame: (st, dt) => {
            const { g, w, h } = st;
            const c = palette();

            g.clearRect(0, 0, w, h);
            g.fillStyle = "#02020a";
            g.fillRect(0, 0, w, h);

            // Ease toward the regime's target rather than snapping — the spool-up
            // is most of what makes engaging warp read as an event rather than a
            // toggle. Exponential rather than linear so it holds up at any frame
            // rate: `1 - e^-kt` is frame-rate independent, a linear step is not.
            const target = TARGET_SPEED[regime];
            speed += (target - speed) * (1 - Math.exp(-dt * 2.2));
            if (Math.abs(speed - target) < 0.0005) speed = target;

            const cx = w / 2;
            const cy = h / 2;
            const scale = Math.min(w, h) * 0.46;
            const project = (x: number, y: number, z: number): [number, number] => [
              cx + (x / z) * scale,
              cy + (y / z) * scale,
            ];

            const t = Math.min(1, speed / TARGET_SPEED.warp);
            const [cr, cg, cb] = rgbOf(c.cyan);
            const [er, eg, eb] = rgbOf(c.ember);
            const mixR = cr + (er - cr) * t;
            const mixG = cg + (eg - cg) * t;
            const mixB = cb + (eb - cb) * t;

            g.lineCap = "round";
            for (const s of stars) {
              const zBefore = s.z;
              s.z -= speed * dt;

              if (s.z <= Z_NEAR) {
                respawn(s);
                continue; // don't draw a streak from the old point to the new one
              }

              const [x0, y0] = project(s.x, s.y, zBefore);
              const [x1, y1] = project(s.x, s.y, s.z);

              // Off-canvas in both endpoints: not worth a draw call.
              const margin = 4;
              if (
                (x0 < -margin && x1 < -margin) ||
                (x0 > w + margin && x1 > w + margin) ||
                (y0 < -margin && y1 < -margin) ||
                (y0 > h + margin && y1 > h + margin)
              ) {
                continue;
              }

              const closeness = Math.min(1, 0.06 / s.z);
              const alpha = Math.max(0.12, closeness);
              const width = Math.max(0.6, closeness * 2.6);

              g.strokeStyle = `rgba(${mixR | 0}, ${mixG | 0}, ${mixB | 0}, ${alpha.toFixed(3)})`;
              g.lineWidth = width;
              g.beginPath();
              g.moveTo(x0, y0);
              g.lineTo(x1, y1);
              g.stroke();
            }

            // A soft heat at the edges while under warp — decoration, not signal,
            // so it fades in with the same `t` that drives everything else rather
            // than being its own separate cue to keep in sync.
            if (t > 0.02) {
              const vignette = g.createRadialGradient(cx, cy, Math.min(w, h) * 0.2, cx, cy, Math.max(w, h) * 0.7);
              vignette.addColorStop(0, "rgba(0,0,0,0)");
              vignette.addColorStop(1, `rgba(${er}, ${eg}, ${eb}, ${(t * 0.22).toFixed(3)})`);
              g.fillStyle = vignette;
              g.fillRect(0, 0, w, h);
            }
          },
        });

        toolButton(bar, REGIME_LABEL[regime], (b) => {
          const i = (REGIME_ORDER.indexOf(regime) + 1) % REGIME_ORDER.length;
          regime = REGIME_ORDER[i];
          b.textContent = REGIME_LABEL[regime];
          b.classList.toggle("on", regime === "warp");
          refreshFacts();
        });

        refreshFacts();

        return () => {
          stop();
        };
      },
    });
  },
};
