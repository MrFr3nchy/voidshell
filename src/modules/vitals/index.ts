import type { KernelContext, VoidModule } from "../../kernel/types";

const HISTORY = 90;

/**
 * Vitals is the OS admitting what it costs. Frame time, window count, bodies
 * in orbit, how much of the store is on disk — all read through the same
 * public syscalls any module gets, with no privileged backdoor into the
 * compositor. If this app can see it, so can yours.
 */
export const vitals: VoidModule = {
  manifest: {
    id: "vitals",
    name: "Vitals",
    kind: "app",
    glyph: "\u25a5",
    blurb: "what the void costs to run",
    version: "0.1.0",
  },

  activate() {},

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "vitals",
      width: 340,
      height: 300,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("vit-root");

        const canvas = document.createElement("canvas");
        canvas.className = "vit-graph";
        canvas.width = 600;
        canvas.height = 160;

        const grid = document.createElement("div");
        grid.className = "vit-grid";

        root.append(canvas, grid);

        const cells = new Map<string, HTMLElement>();
        const cell = (label: string) => {
          const wrap = document.createElement("div");
          wrap.className = "vit-cell";
          const l = document.createElement("span");
          l.className = "vit-label";
          l.textContent = label;
          const v = document.createElement("span");
          v.className = "vit-value";
          v.textContent = "\u2014";
          wrap.append(l, v);
          grid.appendChild(wrap);
          cells.set(label, v);
        };
        for (const c of ["fps", "windows", "bodies", "linked", "modules", "uptime", "heap", "state"])
          cell(c);

        const history: number[] = [];
        const started = performance.now();
        const ctx2d = canvas.getContext("2d");

        const draw = () => {
          if (!ctx2d) return;
          const w = canvas.width;
          const h = canvas.height;
          ctx2d.clearRect(0, 0, w, h);
          if (history.length < 2) return;

          const style = getComputedStyle(document.documentElement);
          const accent = style.getPropertyValue("--cyan").trim() || "#4fe3d0";

          ctx2d.beginPath();
          history.forEach((v, i) => {
            const x = (i / (HISTORY - 1)) * w;
            const y = h - Math.max(0, Math.min(1, v / 120)) * h;
            if (i === 0) ctx2d.moveTo(x, y);
            else ctx2d.lineTo(x, y);
          });
          ctx2d.strokeStyle = accent;
          ctx2d.lineWidth = 2;
          ctx2d.stroke();

          ctx2d.lineTo(w, h);
          ctx2d.lineTo(0, h);
          ctx2d.closePath();
          ctx2d.fillStyle = `${accent}22`;
          ctx2d.fill();

          // 60fps reference line, so the graph means something at a glance.
          ctx2d.beginPath();
          const y60 = h - (60 / 120) * h;
          ctx2d.moveTo(0, y60);
          ctx2d.lineTo(w, y60);
          ctx2d.strokeStyle = "rgba(150,185,255,0.25)";
          ctx2d.lineWidth = 1;
          ctx2d.stroke();
        };

        const tick = () => {
          const s = ctx.stats();
          history.push(s.fps);
          while (history.length > HISTORY) history.shift();

          const up = Math.round((performance.now() - started) / 1000);
          const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } })
            .memory;

          set("fps", String(s.fps));
          set("windows", String(s.panels));
          set("bodies", String(s.bodies));
          set("linked", String(s.groups));
          set("modules", String(ctx.registry().length));
          set("uptime", `${Math.floor(up / 60)}m ${up % 60}s`);
          set("heap", mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(1)} mb` : "n/a");
          set("state", `${storeBytes()} b`);
          draw();
        };

        const set = (label: string, value: string) => {
          const el = cells.get(label);
          if (el && el.textContent !== value) el.textContent = value;
        };

        tick();
        const timer = window.setInterval(tick, 500);
        return () => window.clearInterval(timer);
      },
    });
  },
};

function storeBytes(): number {
  try {
    return localStorage.getItem("voidshell:state")?.length ?? 0;
  } catch {
    return 0;
  }
}
