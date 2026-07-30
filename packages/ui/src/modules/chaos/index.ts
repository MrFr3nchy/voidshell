import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";

const G = 9.81;
const L1 = 1;
const L2 = 1;
const M1 = 1;
const M2 = 1;
const SUBSTEPS = 8;
const TRACE = 900;
/** How far apart the twin starts. One part in a million. */
const NUDGE = 1e-6;

/** [theta1, theta2, omega1, omega2] */
type State = [number, number, number, number];

/**
 * A double pendulum, which is the cheapest honest demonstration of chaos there
 * is. Two rods, no friction, no randomness anywhere — the motion is fully
 * determined by where you let go. And yet.
 *
 * Turn on the twin. It starts one millionth of a radian away from the first,
 * a difference far too small to see. Both are integrated by the same code with
 * the same numbers. They track each other for about eight seconds and then
 * come apart completely, and no amount of extra precision would save you: it
 * would only buy a few more seconds before the same thing happened.
 *
 * The energy readout is there to prove the divergence isn't the integrator
 * cheating. RK4 at 8 substeps a frame holds total energy to about one part in
 * a million over two minutes, which is orders of magnitude smaller than the
 * separation it's being blamed for.
 */
export const chaos: VoidModule = {
  manifest: {
    id: "chaos",
    name: "Chaos",
    kind: "app",
    glyph: "\u21af",
    blurb: "two rods, no randomness, no hope",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "chaos.open",
      label: "chaos",
      hint: "diverge something",
      glyph: "\u21af",
      run: (c) => c.launch("chaos"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "chaos",
      width: 380,
      height: 420,
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
        for (const label of ["elapsed", "separation", "energy drift"]) {
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

        let a: State = [2.2, 2.0, 0, 0];
        let b: State = [2.2 + NUDGE, 2.0, 0, 0];
        let baseline = energy(a);
        let elapsed = 0;
        let twin = true;
        let tracing = true;

        const trailA: [number, number][] = [];
        const trailB: [number, number][] = [];

        const restart = (t1 = 2.2, t2 = 2.0) => {
          a = [t1, t2, 0, 0];
          b = [t1 + NUDGE, t2, 0, 0];
          baseline = energy(a);
          elapsed = 0;
          trailA.length = 0;
          trailB.length = 0;
        };

        let scale = 60;
        let cx = 0;
        let cy = 0;

        const bobs = (s: State) => {
          const x1 = cx + Math.sin(s[0]) * L1 * scale;
          const y1 = cy + Math.cos(s[0]) * L1 * scale;
          return {
            x1,
            y1,
            x2: x1 + Math.sin(s[1]) * L2 * scale,
            y2: y1 + Math.cos(s[1]) * L2 * scale,
          };
        };

        const drawArm = (
          g: CanvasRenderingContext2D,
          s: State,
          color: string,
          alpha: number
        ) => {
          const p = bobs(s);
          g.strokeStyle = withAlpha(color, alpha * 0.7);
          g.lineWidth = 1.4;
          g.beginPath();
          g.moveTo(cx, cy);
          g.lineTo(p.x1, p.y1);
          g.lineTo(p.x2, p.y2);
          g.stroke();
          g.fillStyle = withAlpha(color, alpha);
          g.beginPath();
          g.arc(p.x1, p.y1, 4, 0, Math.PI * 2);
          g.fill();
          g.beginPath();
          g.arc(p.x2, p.y2, 5.5, 0, Math.PI * 2);
          g.fill();
        };

        const drawTrail = (
          g: CanvasRenderingContext2D,
          trail: [number, number][],
          color: string
        ) => {
          if (trail.length < 2) return;
          g.lineWidth = 1;
          for (let i = 1; i < trail.length; i++) {
            g.strokeStyle = withAlpha(color, (i / trail.length) * 0.5);
            g.beginPath();
            g.moveTo(trail[i - 1][0], trail[i - 1][1]);
            g.lineTo(trail[i][0], trail[i][1]);
            g.stroke();
          }
        };

        const stop = mountStage(stageHost, {
          className: "chaos-canvas",
          layout: (st) => {
            cx = st.w / 2;
            cy = st.h * 0.36;
            scale = Math.min(st.w, st.h) * 0.22;
            trailA.length = 0;
            trailB.length = 0;
          },
          frame: (st, dt) => {
            const h = dt / SUBSTEPS;
            for (let s = 0; s < SUBSTEPS; s++) {
              a = rk4(a, h);
              if (twin) b = rk4(b, h);
            }
            elapsed += dt;

            const pa = bobs(a);
            trailA.push([pa.x2, pa.y2]);
            if (trailA.length > TRACE) trailA.shift();
            if (twin) {
              const pb = bobs(b);
              trailB.push([pb.x2, pb.y2]);
              if (trailB.length > TRACE) trailB.shift();
            }

            const { g, w, h: hh } = st;
            const c = palette();
            g.clearRect(0, 0, w, hh);

            if (tracing) {
              if (twin) drawTrail(g, trailB, c.magenta);
              drawTrail(g, trailA, c.cyan);
            }

            // Pivot
            g.fillStyle = withAlpha(c.dim, 0.6);
            g.beginPath();
            g.arc(cx, cy, 3, 0, Math.PI * 2);
            g.fill();

            if (twin) drawArm(g, b, c.magenta, 0.75);
            drawArm(g, a, c.cyan, 0.95);

            const sep = twin
              ? Math.hypot(wrap(a[0] - b[0]), wrap(a[1] - b[1]))
              : 0;
            rows.get("elapsed")!.textContent = `${elapsed.toFixed(1)} s`;
            rows.get("separation")!.textContent = twin
              ? `${sep.toExponential(2)} rad`
              : "\u2014";
            const drift = ((energy(a) - baseline) / Math.abs(baseline)) * 100;
            rows.get("energy drift")!.textContent = `${drift.toFixed(6)} %`;
          },
        });

        /* ---------------- pointer ---------------- */

        const canvas = stageHost.querySelector("canvas");
        let grabbed = 0; // 1 = upper bob, 2 = lower bob

        const toLocal = (e: PointerEvent) => {
          if (!canvas) return null;
          const rect = canvas.getBoundingClientRect();
          return {
            x: ((e.clientX - rect.left) / rect.width) * canvas.clientWidth,
            y: ((e.clientY - rect.top) / rect.height) * canvas.clientHeight,
          };
        };

        const onDown = (e: PointerEvent) => {
          const p = toLocal(e);
          if (!p) return;
          const q = bobs(a);
          if (Math.hypot(p.x - q.x2, p.y - q.y2) < 18) grabbed = 2;
          else if (Math.hypot(p.x - q.x1, p.y - q.y1) < 18) grabbed = 1;
          else return;
          canvas?.setPointerCapture(e.pointerId);
          e.preventDefault();
        };

        const onMove = (e: PointerEvent) => {
          if (!grabbed) return;
          const p = toLocal(e);
          if (!p) return;
          if (grabbed === 1) {
            const t1 = Math.atan2(p.x - cx, p.y - cy);
            restart(t1, a[1]);
          } else {
            const q = bobs(a);
            const t2 = Math.atan2(p.x - q.x1, p.y - q.y1);
            restart(a[0], t2);
          }
        };

        const onUp = () => {
          grabbed = 0;
        };

        canvas?.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);

        /* ---------------- controls ---------------- */

        const twinBtn = toolButton(bar, "twin", (btn) => {
          twin = !twin;
          btn.classList.toggle("on", twin);
          trailB.length = 0;
          if (twin) b = [a[0] + NUDGE, a[1], a[2], a[3]];
        });
        twinBtn.classList.add("on");

        const traceBtn = toolButton(bar, "trace", (btn) => {
          tracing = !tracing;
          btn.classList.toggle("on", tracing);
        });
        traceBtn.classList.add("on");

        toolButton(bar, "restart", () => restart());

        toolButton(bar, "random", () => {
          restart(
            (Math.random() - 0.5) * 5,
            (Math.random() - 0.5) * 5
          );
          ctx.notify("released from somewhere new", "info");
        });

        return () => {
          stop();
          canvas?.removeEventListener("pointerdown", onDown);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
      },
    });
  },
};

/** The equations of motion, straight off the Lagrangian. */
function derivative(s: State): State {
  const [t1, t2, w1, w2] = s;
  const d = t1 - t2;
  const den = 2 * M1 + M2 - M2 * Math.cos(2 * d);
  const a1 =
    (-G * (2 * M1 + M2) * Math.sin(t1) -
      M2 * G * Math.sin(t1 - 2 * t2) -
      2 *
        Math.sin(d) *
        M2 *
        (w2 * w2 * L2 + w1 * w1 * L1 * Math.cos(d))) /
    (L1 * den);
  const a2 =
    (2 *
      Math.sin(d) *
      (w1 * w1 * L1 * (M1 + M2) +
        G * (M1 + M2) * Math.cos(t1) +
        w2 * w2 * L2 * M2 * Math.cos(d))) /
    (L2 * den);
  return [w1, w2, a1, a2];
}

/**
 * Classic RK4. Euler would bleed energy fast enough that you could fairly
 * accuse the integrator of causing the divergence; this doesn't.
 */
function rk4(s: State, h: number): State {
  const add = (base: State, k: State, f: number): State => [
    base[0] + k[0] * f,
    base[1] + k[1] * f,
    base[2] + k[2] * f,
    base[3] + k[3] * f,
  ];
  const k1 = derivative(s);
  const k2 = derivative(add(s, k1, h / 2));
  const k3 = derivative(add(s, k2, h / 2));
  const k4 = derivative(add(s, k3, h));
  return [
    s[0] + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
    s[1] + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
    s[2] + (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]),
    s[3] + (h / 6) * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]),
  ];
}

/** Kinetic plus potential. Should not move. Watch it not move. */
function energy(s: State): number {
  const [t1, t2, w1, w2] = s;
  const kinetic =
    0.5 * M1 * (L1 * w1) ** 2 +
    0.5 *
      M2 *
      ((L1 * w1) ** 2 +
        (L2 * w2) ** 2 +
        2 * L1 * L2 * w1 * w2 * Math.cos(t1 - t2));
  const potential = -(M1 + M2) * G * L1 * Math.cos(t1) - M2 * G * L2 * Math.cos(t2);
  return kinetic + potential;
}

/** Angles are unbounded here, so compare them on the circle. */
function wrap(x: number): number {
  const t = ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
}
