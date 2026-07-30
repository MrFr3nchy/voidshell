import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  rgbOf,
  toolbar,
  toolButton,
} from "../../ui/canvasStage";

const SCALE = 3; // CSS pixels per simulation cell
const MAX_DIM = 220;

/**
 * A pond. The height field is a genuine discrete wave equation — each cell is
 * pulled toward the average of its four neighbours and remembers where it was
 * last frame, which is all it takes to get propagation, reflection off the
 * walls, and interference between two drops. Damping is the only lie, and it
 * is the lie that stops the pond ringing forever.
 *
 * Shading is fake in the honest way: brightness comes from the local slope, so
 * a steep wavefront catches the light and flat water disappears into the panel.
 */
export const ripple: VoidModule = {
  manifest: {
    id: "ripple",
    name: "Ripple",
    kind: "app",
    glyph: "\u25cb",
    blurb: "drop something in and wait",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "ripple.open",
      label: "ripple",
      hint: "disturb the water",
      glyph: "\u25cb",
      run: (c) => c.launch("ripple"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "ripple",
      width: 380,
      height: 320,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        let gw = 1;
        let gh = 1;
        let cur = new Float32Array(1);
        let prev = new Float32Array(1);

        let off: HTMLCanvasElement | null = null;
        let offG: CanvasRenderingContext2D | null = null;
        let image: ImageData | null = null;

        let damping = 0.988;
        let raining = true;
        let rainAt = 0;

        const reshape = (w: number, h: number) => {
          gw = Math.max(8, Math.min(MAX_DIM, Math.floor(w / SCALE)));
          gh = Math.max(8, Math.min(MAX_DIM, Math.floor(h / SCALE)));
          cur = new Float32Array(gw * gh);
          prev = new Float32Array(gw * gh);
          off = document.createElement("canvas");
          off.width = gw;
          off.height = gh;
          offG = off.getContext("2d");
          image = offG ? offG.createImageData(gw, gh) : null;
        };

        /** Push the surface down over a small disc. Amplitude is in height units. */
        const drop = (gx: number, gy: number, amp: number, radius: number) => {
          const r = Math.max(1, Math.round(radius));
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const d = Math.hypot(dx, dy);
              if (d > r) continue;
              const x = gx + dx;
              const y = gy + dy;
              if (x < 1 || y < 1 || x >= gw - 1 || y >= gh - 1) continue;
              // Cosine falloff, so the drop has no hard edge to ring against.
              cur[y * gw + x] -= amp * (0.5 + 0.5 * Math.cos((d / r) * Math.PI));
            }
          }
        };

        const step = () => {
          for (let y = 1; y < gh - 1; y++) {
            const row = y * gw;
            for (let x = 1; x < gw - 1; x++) {
              const i = row + x;
              const v =
                ((cur[i - 1] + cur[i + 1] + cur[i - gw] + cur[i + gw]) / 2 - prev[i]) *
                damping;
              prev[i] = v;
            }
          }
          const swap = cur;
          cur = prev;
          prev = swap;
        };

        const stop = mountStage(stageHost, {
          className: "ripple-canvas",
          layout: (st) => reshape(st.w, st.h),
          frame: (st, dt) => {
            step();

            if (raining) {
              rainAt -= dt;
              if (rainAt <= 0) {
                rainAt = 0.35 + Math.random() * 0.9;
                drop(
                  2 + Math.floor(Math.random() * (gw - 4)),
                  2 + Math.floor(Math.random() * (gh - 4)),
                  70 + Math.random() * 60,
                  2
                );
              }
            }

            const { g, w, h } = st;
            if (!image || !offG || !off) return;

            const c = palette();
            const [hr, hg, hb] = rgbOf(c.cyan);
            const [tr, tg, tb] = rgbOf(c.text);
            const data = image.data;

            for (let y = 1; y < gh - 1; y++) {
              const row = y * gw;
              for (let x = 1; x < gw - 1; x++) {
                const i = row + x;
                // Slope across the cell: this is the whole lighting model.
                const sx = cur[i - 1] - cur[i + 1];
                const sy = cur[i - gw] - cur[i + gw];
                const slope = (sx + sy) * 0.006;
                const lit = Math.max(0, Math.min(1, slope));
                const dark = Math.max(0, Math.min(1, -slope));
                const energy = Math.min(1, (Math.abs(sx) + Math.abs(sy)) * 0.004);

                const p = i * 4;
                data[p] = hr + (tr - hr) * lit;
                data[p + 1] = hg + (tg - hg) * lit;
                data[p + 2] = hb + (tb - hb) * lit;
                // Troughs read as shadow by going transparent, not black, so
                // the panel's own glass shows through the way water would.
                data[p + 3] = Math.min(255, (energy * 210 + lit * 60) * (1 - dark * 0.5));
              }
            }

            offG.putImageData(image, 0, 0);
            g.clearRect(0, 0, w, h);
            g.imageSmoothingEnabled = true;
            g.drawImage(off, 0, 0, w, h);
          },
        });

        /* ---------------- pointer ---------------- */

        const canvas = stageHost.querySelector("canvas");
        let dragging = false;

        const dropAt = (clientX: number, clientY: number, amp: number) => {
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const gx = Math.floor(((clientX - rect.left) / rect.width) * gw);
          const gy = Math.floor(((clientY - rect.top) / rect.height) * gh);
          drop(gx, gy, amp, 3);
        };

        const onDown = (e: PointerEvent) => {
          dragging = true;
          dropAt(e.clientX, e.clientY, 220);
          canvas?.setPointerCapture(e.pointerId);
          e.preventDefault();
        };
        const onMove = (e: PointerEvent) => {
          if (dragging) dropAt(e.clientX, e.clientY, 70);
        };
        const onUp = () => {
          dragging = false;
        };

        canvas?.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);

        /* ---------------- controls ---------------- */

        const rainBtn = toolButton(bar, "rain", (b) => {
          raining = !raining;
          b.classList.toggle("on", raining);
        });
        rainBtn.classList.toggle("on", raining);

        toolButton(bar, "calm", (b) => {
          damping = damping > 0.99 ? 0.978 : damping > 0.98 ? 0.988 : 0.996;
          b.textContent =
            damping > 0.994 ? "glassy" : damping > 0.984 ? "calm" : "choppy";
        });

        toolButton(bar, "still", () => {
          cur.fill(0);
          prev.fill(0);
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
