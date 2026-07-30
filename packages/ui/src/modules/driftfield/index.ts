import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";

const CELL = 7;
const DECAY = 0.86;

/**
 * Conway's Life on a torus — no edges, so gliders that leave the right side
 * come back on the left forever. Dead cells don't vanish, they cool, which is
 * what turns a maths toy into something worth leaving open in the corner.
 * Drag to paint. It's the cheapest infinite wallpaper ever written.
 */
export const driftfield: VoidModule = {
  manifest: {
    id: "driftfield",
    name: "Driftfield",
    kind: "app",
    glyph: "\u2591",
    blurb: "life, cooling at the edges",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "driftfield.open",
      label: "driftfield",
      hint: "cellular drift",
      glyph: "\u2591",
      run: (c) => c.launch("driftfield"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "driftfield",
      width: 420,
      height: 340,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        let cols = 1;
        let rows = 1;
        let alive = new Uint8Array(1);
        let heat = new Float32Array(1);

        let running = true;
        let rate = 12; // generations per second
        let acc = 0;
        let generation = 0;

        const idx = (x: number, y: number) => y * cols + x;

        const reshape = (nc: number, nr: number) => {
          const na = new Uint8Array(nc * nr);
          const nh = new Float32Array(nc * nr);
          const cw = Math.min(cols, nc);
          const ch = Math.min(rows, nr);
          for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
              na[y * nc + x] = alive[y * cols + x];
              nh[y * nc + x] = heat[y * cols + x];
            }
          }
          cols = nc;
          rows = nr;
          alive = na;
          heat = nh;
        };

        const seed = (density = 0.28) => {
          for (let i = 0; i < alive.length; i++) {
            alive[i] = Math.random() < density ? 1 : 0;
            heat[i] = alive[i];
          }
          generation = 0;
        };

        const clear = () => {
          alive.fill(0);
          heat.fill(0);
          generation = 0;
        };

        /** Drop a handful of gliders in random corners, pointed random ways. */
        const gliders = () => {
          const shape = [
            [1, 0],
            [2, 1],
            [0, 2],
            [1, 2],
            [2, 2],
          ];
          for (let n = 0; n < 6; n++) {
            const ox = Math.floor(Math.random() * cols);
            const oy = Math.floor(Math.random() * rows);
            const flipX = Math.random() < 0.5;
            const flipY = Math.random() < 0.5;
            for (const [dx, dy] of shape) {
              const x = (ox + (flipX ? 2 - dx : dx) + cols) % cols;
              const y = (oy + (flipY ? 2 - dy : dy) + rows) % rows;
              alive[idx(x, y)] = 1;
              heat[idx(x, y)] = 1;
            }
          }
        };

        const step = () => {
          const next = new Uint8Array(alive.length);
          for (let y = 0; y < rows; y++) {
            const up = ((y - 1 + rows) % rows) * cols;
            const mid = y * cols;
            const down = ((y + 1) % rows) * cols;
            for (let x = 0; x < cols; x++) {
              const l = (x - 1 + cols) % cols;
              const r = (x + 1) % cols;
              const n =
                alive[up + l] +
                alive[up + x] +
                alive[up + r] +
                alive[mid + l] +
                alive[mid + r] +
                alive[down + l] +
                alive[down + x] +
                alive[down + r];
              const me = alive[mid + x];
              next[mid + x] = n === 3 || (me === 1 && n === 2) ? 1 : 0;
            }
          }
          alive = next;
          for (let i = 0; i < alive.length; i++) {
            heat[i] = alive[i] === 1 ? 1 : heat[i] * DECAY;
          }
          generation++;
        };

        const stop = mountStage(stageHost, {
          className: "drift-canvas",
          layout: (st) => {
            const nc = Math.max(4, Math.floor(st.w / CELL));
            const nr = Math.max(4, Math.floor(st.h / CELL));
            if (nc === cols && nr === rows) return;
            const first = alive.length === 1;
            reshape(nc, nr);
            if (first) seed();
          },
          frame: (st, dt) => {
            if (running) {
              acc += dt;
              const period = 1 / rate;
              let guard = 0;
              while (acc >= period && guard++ < 4) {
                acc -= period;
                step();
              }
            }

            const { g, w, h } = st;
            const c = palette();
            g.clearRect(0, 0, w, h);
            const sx = w / cols;
            const sy = h / rows;

            for (let y = 0; y < rows; y++) {
              for (let x = 0; x < cols; x++) {
                const i = idx(x, y);
                const t = heat[i];
                if (t < 0.03) continue;
                g.fillStyle =
                  alive[i] === 1
                    ? withAlpha(c.cyan, 0.35 + 0.55 * t)
                    : withAlpha(c.magenta, t * 0.4);
                g.fillRect(x * sx, y * sy, sx - 0.6, sy - 0.6);
              }
            }

            g.fillStyle = withAlpha(c.dim, 0.7);
            g.font = "9px ui-monospace, monospace";
            g.fillText(`gen ${generation}`, 6, h - 6);
          },
        });

        /* ---------------- painting ---------------- */

        const canvas = stageHost.querySelector("canvas");
        let painting = false;

        const paintAt = (clientX: number, clientY: number) => {
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const x = Math.floor(((clientX - rect.left) / rect.width) * cols);
          const y = Math.floor(((clientY - rect.top) / rect.height) * rows);
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const px = (x + dx + cols) % cols;
              const py = (y + dy + rows) % rows;
              if (px < 0 || py < 0) continue;
              alive[idx(px, py)] = 1;
              heat[idx(px, py)] = 1;
            }
          }
        };

        const onDown = (e: PointerEvent) => {
          painting = true;
          paintAt(e.clientX, e.clientY);
          canvas?.setPointerCapture(e.pointerId);
          e.preventDefault();
        };
        const onMove = (e: PointerEvent) => {
          if (painting) paintAt(e.clientX, e.clientY);
        };
        const onUp = () => {
          painting = false;
        };

        canvas?.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);

        /* ---------------- controls ---------------- */

        const playBtn = toolButton(bar, "pause", (b) => {
          running = !running;
          b.textContent = running ? "pause" : "play";
        });
        playBtn.classList.add("on");
        toolButton(bar, "seed", () => seed());
        toolButton(bar, "gliders", () => gliders());
        toolButton(bar, "clear", () => clear());
        toolButton(bar, "12/s", (b) => {
          rate = rate === 12 ? 30 : rate === 30 ? 4 : 12;
          b.textContent = `${rate}/s`;
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
