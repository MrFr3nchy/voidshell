import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";

/** Mean synodic month, days. */
const SYNODIC = 29.530588853;
/** Julian day of the new moon of 2000-01-06 18:14 UT — the anchor. */
const EPOCH_NEW = 2451550.09766;

const HEMI_KEY = "lunaria.south";

/**
 * The moon, computed rather than fetched. Phase comes from mean lunation — the
 * time since a known new moon, folded by the synodic month — which is accurate
 * to within a few hours and needs no network, no key, and no permission. The
 * terminator is drawn scanline by scanline: at each row the lit span runs from
 * cos(phase) x half-width out to the limb, which is exactly why a crescent
 * bulges the way it does.
 */
export const lunaria: VoidModule = {
  manifest: {
    id: "lunaria",
    name: "Lunaria",
    kind: "app",
    glyph: "\u263d",
    blurb: "the moon, without asking anyone",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "lunaria.open",
      label: "lunaria",
      hint: "check the moon",
      glyph: "\u263d",
      run: (c) => c.launch("lunaria"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "lunaria",
      width: 320,
      height: 380,
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

        let south = ctx.state.get<boolean>(HEMI_KEY, false);
        let moon = phaseAt(new Date());
        let sinceRefresh = 0;

        const rows = new Map<string, HTMLElement>();
        for (const label of ["phase", "lit", "age", "next full", "next new"]) {
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

        const paintFacts = () => {
          rows.get("phase")!.textContent = moon.name;
          rows.get("lit")!.textContent = `${(moon.illumination * 100).toFixed(1)}%`;
          rows.get("age")!.textContent = `${moon.age.toFixed(2)} d`;
          rows.get("next full")!.textContent = when(moon.toFull);
          rows.get("next new")!.textContent = when(moon.toNew);
        };

        // A field of fixed stars, each with its own slow breath.
        const stars = Array.from({ length: 70 }, () => ({
          x: Math.random(),
          y: Math.random(),
          r: 0.4 + Math.random() * 1.1,
          speed: 0.3 + Math.random() * 0.9,
          offset: Math.random() * 6.28,
        }));

        let clock = 0;

        const stop = mountStage(stageHost, {
          className: "luna-canvas",
          frame: (st, dt) => {
            clock += dt;
            sinceRefresh += dt;
            if (sinceRefresh > 60) {
              sinceRefresh = 0;
              moon = phaseAt(new Date());
              paintFacts();
            }

            const { g, w, h } = st;
            const c = palette();
            g.clearRect(0, 0, w, h);

            for (const s of stars) {
              const tw = 0.35 + 0.35 * Math.sin(clock * s.speed + s.offset);
              g.beginPath();
              g.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
              g.fillStyle = withAlpha(c.text, tw);
              g.fill();
            }

            const R = Math.min(w, h) * 0.36;
            const cx = w / 2;
            const cy = h / 2;

            // Halo
            const halo = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 2.1);
            halo.addColorStop(0, withAlpha(c.cyan, 0.16 * moon.illumination + 0.02));
            halo.addColorStop(1, withAlpha(c.cyan, 0));
            g.fillStyle = halo;
            g.fillRect(0, 0, w, h);

            // Earthshine: the unlit disc is never truly black.
            g.beginPath();
            g.arc(cx, cy, R, 0, Math.PI * 2);
            g.fillStyle = withAlpha(c.magenta, 0.07);
            g.fill();
            g.strokeStyle = withAlpha(c.dim, 0.35);
            g.lineWidth = 1;
            g.stroke();

            // Lit region, one scanline at a time.
            const k = Math.cos(2 * Math.PI * moon.fraction);
            const waxing = moon.fraction < 0.5;
            g.fillStyle = withAlpha(c.text, 0.92);
            for (let dy = -R; dy <= R; dy += 0.5) {
              const half = Math.sqrt(Math.max(0, R * R - dy * dy));
              let x0: number;
              let x1: number;
              if (waxing !== south) {
                x0 = k * half;
                x1 = half;
              } else {
                x0 = -half;
                x1 = -k * half;
              }
              if (x1 <= x0) continue;
              g.fillRect(cx + x0, cy + dy, x1 - x0, 0.6);
            }
          },
        });

        const hemiBtn = toolButton(bar, "", (b) => {
          south = !south;
          ctx.state.set(HEMI_KEY, south);
          b.textContent = south ? "southern" : "northern";
        });
        hemiBtn.textContent = south ? "southern" : "northern";

        toolButton(bar, "now", () => {
          moon = phaseAt(new Date());
          paintFacts();
          ctx.notify(`moon is ${moon.name.toLowerCase()}`, "info");
        });

        paintFacts();

        return stop;
      },
    });
  },
};

interface MoonState {
  /** Days since the last new moon. */
  age: number;
  /** 0 at new, 0.5 at full, wrapping at 1. */
  fraction: number;
  illumination: number;
  name: string;
  toFull: number;
  toNew: number;
}

function phaseAt(date: Date): MoonState {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const age = mod(jd - EPOCH_NEW, SYNODIC);
  const fraction = age / SYNODIC;
  const illumination = (1 - Math.cos(2 * Math.PI * fraction)) / 2;
  return {
    age,
    fraction,
    illumination,
    name: nameFor(fraction),
    toFull: mod(SYNODIC / 2 - age, SYNODIC),
    toNew: mod(SYNODIC - age, SYNODIC),
  };
}

function nameFor(f: number): string {
  if (f < 0.02 || f >= 0.98) return "New";
  if (f < 0.23) return "Waxing crescent";
  if (f < 0.27) return "First quarter";
  if (f < 0.48) return "Waxing gibbous";
  if (f < 0.52) return "Full";
  if (f < 0.73) return "Waning gibbous";
  if (f < 0.77) return "Last quarter";
  return "Waning crescent";
}

function when(days: number): string {
  const at = new Date(Date.now() + days * 86400000);
  const stamp = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  if (days < 1) return `${Math.round(days * 24)}h \u2014 ${stamp}`;
  return `${days.toFixed(1)}d \u2014 ${stamp}`;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
