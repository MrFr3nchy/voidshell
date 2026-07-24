import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";

const CELL = 4;

const EMPTY = 0;
const SAND = 1;
const WATER = 2;
const STONE = 3;
const SPARK = 4;

type Material = typeof SAND | typeof WATER | typeof STONE | typeof SPARK;

/**
 * A falling-sand box. Four materials, one rule each, applied bottom-up so a
 * grain never falls twice in a frame. Nothing is scripted: water finds its
 * level because it tries down, then down-diagonal, then sideways, and that's
 * the entire fluid model. Leave the drizzle on and it plays with itself.
 */
export const sandbox: VoidModule = {
  manifest: {
    id: "sandbox",
    name: "Sandbox",
    kind: "app",
    glyph: "\u2058",
    blurb: "sand, water, and bad decisions",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "sandbox.open",
      label: "sandbox",
      hint: "pour something",
      glyph: "\u2058",
      run: (c) => c.launch("sandbox"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "sandbox",
      width: 380,
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
        let cells = new Uint8Array(1);
        let life = new Uint8Array(1);
        let moved = new Uint8Array(1);

        let brush: Material = SAND;
        let drizzle = true;
        let brushSize = 3;

        const at = (x: number, y: number) => y * cols + x;
        const inside = (x: number, y: number) =>
          x >= 0 && y >= 0 && x < cols && y < rows;

        const reshape = (nc: number, nr: number) => {
          const nCells = new Uint8Array(nc * nr);
          const nLife = new Uint8Array(nc * nr);
          const cw = Math.min(cols, nc);
          const ch = Math.min(rows, nr);
          // Anchor to the bottom — the pile you built should stay on the floor.
          for (let y = 0; y < ch; y++) {
            const src = (rows - 1 - y) * cols;
            const dst = (nr - 1 - y) * nc;
            for (let x = 0; x < cw; x++) {
              nCells[dst + x] = cells[src + x];
              nLife[dst + x] = life[src + x];
            }
          }
          cols = nc;
          rows = nr;
          cells = nCells;
          life = nLife;
          moved = new Uint8Array(nc * nr);
        };

        const swap = (a: number, b: number) => {
          const c = cells[a];
          cells[a] = cells[b];
          cells[b] = c;
          const l = life[a];
          life[a] = life[b];
          life[b] = l;
          moved[b] = 1;
        };

        const step = () => {
          moved.fill(0);
          for (let y = rows - 1; y >= 0; y--) {
            const leftFirst = Math.random() < 0.5;
            for (let n = 0; n < cols; n++) {
              const x = leftFirst ? n : cols - 1 - n;
              const i = at(x, y);
              const kind = cells[i];
              if (kind === EMPTY || kind === STONE || moved[i]) continue;

              if (kind === SPARK) {
                if (life[i] <= 1) {
                  cells[i] = EMPTY;
                  life[i] = 0;
                  continue;
                }
                life[i]--;
                const dirs: [number, number][] = [
                  [0, -1],
                  [Math.random() < 0.5 ? -1 : 1, -1],
                  [Math.random() < 0.5 ? -1 : 1, 0],
                ];
                for (const [dx, dy] of dirs) {
                  const nx = x + dx;
                  const ny = y + dy;
                  if (!inside(nx, ny)) continue;
                  const j = at(nx, ny);
                  if (cells[j] === WATER) {
                    cells[i] = EMPTY; // steam, conceptually
                    life[i] = 0;
                    break;
                  }
                  if (cells[j] === EMPTY) {
                    swap(i, j);
                    break;
                  }
                }
                continue;
              }

              const below = y + 1 < rows ? at(x, y + 1) : -1;
              if (below >= 0) {
                const under = cells[below];
                if (under === EMPTY || (kind === SAND && under === WATER)) {
                  swap(i, below);
                  continue;
                }
              }

              const side = Math.random() < 0.5 ? -1 : 1;
              let settled = false;
              for (const dx of [side, -side]) {
                const nx = x + dx;
                const ny = y + 1;
                if (!inside(nx, ny)) continue;
                const j = at(nx, ny);
                if (cells[j] === EMPTY || (kind === SAND && cells[j] === WATER)) {
                  swap(i, j);
                  settled = true;
                  break;
                }
              }
              if (settled || kind !== WATER) continue;

              // Water alone spreads flat when it can't fall.
              for (const dx of [side, -side]) {
                const nx = x + dx;
                if (!inside(nx, y)) continue;
                const j = at(nx, y);
                if (cells[j] === EMPTY) {
                  swap(i, j);
                  break;
                }
              }
            }
          }

          if (drizzle) {
            for (let n = 0; n < 3; n++) {
              const x = Math.floor(Math.random() * cols);
              const i = at(x, 0);
              if (cells[i] !== EMPTY) continue;
              cells[i] = Math.random() < 0.7 ? SAND : WATER;
            }
          }
        };

        const paint = (cx: number, cy: number) => {
          const r = brushSize;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (dx * dx + dy * dy > r * r) continue;
              const x = cx + dx;
              const y = cy + dy;
              if (!inside(x, y)) continue;
              const i = at(x, y);
              cells[i] = brush;
              life[i] = brush === SPARK ? 40 + Math.floor(Math.random() * 30) : 0;
            }
          }
        };

        const stop = mountStage(stageHost, {
          className: "sand-canvas",
          layout: (st) => {
            const nc = Math.max(8, Math.floor(st.w / CELL));
            const nr = Math.max(8, Math.floor(st.h / CELL));
            if (nc !== cols || nr !== rows) reshape(nc, nr);
          },
          frame: (st) => {
            step();

            const { g, w, h } = st;
            const c = palette();
            g.clearRect(0, 0, w, h);
            const sx = w / cols;
            const sy = h / rows;

            for (let y = 0; y < rows; y++) {
              for (let x = 0; x < cols; x++) {
                const i = at(x, y);
                const kind = cells[i];
                if (kind === EMPTY) continue;
                if (kind === SAND) g.fillStyle = withAlpha(c.ember, 0.85);
                else if (kind === WATER) g.fillStyle = withAlpha(c.cyan, 0.5);
                else if (kind === STONE) g.fillStyle = withAlpha(c.dim, 0.75);
                else g.fillStyle = withAlpha(c.magenta, 0.35 + life[i] / 90);
                g.fillRect(x * sx, y * sy, sx + 0.5, sy + 0.5);
              }
            }
          },
        });

        /* ---------------- pointer ---------------- */

        const canvas = stageHost.querySelector("canvas");
        let pouring = false;
        let lastX = 0;
        let lastY = 0;

        const toCell = (clientX: number, clientY: number) => {
          const rect = canvas?.getBoundingClientRect();
          if (!rect) return null;
          return {
            x: Math.floor(((clientX - rect.left) / rect.width) * cols),
            y: Math.floor(((clientY - rect.top) / rect.height) * rows),
          };
        };

        const onDown = (e: PointerEvent) => {
          const p = toCell(e.clientX, e.clientY);
          if (!p) return;
          pouring = true;
          lastX = p.x;
          lastY = p.y;
          paint(p.x, p.y);
          canvas?.setPointerCapture(e.pointerId);
          e.preventDefault();
        };
        const onMove = (e: PointerEvent) => {
          if (!pouring) return;
          const p = toCell(e.clientX, e.clientY);
          if (!p) return;
          // Interpolate, or a fast drag draws a dotted line instead of a stroke.
          const steps = Math.max(1, Math.hypot(p.x - lastX, p.y - lastY) | 0);
          for (let s = 1; s <= steps; s++) {
            paint(
              Math.round(lastX + ((p.x - lastX) * s) / steps),
              Math.round(lastY + ((p.y - lastY) * s) / steps)
            );
          }
          lastX = p.x;
          lastY = p.y;
        };
        const onUp = () => {
          pouring = false;
        };

        canvas?.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);

        /* ---------------- controls ---------------- */

        const picks: { label: string; kind: Material }[] = [
          { label: "sand", kind: SAND },
          { label: "water", kind: WATER },
          { label: "stone", kind: STONE },
          { label: "spark", kind: SPARK },
        ];
        const buttons: HTMLButtonElement[] = [];
        for (const p of picks) {
          const b = toolButton(bar, p.label, () => {
            brush = p.kind;
            for (const other of buttons) other.classList.remove("on");
            b.classList.add("on");
          });
          if (p.kind === brush) b.classList.add("on");
          buttons.push(b);
        }

        toolButton(bar, `brush ${brushSize}`, (b) => {
          brushSize = brushSize >= 6 ? 1 : brushSize + 2;
          b.textContent = `brush ${brushSize}`;
        });
        const drizzleBtn = toolButton(bar, "drizzle", (b) => {
          drizzle = !drizzle;
          b.classList.toggle("on", drizzle);
        });
        drizzleBtn.classList.toggle("on", drizzle);
        toolButton(bar, "empty", () => {
          cells.fill(EMPTY);
          life.fill(0);
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
