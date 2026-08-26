import type { KernelContext, VoidModule } from "../../kernel/types";

const SAVE_KEY = "constellation.saved";
const STAR_COUNT = 90;
const HIT_RADIUS = 16; // px a click must land within to select a star

interface StarPt {
  x: number; // fraction of width, 0..1
  y: number; // fraction of height, 0..1
  r: number;
  phase: number;
}

interface Saved {
  id: string;
  name: string;
  createdAt: number;
  stars: { x: number; y: number }[];
  edges: [number, number][];
}

type Mode = "draw" | "view" | "gallery";

/**
 * A sky, a pencil, and nowhere to save your work but here.
 *
 * Nothing else in the void treats the starfield as something you draw on
 * rather than something that draws itself — every other ambient app is a
 * simulation you watch. This one is closer to Notes: the canvas is a random
 * field of stars, clicking one starts a line, clicking another continues it,
 * and "save" keeps only the stars a line actually touches — so a saved
 * constellation is small, faithful, and rebuilt from exactly the points that
 * made it rather than from a whole regenerated sky.
 */
export const constellation: VoidModule = {
  manifest: {
    id: "constellation",
    name: "Constellation",
    kind: "app",
    glyph: "✦",
    blurb: "connect the dots and name what you see",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "constellation.open",
      label: "constellation",
      hint: "draw one of your own",
      glyph: "✦",
      run: (c) => c.launch("constellation"),
    });
  },

  launch(ctx: KernelContext) {
    const { mount, palette, withAlpha, toolbar, toolButton } = ctx.stage;

    ctx.openSurface({
      title: "constellation",
      width: 480,
      height: 400,
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

        let mode: Mode = "draw";
        let sky: StarPt[] = [];
        let edges: [number, number][] = [];
        let chainFrom: number | null = null;
        let viewing: Saved | null = null;
        let armedDelete: string | null = null;

        const seedSky = () => {
          sky = Array.from({ length: STAR_COUNT }, () => ({
            x: 0.04 + Math.random() * 0.92,
            y: 0.04 + Math.random() * 0.92,
            r: 0.8 + Math.random() * 1.6,
            phase: Math.random() * Math.PI * 2,
          }));
          edges = [];
          chainFrom = null;
        };
        seedSky();

        const saved = (): Saved[] => ctx.state.get<Saved[]>(SAVE_KEY, []);

        /* ---------------- overlays ---------------- */
        // Both the gallery list and the naming prompt are absolutely
        // positioned children of stageHost rather than separate panels, so
        // there is exactly one canvas and exactly one place they cover it.
        // Neither uses `hidden` — they're added and removed from the DOM
        // instead, which sidesteps the guard `[hidden] { display: none }`
        // needs and that a bare element never gets.

        let galleryEl: HTMLElement | null = null;
        let composeEl: HTMLElement | null = null;

        const closeGallery = () => {
          galleryEl?.remove();
          galleryEl = null;
        };
        const closeCompose = () => {
          composeEl?.remove();
          composeEl = null;
        };

        const openGallery = () => {
          closeCompose();
          const el = document.createElement("div");
          el.style.cssText =
            "position:absolute;inset:0;z-index:2;overflow-y:auto;padding:10px;" +
            "display:flex;flex-direction:column;gap:6px;background:rgba(4,5,14,0.92);";

          const list = saved().slice().sort((a, b) => b.createdAt - a.createdAt);
          if (list.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "color:var(--text-dim);font-size:11.5px;padding:6px 2px;";
            empty.textContent = "nothing saved yet — draw a line between a few stars, then “name & save”.";
            el.appendChild(empty);
          }

          for (const s of list) {
            const row = document.createElement("div");
            row.style.cssText =
              "display:flex;align-items:center;gap:10px;padding:8px 10px;" +
              "border:1px solid var(--edge);border-radius:8px;cursor:pointer;";
            row.addEventListener("mouseenter", () => (row.style.borderColor = "var(--cyan)"));
            row.addEventListener("mouseleave", () => (row.style.borderColor = "var(--edge)"));

            const glyph = document.createElement("span");
            glyph.textContent = "✦";
            glyph.style.cssText = "color:var(--ember);font-size:15px;";

            const body = document.createElement("span");
            body.style.cssText = "flex:1;display:flex;flex-direction:column;gap:2px;min-width:0;";
            const title = document.createElement("span");
            title.textContent = s.name;
            title.style.cssText = "color:var(--text);font-size:12.5px;";
            const meta = document.createElement("span");
            meta.textContent = `${s.edges.length} line${s.edges.length === 1 ? "" : "s"} · ${new Date(s.createdAt).toLocaleDateString()}`;
            meta.style.cssText = "color:var(--text-dim);font-size:9.5px;letter-spacing:0.08em;";
            body.append(title, meta);

            const del = document.createElement("button");
            del.type = "button";
            del.className = "stage-btn";
            del.textContent = armedDelete === s.id ? "confirm?" : "delete";
            del.addEventListener("click", (e) => {
              e.stopPropagation();
              if (armedDelete === s.id) {
                ctx.state.set(SAVE_KEY, saved().filter((x) => x.id !== s.id));
                armedDelete = null;
                ctx.notify(`${s.name} let go`, "info");
                openGallery();
              } else {
                armedDelete = s.id;
                openGallery();
              }
            });

            row.addEventListener("click", () => {
              viewing = s;
              mode = "view";
              closeGallery();
              rebuildBar();
              syncFacts();
            });

            row.append(glyph, body, del);
            el.appendChild(row);
          }

          stageHost.appendChild(el);
          galleryEl = el;
        };

        const openCompose = () => {
          closeGallery();
          const el = document.createElement("div");
          el.style.cssText =
            "position:absolute;inset:0;z-index:2;display:grid;place-items:center;" +
            "background:rgba(4,5,14,0.85);padding:16px;";

          const box = document.createElement("div");
          box.style.cssText =
            "display:flex;flex-direction:column;gap:8px;width:min(280px,90%);" +
            "border:1px solid var(--edge);border-radius:10px;padding:14px;background:rgba(0,0,0,0.4);";

          const label = document.createElement("div");
          label.textContent = "what does it look like?";
          label.style.cssText =
            "font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-dim);";

          const input = document.createElement("input");
          input.type = "text";
          input.maxLength = 40;
          input.placeholder = "a name for this shape";
          input.style.cssText =
            "font:inherit;font-size:13px;color:var(--text);background:rgba(255,255,255,0.04);" +
            "border:1px solid var(--edge);border-radius:6px;padding:7px 9px;outline:none;";

          const row = document.createElement("div");
          row.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "stage-btn";
          cancel.textContent = "cancel";
          cancel.addEventListener("click", closeCompose);

          const confirm = document.createElement("button");
          confirm.type = "button";
          confirm.className = "stage-btn on";
          confirm.textContent = "save";
          const commit = () => {
            const name = input.value.trim();
            if (!name) {
              input.focus();
              return;
            }
            saveCurrent(name);
          };
          confirm.addEventListener("click", commit);
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") closeCompose();
          });

          row.append(cancel, confirm);
          box.append(label, input, row);
          el.appendChild(box);
          stageHost.appendChild(el);
          composeEl = el;
          input.focus();
        };

        /** Keep only the stars an edge actually touches, remapped to a dense range. */
        const saveCurrent = (name: string) => {
          const used = new Map<number, number>();
          for (const [a, b] of edges) {
            if (!used.has(a)) used.set(a, used.size);
            if (!used.has(b)) used.set(b, used.size);
          }
          const stars = Array.from(used.keys()).map((i) => ({ x: sky[i].x, y: sky[i].y }));
          const remappedEdges: [number, number][] = edges.map(([a, b]) => [used.get(a)!, used.get(b)!]);

          const entry: Saved = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            name,
            createdAt: Date.now(),
            stars,
            edges: remappedEdges,
          };
          ctx.state.set(SAVE_KEY, [...saved(), entry]);
          ctx.notify(`${name} — saved`, "good");

          closeCompose();
          seedSky();
          syncFacts();
          syncButtons();
        };

        /* ---------------- rendering ---------------- */

        const stop = mount(stageHost, {
          className: "constellation-canvas",
          frame: (st, dt) => {
            const { g, w, h } = st;
            const c = palette();

            g.clearRect(0, 0, w, h);
            const bg = g.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.75);
            bg.addColorStop(0, "rgba(10, 8, 20, 0.55)");
            bg.addColorStop(1, "rgba(2, 2, 8, 0.9)");
            g.fillStyle = bg;
            g.fillRect(0, 0, w, h);

            const stars = mode === "view" && viewing ? viewing.stars : sky;
            const drawnEdges = mode === "view" && viewing ? viewing.edges : edges;

            // Lines first, so the stars they connect sit on top of them.
            g.strokeStyle = withAlpha(c.cyan, 0.75);
            g.lineWidth = 1.4;
            for (const [a, b] of drawnEdges) {
              const p = stars[a];
              const q = stars[b];
              if (!p || !q) continue;
              g.beginPath();
              g.moveTo(p.x * w, p.y * h);
              g.lineTo(q.x * w, q.y * h);
              g.stroke();
            }

            for (let i = 0; i < stars.length; i++) {
              const s = stars[i];
              const touched = drawnEdges.some((e) => e[0] === i || e[1] === i);
              if (mode === "draw" && "phase" in s) (s as StarPt).phase += dt * 0.7;
              const twinkle = "phase" in s ? 0.5 + 0.5 * Math.sin((s as StarPt).phase) : 0.7;
              const base = touched ? 0.95 : 0.35 + twinkle * 0.35;
              const radius = touched ? 2.6 : "r" in s ? (s as StarPt).r : 1.6;

              g.fillStyle = withAlpha(touched ? c.text : c.dim, base);
              g.beginPath();
              g.arc(s.x * w, s.y * h, radius, 0, Math.PI * 2);
              g.fill();

              if (mode === "draw" && i === chainFrom) {
                g.strokeStyle = withAlpha(c.magenta, 0.9);
                g.lineWidth = 1.2;
                g.beginPath();
                g.arc(s.x * w, s.y * h, radius + 4, 0, Math.PI * 2);
                g.stroke();
              }
            }

            if (mode === "view" && viewing) {
              g.fillStyle = withAlpha(c.text, 0.85);
              g.font = "600 12px ui-monospace, monospace";
              g.textAlign = "center";
              g.fillText(viewing.name, w / 2, 20);
              g.textAlign = "left";
            }
          },
        });

        /* ---------------- input ---------------- */

        const canvas = stageHost.querySelector("canvas");
        const onClick = (e: PointerEvent) => {
          if (mode !== "draw" || !canvas) return;
          const rect = canvas.getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width;
          const y = (e.clientY - rect.top) / rect.height;

          let hit = -1;
          let best = HIT_RADIUS / Math.min(rect.width, rect.height);
          for (let i = 0; i < sky.length; i++) {
            const d = Math.hypot(sky[i].x - x, sky[i].y - y);
            if (d < best) {
              best = d;
              hit = i;
            }
          }

          if (hit === -1 || hit === chainFrom) {
            chainFrom = null;
            return;
          }
          if (chainFrom !== null) edges.push([chainFrom, hit]);
          chainFrom = hit;
          syncButtons();
          syncFacts();
        };
        canvas?.addEventListener("pointerdown", onClick);

        /* ---------------- toolbar ---------------- */

        let saveBtn: HTMLButtonElement | null = null;
        let undoBtn: HTMLButtonElement | null = null;
        let clearBtn: HTMLButtonElement | null = null;

        const syncButtons = () => {
          const has = edges.length > 0;
          if (saveBtn) saveBtn.disabled = !has;
          if (undoBtn) undoBtn.disabled = !has;
          if (clearBtn) clearBtn.disabled = !has;
        };

        const syncFacts = () => {
          facts.replaceChildren();
          const rows: [string, string][] =
            mode === "view" && viewing
              ? [
                  ["viewing", viewing.name],
                  ["stars used", String(viewing.stars.length)],
                ]
              : [
                  ["lines drawn", String(edges.length)],
                  ["saved", String(saved().length)],
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

        const rebuildBar = () => {
          bar.replaceChildren();
          armedDelete = null;

          if (mode === "draw") {
            toolButton(bar, "new sky", () => {
              closeCompose();
              seedSky();
              syncButtons();
              syncFacts();
            });
            undoBtn = toolButton(bar, "undo", () => {
              edges.pop();
              chainFrom = null;
              syncButtons();
              syncFacts();
            });
            clearBtn = toolButton(bar, "clear lines", () => {
              edges = [];
              chainFrom = null;
              syncButtons();
              syncFacts();
            });
            saveBtn = toolButton(bar, "name & save", () => {
              if (edges.length > 0) openCompose();
            });
            toolButton(bar, "your constellations", () => {
              mode = "gallery";
              rebuildBar();
              openGallery();
              syncFacts();
            });
            syncButtons();
          } else if (mode === "view") {
            toolButton(bar, "back to sky", () => {
              mode = "draw";
              viewing = null;
              rebuildBar();
              syncFacts();
            });
            toolButton(bar, "your constellations", () => {
              mode = "gallery";
              viewing = null;
              rebuildBar();
              openGallery();
              syncFacts();
            });
          } else {
            toolButton(bar, "back to sky", () => {
              mode = "draw";
              closeGallery();
              rebuildBar();
              syncFacts();
            });
          }
        };

        rebuildBar();
        syncFacts();

        return () => {
          stop();
          canvas?.removeEventListener("pointerdown", onClick);
        };
      },
    });
  },
};
