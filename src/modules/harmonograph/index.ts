import type { KernelContext, VoidModule } from "../../kernel/types";
import { mountStage, palette, toolbar, toolButton } from "../../ui/canvasStage";

const T_MAX = 68; // pendulum-seconds before a figure is considered finished
const STEP = 0.002;
const HOLD = 2.4;
const FADE = 1.8;

interface Pen {
  a: number;
  f: number;
  p: number;
  d: number;
}

/**
 * A harmonograph is four pendulums and a pen: two swinging the paper, two
 * swinging the arm, all of them slowly running out of energy. Set the
 * frequencies to a near-ratio like 3:2 and detune them by a hair — the drift
 * between them is what opens the rosette out into a solid. Every figure here
 * is drawn once, held, faded, and replaced by a new random one.
 */
export const harmonograph: VoidModule = {
  manifest: {
    id: "harmonograph",
    name: "Harmonograph",
    kind: "app",
    glyph: "\u223f",
    blurb: "four dying pendulums and a pen",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "harmonograph.open",
      label: "harmonograph",
      hint: "draw something slow",
      glyph: "\u223f",
      run: (c) => c.launch("harmonograph"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "harmonograph",
      width: 360,
      height: 360,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        let off: HTMLCanvasElement | null = null;
        let offG: CanvasRenderingContext2D | null = null;

        let pens: Pen[] = [];
        let t = 0;
        let phase: "draw" | "hold" | "fade" = "draw";
        let phaseAt = 0;
        let speed = 1;
        let ratio = "";

        const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

        const newFigure = () => {
          // Near-integer frequency ratios are what make it look designed.
          const base = rand(1.6, 2.6);
          const nums = [1, 2, 3, 3, 4, 5];
          const a = nums[Math.floor(Math.random() * nums.length)];
          const b = nums[Math.floor(Math.random() * nums.length)];
          ratio = `${a}:${b}`;
          const detune = () => rand(-0.012, 0.012);
          pens = [
            { a: rand(0.5, 1), f: base * a + detune(), p: rand(0, 6.28), d: rand(0.012, 0.04) },
            { a: rand(0.2, 0.6), f: base * b + detune(), p: rand(0, 6.28), d: rand(0.012, 0.04) },
            { a: rand(0.5, 1), f: base * b + detune(), p: rand(0, 6.28), d: rand(0.012, 0.04) },
            { a: rand(0.2, 0.6), f: base * a + detune(), p: rand(0, 6.28), d: rand(0.012, 0.04) },
          ];
          t = 0;
          phase = "draw";
          phaseAt = 0;
          offG?.clearRect(0, 0, off?.width ?? 0, off?.height ?? 0);
        };

        const sample = (time: number, i: number, j: number) => {
          const u = pens[i];
          const v = pens[j];
          return (
            u.a * Math.sin(u.f * time + u.p) * Math.exp(-u.d * time) +
            v.a * Math.sin(v.f * time + v.p) * Math.exp(-v.d * time)
          );
        };

        const stop = mountStage(stageHost, {
          className: "harm-canvas",
          layout: (st) => {
            off = document.createElement("canvas");
            off.width = Math.round(st.w * st.dpr);
            off.height = Math.round(st.h * st.dpr);
            offG = off.getContext("2d");
            offG?.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
            offG?.clearRect(0, 0, st.w, st.h);
            newFigure();
          },
          frame: (st, dt) => {
            const { g, w, h } = st;
            const c = palette();
            const R = Math.min(w, h) * 0.42;
            const cx = w / 2;
            const cy = h / 2;

            if (offG) {
              if (phase === "draw") {
                const target = Math.min(T_MAX, t + dt * 3.2 * speed);
                offG.lineWidth = 1.1;
                offG.lineCap = "round";
                let prevX = cx + sample(t, 0, 1) * R;
                let prevY = cy + sample(t, 2, 3) * R;
                for (let time = t + STEP; time <= target; time += STEP) {
                  const x = cx + sample(time, 0, 1) * R;
                  const y = cy + sample(time, 2, 3) * R;
                  const mix = time / T_MAX;
                  offG.strokeStyle = `color-mix(in srgb, ${c.cyan} ${Math.round(
                    (1 - mix) * 100
                  )}%, ${c.magenta})`;
                  offG.globalAlpha = 0.55;
                  offG.beginPath();
                  offG.moveTo(prevX, prevY);
                  offG.lineTo(x, y);
                  offG.stroke();
                  prevX = x;
                  prevY = y;
                }
                offG.globalAlpha = 1;
                t = target;
                if (t >= T_MAX) {
                  phase = "hold";
                  phaseAt = 0;
                }
              } else if (phase === "hold") {
                phaseAt += dt;
                if (phaseAt >= HOLD) {
                  phase = "fade";
                  phaseAt = 0;
                }
              } else {
                phaseAt += dt;
                offG.globalCompositeOperation = "destination-out";
                offG.fillStyle = `rgba(0,0,0,${Math.min(0.2, (dt / FADE) * 2.2)})`;
                offG.fillRect(0, 0, w, h);
                offG.globalCompositeOperation = "source-over";
                if (phaseAt >= FADE) newFigure();
              }
            }

            g.clearRect(0, 0, w, h);
            if (off) g.drawImage(off, 0, 0, w, h);

            g.fillStyle = c.dim;
            g.globalAlpha = 0.7;
            g.font = "9px ui-monospace, monospace";
            g.fillText(ratio, 6, h - 6);
            g.globalAlpha = 1;
          },
        });

        toolButton(bar, "new figure", () => newFigure());
        toolButton(bar, "1\u00d7", (b) => {
          speed = speed === 1 ? 2.5 : speed === 2.5 ? 0.4 : 1;
          b.textContent = `${speed}\u00d7`;
        });

        return () => stop();
      },
    });
  },
};
