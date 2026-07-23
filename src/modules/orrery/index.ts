import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";

const D2R = Math.PI / 180;
const J2000 = 2451545.0;

/** [value at J2000, change per Julian century]. Standish's table, good 1800–2050. */
interface Elements {
  a: [number, number];
  e: [number, number];
  I: [number, number];
  L: [number, number];
  peri: [number, number];
  node: [number, number];
}

interface Planet {
  id: string;
  name: string;
  /** Which theme colour it borrows, and how hard. */
  tint: "cyan" | "magenta" | "ember" | "text" | "dim";
  alpha: number;
  size: number;
  el: Elements;
}

const PLANETS: Planet[] = [
  {
    id: "mercury",
    name: "Mercury",
    tint: "dim",
    alpha: 0.95,
    size: 2.2,
    el: {
      a: [0.38709927, 0.00000037],
      e: [0.20563593, 0.00001906],
      I: [7.00497902, -0.00594749],
      L: [252.2503235, 149472.67411175],
      peri: [77.45779628, 0.16047689],
      node: [48.33076593, -0.12534081],
    },
  },
  {
    id: "venus",
    name: "Venus",
    tint: "text",
    alpha: 0.85,
    size: 3.1,
    el: {
      a: [0.72333566, 0.0000039],
      e: [0.00677672, -0.00004107],
      I: [3.39467605, -0.0007889],
      L: [181.9790995, 58517.81538729],
      peri: [131.60246718, 0.00268329],
      node: [76.67984255, -0.27769418],
    },
  },
  {
    id: "earth",
    name: "Earth",
    tint: "cyan",
    alpha: 1,
    size: 3.3,
    el: {
      a: [1.00000261, 0.00000562],
      e: [0.01671123, -0.00004392],
      I: [-0.00001531, -0.01294668],
      L: [100.46457166, 35999.37244981],
      peri: [102.93768193, 0.32327364],
      node: [0, 0],
    },
  },
  {
    id: "mars",
    name: "Mars",
    tint: "ember",
    alpha: 1,
    size: 2.6,
    el: {
      a: [1.52371034, 0.00001847],
      e: [0.0933941, 0.00007882],
      I: [1.84969142, -0.00813131],
      L: [-4.55343205, 19140.30268499],
      peri: [-23.94362959, 0.44441088],
      node: [49.55953891, -0.29257343],
    },
  },
  {
    id: "jupiter",
    name: "Jupiter",
    tint: "ember",
    alpha: 0.6,
    size: 5.4,
    el: {
      a: [5.202887, -0.00011607],
      e: [0.04838624, -0.00013253],
      I: [1.30439695, -0.00183714],
      L: [34.39644051, 3034.74612775],
      peri: [14.72847983, 0.21252668],
      node: [100.47390909, 0.20469106],
    },
  },
  {
    id: "saturn",
    name: "Saturn",
    tint: "magenta",
    alpha: 0.9,
    size: 4.6,
    el: {
      a: [9.53667594, -0.0012506],
      e: [0.05386179, -0.00050991],
      I: [2.48599187, 0.00193609],
      L: [49.95424423, 1222.49362201],
      peri: [92.59887831, -0.41897216],
      node: [113.66242448, -0.28867794],
    },
  },
];

const OUTER_EDGE = 10.1; // AU that maps to the rim of the dial

/**
 * Where the planets actually are, right now, from six numbers each.
 *
 * Keplerian elements plus their linear drift per century get you heliocentric
 * positions accurate to a few arcminutes across 1800–2050 — no ephemeris file,
 * no API, no network. The only hard part is Kepler's equation, M = E − e·sin E,
 * which has no closed form and is solved here by Newton's method in five
 * iterations. It converges in three for everything but Mercury.
 *
 * Sanity check kept in the PR: this puts the Sun's geocentric ecliptic
 * longitude at 119.82° for 2026-07-23, against an expected ~120°.
 */
export const orrery: VoidModule = {
  manifest: {
    id: "orrery",
    name: "Orrery",
    kind: "app",
    glyph: "\u2609",
    blurb: "where everything actually is",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "orrery.open",
      label: "orrery",
      hint: "find the planets",
      glyph: "\u2609",
      run: (c) => c.launch("orrery"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "orrery",
      width: 380,
      height: 430,
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

        const rows = new Map<string, HTMLElement>();
        for (const label of ["date", "selected", "from sun", "from earth", "year"]) {
          const row = document.createElement("div");
          row.className = "stage-row";
          const l = document.createElement("span");
          l.className = "stage-label";
          l.textContent = label;
          const v = document.createElement("span");
          v.className = "stage-value";
          v.textContent = "\u2014";
          row.append(l, v);
          facts.appendChild(row);
          rows.set(label, v);
        }

        let selected = "mars";
        let spread = true;
        let daysPerSecond = 0;
        let offsetDays = 0;
        /** Screen positions of the last frame, so clicks can hit a planet. */
        const screen = new Map<string, { x: number; y: number }>();

        const jdNow = () => Date.now() / 86400000 + 2440587.5 + offsetDays;

        const orbitPoint = (
          a: number,
          e: number,
          E: number,
          argp: number,
          node: number,
          inc: number
        ) => {
          const xp = a * (Math.cos(E) - e);
          const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
          const cw = Math.cos(argp);
          const sw = Math.sin(argp);
          const cn = Math.cos(node);
          const sn = Math.sin(node);
          const ci = Math.cos(inc);
          const si = Math.sin(inc);
          return {
            x: (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
            y: (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
            z: sw * si * xp + cw * si * yp,
          };
        };

        const position = (el: Elements, T: number) => {
          const a = el.a[0] + el.a[1] * T;
          const e = el.e[0] + el.e[1] * T;
          const inc = (el.I[0] + el.I[1] * T) * D2R;
          const L = el.L[0] + el.L[1] * T;
          const peri = el.peri[0] + el.peri[1] * T;
          const node = el.node[0] + el.node[1] * T;
          const argp = (peri - node) * D2R;

          let mean = (L - peri) % 360;
          if (mean < -180) mean += 360;
          if (mean > 180) mean -= 360;
          const M = mean * D2R;

          // Kepler: no closed form, so Newton it.
          let E = M + e * Math.sin(M);
          for (let i = 0; i < 5; i++) {
            E += (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E));
          }

          return orbitPoint(a, e, E, argp, node * D2R, inc);
        };

        const periodDays = (p: Planet) => (360 / p.el.L[1]) * 36525;

        const stop = mountStage(stageHost, {
          className: "orrery-canvas",
          frame: (st, dt) => {
            offsetDays += daysPerSecond * dt;

            const { g, w, h } = st;
            const c = palette();
            const tintOf = (p: Planet) => c[p.tint];
            const cx = w / 2;
            const cy = h / 2;
            const R = Math.min(w, h) * 0.44;

            // Radial squash so Mercury isn't a pixel next to Saturn's orbit.
            const rmap = (r: number) =>
              (spread ? Math.pow(r / OUTER_EDGE, 0.45) : r / OUTER_EDGE) * R;

            const jd = jdNow();
            const T = (jd - J2000) / 36525;

            g.clearRect(0, 0, w, h);

            // Sun
            const glow = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.5);
            glow.addColorStop(0, withAlpha(c.ember, 0.35));
            glow.addColorStop(1, withAlpha(c.ember, 0));
            g.fillStyle = glow;
            g.fillRect(0, 0, w, h);
            g.beginPath();
            g.arc(cx, cy, 4.5, 0, Math.PI * 2);
            g.fillStyle = withAlpha(c.ember, 1);
            g.fill();

            let earth = { x: 0, y: 0, z: 0 };
            const here = new Map<string, { x: number; y: number; z: number }>();
            for (const p of PLANETS) {
              const pos = position(p.el, T);
              here.set(p.id, pos);
              if (p.id === "earth") earth = pos;
            }

            screen.clear();

            for (const p of PLANETS) {
              const a = p.el.a[0] + p.el.a[1] * T;
              const e = p.el.e[0] + p.el.e[1] * T;
              const inc = (p.el.I[0] + p.el.I[1] * T) * D2R;
              const node = (p.el.node[0] + p.el.node[1] * T) * D2R;
              const argp = (p.el.peri[0] + p.el.peri[1] * T) * D2R - node;
              const isSel = p.id === selected;

              // Orbit, traced by sweeping eccentric anomaly. Exact, not a circle.
              g.beginPath();
              for (let i = 0; i <= 128; i++) {
                const E = (i / 128) * Math.PI * 2;
                const o = orbitPoint(a, e, E, argp, node, inc);
                const r = Math.hypot(o.x, o.y);
                const k = r === 0 ? 0 : rmap(r) / r;
                const x = cx + o.x * k;
                const y = cy - o.y * k;
                if (i === 0) g.moveTo(x, y);
                else g.lineTo(x, y);
              }
              g.closePath();
              g.strokeStyle = withAlpha(tintOf(p), isSel ? 0.5 : 0.16);
              g.lineWidth = isSel ? 1.2 : 1;
              g.stroke();

              const pos = here.get(p.id)!;
              const r = Math.hypot(pos.x, pos.y);
              const k = r === 0 ? 0 : rmap(r) / r;
              const px = cx + pos.x * k;
              const py = cy - pos.y * k;
              screen.set(p.id, { x: px, y: py });

              if (p.id === "saturn") {
                g.beginPath();
                g.ellipse(px, py, p.size * 1.9, p.size * 0.6, -0.5, 0, Math.PI * 2);
                g.strokeStyle = withAlpha(tintOf(p), 0.6);
                g.lineWidth = 1;
                g.stroke();
              }

              g.beginPath();
              g.arc(px, py, p.size, 0, Math.PI * 2);
              g.fillStyle = withAlpha(tintOf(p), p.alpha);
              g.fill();

              if (isSel) {
                g.beginPath();
                g.arc(px, py, p.size + 5, 0, Math.PI * 2);
                g.strokeStyle = withAlpha(tintOf(p), 0.7);
                g.lineWidth = 1;
                g.stroke();
                g.fillStyle = withAlpha(c.text, 0.85);
                g.font = "9px ui-monospace, monospace";
                g.fillText(p.name.toLowerCase(), px + p.size + 8, py + 3);
              }
            }

            // Facts, refreshed live because the time controls can move fast.
            const sel = PLANETS.find((p) => p.id === selected)!;
            const pos = here.get(sel.id)!;
            const sun = Math.hypot(pos.x, pos.y, pos.z);
            const dEarth = Math.hypot(
              pos.x - earth.x,
              pos.y - earth.y,
              pos.z - earth.z
            );
            const when = new Date((jd - 2440587.5) * 86400000);
            rows.get("date")!.textContent = when.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            });
            rows.get("selected")!.textContent = sel.name;
            rows.get("from sun")!.textContent = `${sun.toFixed(3)} AU`;
            rows.get("from earth")!.textContent =
              sel.id === "earth" ? "\u2014" : `${dEarth.toFixed(3)} AU`;
            const days = periodDays(sel);
            rows.get("year")!.textContent =
              days > 700 ? `${(days / 365.25).toFixed(2)} yr` : `${days.toFixed(1)} d`;
          },
        });

        /* ---------------- pointer ---------------- */

        const canvas = stageHost.querySelector("canvas");

        const onDown = (e: PointerEvent) => {
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * canvas.clientWidth;
          const py = ((e.clientY - rect.top) / rect.height) * canvas.clientHeight;
          let best = "";
          let bestD = 16;
          for (const [id, s] of screen) {
            const d = Math.hypot(px - s.x, py - s.y);
            if (d < bestD) {
              bestD = d;
              best = id;
            }
          }
          if (best) selected = best;
          e.preventDefault();
        };

        canvas?.addEventListener("pointerdown", onDown);

        /* ---------------- controls ---------------- */

        toolButton(bar, "live", (b) => {
          daysPerSecond =
            daysPerSecond === 0
              ? 1
              : daysPerSecond === 1
                ? 10
                : daysPerSecond === 10
                  ? 60
                  : 0;
          b.textContent = daysPerSecond === 0 ? "live" : `${daysPerSecond} d/s`;
          b.classList.toggle("on", daysPerSecond !== 0);
        });

        toolButton(bar, "today", () => {
          offsetDays = 0;
          ctx.notify("orrery back to now", "good");
        });

        const scaleBtn = toolButton(bar, "spread", (b) => {
          spread = !spread;
          b.textContent = spread ? "spread" : "true scale";
          b.classList.toggle("on", spread);
        });
        scaleBtn.classList.add("on");

        return () => {
          stop();
          canvas?.removeEventListener("pointerdown", onDown);
        };
      },
    });
  },
};
