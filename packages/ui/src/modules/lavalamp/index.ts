import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  rgbOf,
  toolbar,
  toolButton,
} from "../../ui/canvasStage";

const SCALE = 4; // CSS pixels per field sample
const THRESHOLD = 1;

interface Blob {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** 0 cold and sinking, 1 hot and rising. */
  temp: number;
}

/**
 * A lava lamp, which is a metaball field with opinions about temperature.
 *
 * Each blob contributes r²/d² to a scalar field; anywhere the sum crosses 1 is
 * "inside". That single rule is why two blobs bulge toward each other and then
 * merge instead of overlapping — the field between them adds up before their
 * outlines ever touch. Nothing detects collisions here. There is no collision.
 *
 * The lamp part: blobs warm near the floor and cool near the ceiling, and
 * buoyancy does the rest, so it never settles into a loop.
 */
export const lavalamp: VoidModule = {
  manifest: {
    id: "lavalamp",
    name: "Lavalamp",
    kind: "app",
    glyph: "\u234b",
    blurb: "nothing here detects collisions",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "lavalamp.open",
      label: "lavalamp",
      hint: "warm something up",
      glyph: "\u234b",
      run: (c) => c.launch("lavalamp"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "lavalamp",
      width: 260,
      height: 400,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        let w = 1;
        let h = 1;
        let fw = 1;
        let fh = 1;

        let off: HTMLCanvasElement | null = null;
        let offG: CanvasRenderingContext2D | null = null;
        let image: ImageData | null = null;

        let blobs: Blob[] = [];
        let count = 8;
        let vigour = 1;

        const spawn = (n: number) => {
          const base = Math.min(w, h);
          blobs = Array.from({ length: n }, () => ({
            x: w * (0.2 + Math.random() * 0.6),
            y: h * Math.random(),
            vx: (Math.random() - 0.5) * 12,
            vy: (Math.random() - 0.5) * 12,
            r: base * (0.1 + Math.random() * 0.09),
            temp: Math.random(),
          }));
        };

        const reshape = (nw: number, nh: number) => {
          const first = blobs.length === 0;
          w = nw;
          h = nh;
          fw = Math.max(8, Math.floor(w / SCALE));
          fh = Math.max(8, Math.floor(h / SCALE));
          off = document.createElement("canvas");
          off.width = fw;
          off.height = fh;
          offG = off.getContext("2d");
          image = offG ? offG.createImageData(fw, fh) : null;
          if (first) spawn(count);
        };

        const step = (dt: number) => {
          for (const b of blobs) {
            // Heat exchange with the floor and the ceiling.
            const depth = b.y / h;
            if (depth > 0.72) b.temp = Math.min(1, b.temp + dt * 0.22 * vigour);
            else if (depth < 0.28) b.temp = Math.max(0, b.temp - dt * 0.2 * vigour);

            // Buoyancy: hot goes up, cold comes down, nothing ever balances.
            b.vy += (0.5 - b.temp) * 46 * vigour * dt;
            b.vx += (Math.random() - 0.5) * 22 * dt;

            b.vx *= 1 - 0.9 * dt;
            b.vy *= 1 - 0.9 * dt;

            b.x += b.vx * dt;
            b.y += b.vy * dt;

            const m = b.r * 0.45;
            if (b.x < m) {
              b.x = m;
              b.vx = Math.abs(b.vx) * 0.5;
            } else if (b.x > w - m) {
              b.x = w - m;
              b.vx = -Math.abs(b.vx) * 0.5;
            }
            if (b.y < m) {
              b.y = m;
              b.vy = Math.abs(b.vy) * 0.4;
            } else if (b.y > h - m) {
              b.y = h - m;
              b.vy = -Math.abs(b.vy) * 0.4;
            }
          }
        };

        const stop = mountStage(stageHost, {
          className: "lava-canvas",
          layout: (st) => reshape(st.w, st.h),
          frame: (st, dt) => {
            step(dt);

            const { g } = st;
            if (!image || !offG || !off) return;

            const c = palette();
            const [cr, cg, cb] = rgbOf(c.cyan);
            const [mr, mg, mb] = rgbOf(c.magenta);
            const data = image.data;

            for (let y = 0; y < fh; y++) {
              const wy = (y + 0.5) * SCALE;
              for (let x = 0; x < fw; x++) {
                const wx = (x + 0.5) * SCALE;
                let field = 0;
                for (const b of blobs) {
                  const dx = wx - b.x;
                  const dy = wy - b.y;
                  const d2 = dx * dx + dy * dy;
                  if (d2 < 1) {
                    field += b.r * b.r;
                    continue;
                  }
                  field += (b.r * b.r) / d2;
                }

                const p = (y * fw + x) * 4;
                if (field < 0.55) {
                  data[p + 3] = 0;
                  continue;
                }
                // Below the threshold you get the halo; above it, the body.
                const edge = Math.min(1, (field - 0.55) / (THRESHOLD - 0.55));
                const depth = Math.min(1, Math.max(0, (field - THRESHOLD) / 1.4));
                data[p] = cr + (mr - cr) * depth;
                data[p + 1] = cg + (mg - cg) * depth;
                data[p + 2] = cb + (mb - cb) * depth;
                data[p + 3] = field >= THRESHOLD ? 200 + depth * 40 : edge * edge * 150;
              }
            }

            offG.putImageData(image, 0, 0);
            g.clearRect(0, 0, w, h);
            g.imageSmoothingEnabled = true;
            g.drawImage(off, 0, 0, w, h);
          },
        });

        toolButton(bar, `${count} blobs`, (b) => {
          count = count === 8 ? 12 : count === 12 ? 5 : 8;
          spawn(count);
          b.textContent = `${count} blobs`;
        });

        toolButton(bar, "warm", (b) => {
          vigour = vigour === 1 ? 2.2 : vigour === 2.2 ? 0.45 : 1;
          b.textContent = vigour > 2 ? "hot" : vigour < 0.5 ? "cool" : "warm";
        });

        toolButton(bar, "shake", () => {
          for (const b of blobs) {
            b.vx += (Math.random() - 0.5) * 220;
            b.vy += (Math.random() - 0.5) * 220;
          }
          ctx.notify("do not shake a real one", "warn");
        });

        return () => stop();
      },
    });
  },
};
