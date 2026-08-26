import type { KernelContext, VoidModule } from "../../kernel/types";

const SOUND_KEY = "meteors.sound";
const WISH_KEY = "meteors.wishes";
const RATE_KEY = "meteors.rate";

const STAR_DENSITY = 1 / 9000; // background stars per square CSS pixel
const WISH_RADIUS = 26; // px a click must land within to catch a streak

interface RatePreset {
  label: string;
  /** Seconds between spawns, [min, max). */
  interval: [number, number];
  /** Px/sec along the streak, [min, max). */
  speed: [number, number];
}

/**
 * Three skies, not a slider. A slider invites tuning a number nobody has a
 * feel for; three named rates read like weather and are the whole range
 * anyone actually wants.
 */
const RATES: Record<string, RatePreset> = {
  drizzle: { label: "drizzle", interval: [3.2, 6.4], speed: [220, 340] },
  shower: { label: "shower", interval: [1.0, 2.4], speed: [260, 420] },
  storm: { label: "storm", interval: [0.22, 0.85], speed: [320, 520] },
};
const RATE_ORDER = ["drizzle", "shower", "storm"];

interface Star {
  x: number; // fraction of width
  y: number; // fraction of height
  r: number;
  phase: number;
  speed: number;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  fireball: boolean;
  caught: boolean;
}

interface Flash {
  x: number;
  y: number;
  age: number;
  life: number;
  size: number;
}

interface Wish {
  x: number;
  y: number;
  age: number;
}

/**
 * A patch of night sky. Meteors are straight lines drawn from velocity, not
 * stored history — a shooting star doesn't curve, so the tail is just "where
 * the head was `tailSeconds` ago" computed from the current vector each frame.
 * Cheaper than a particle trail and exactly as accurate.
 *
 * Catching one is the whole interaction: click near a streak's head while
 * it's still lit and it counts as a wish. Nothing is destroyed or scored —
 * the sky doesn't owe you a hit rate, and a counter that only ever goes up is
 * more honest than one that could go down.
 */
export const meteors: VoidModule = {
  manifest: {
    id: "meteors",
    name: "Meteor Shower",
    kind: "app",
    glyph: "☄",
    blurb: "watch the sky fall, catch a few",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "meteors.open",
      label: "meteor shower",
      hint: "a patch of falling sky",
      glyph: "☄",
      run: (c) => c.launch("meteors"),
    });
  },

  launch(ctx: KernelContext) {
    const { mount, palette, withAlpha, rgbOf, toolbar, toolButton } = ctx.stage;

    ctx.openSurface({
      title: "meteor shower",
      width: 460,
      height: 360,
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

        let stars: Star[] = [];
        let active: Meteor[] = [];
        let flashes: Flash[] = [];
        let wishes: Wish[] = [];
        let spawnAt = 1;

        let rateId = String(ctx.state.get<string>(RATE_KEY, "shower"));
        if (!RATES[rateId]) rateId = "shower";
        let wishCount = ctx.state.get<number>(WISH_KEY, 0);

        const reshape = (w: number, h: number) => {
          const n = Math.max(30, Math.min(220, Math.round(w * h * STAR_DENSITY)));
          stars = Array.from({ length: n }, () => ({
            x: Math.random(),
            y: Math.random(),
            r: 0.4 + Math.random() * 1.1,
            phase: Math.random() * Math.PI * 2,
            speed: 0.6 + Math.random() * 1.4,
          }));
        };

        const spawn = (w: number, h: number) => {
          const preset = RATES[rateId];
          const [smin, smax] = preset.speed;
          const speed = smin + Math.random() * (smax - smin);
          const angle = (18 + Math.random() * 24) * (Math.PI / 180); // below horizontal
          const leftToRight = Math.random() < 0.5;
          const dir = leftToRight ? 1 : -1;
          const vx = Math.cos(angle) * speed * dir;
          const vy = Math.sin(angle) * speed;

          // Enter from above, offset so the whole streak crosses the panel
          // rather than clipping a corner.
          const span = w * 0.6;
          const x = leftToRight ? -20 + Math.random() * span : w + 20 - Math.random() * span;
          const y = -20 - Math.random() * (h * 0.25);

          const fireball = Math.random() < 0.1;
          active.push({
            x,
            y,
            vx,
            vy,
            size: fireball ? 2.2 + Math.random() * 0.6 : 1,
            fireball,
            caught: false,
          });
        };

        const rateLabel = () => RATES[rateId].label;

        const refreshFacts = () => {
          facts.replaceChildren();
          const rows: [string, string][] = [
            ["sky", rateLabel()],
            ["wishes made", wishCount.toLocaleString()],
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

        const stop = mount(stageHost, {
          className: "meteors-canvas",
          layout: (st) => reshape(st.w, st.h),
          frame: (st, dt) => {
            const { g, w, h } = st;
            const c = palette();

            spawnAt -= dt;
            if (spawnAt <= 0) {
              const preset = RATES[rateId];
              const [imin, imax] = preset.interval;
              spawnAt = imin + Math.random() * (imax - imin);
              spawn(w, h);
            }

            g.clearRect(0, 0, w, h);
            const sky = g.createLinearGradient(0, 0, 0, h);
            sky.addColorStop(0, "rgba(4, 5, 14, 0.9)");
            sky.addColorStop(1, "rgba(2, 2, 8, 0.95)");
            g.fillStyle = sky;
            g.fillRect(0, 0, w, h);

            // Ambient sky, static except for a slow twinkle — a backdrop, not
            // the show.
            const [tr, tg, tb] = rgbOf(c.text);
            for (const s of stars) {
              const twinkle = 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(s.phase));
              s.phase += dt * s.speed;
              g.fillStyle = `rgba(${tr}, ${tg}, ${tb}, ${twinkle.toFixed(3)})`;
              g.beginPath();
              g.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
              g.fill();
            }

            // Meteors: a gradient tail drawn straight back along the current
            // vector, plus a bright head. No stored trail — a straight-line
            // streak has no history worth keeping.
            const next: Meteor[] = [];
            for (const m of active) {
              m.x += m.vx * dt;
              m.y += m.vy * dt;

              const gone = m.x < -60 || m.x > w + 60 || m.y > h + 60;
              if (gone) {
                if (m.fireball) {
                  flashes.push({ x: Math.min(Math.max(m.x, 0), w), y: Math.min(Math.max(m.y, 0), h), age: 0, life: 0.5, size: 26 });
                }
                continue;
              }
              next.push(m);

              const speed = Math.hypot(m.vx, m.vy) || 1;
              const tailLen = (m.fireball ? 46 : 34) * m.size;
              const tx = m.x - (m.vx / speed) * tailLen;
              const ty = m.y - (m.vy / speed) * tailLen;

              const glow = m.fireball ? c.ember : c.cyan;
              const trail = g.createLinearGradient(m.x, m.y, tx, ty);
              trail.addColorStop(0, withAlpha(glow, 0.95));
              trail.addColorStop(1, withAlpha(glow, 0));
              g.strokeStyle = trail;
              g.lineWidth = m.fireball ? 2.4 : 1.4;
              g.lineCap = "round";
              g.beginPath();
              g.moveTo(m.x, m.y);
              g.lineTo(tx, ty);
              g.stroke();

              g.fillStyle = withAlpha(c.text, 0.9);
              g.beginPath();
              g.arc(m.x, m.y, m.fireball ? 2.4 : 1.4, 0, Math.PI * 2);
              g.fill();
            }
            active = next;

            // Flashes: a fireball's afterglow, a soft ring that grows and fades.
            flashes = flashes.filter((f) => {
              f.age += dt;
              if (f.age >= f.life) return false;
              const t = f.age / f.life;
              g.strokeStyle = withAlpha(c.ember, (1 - t) * 0.5);
              g.lineWidth = 1.5;
              g.beginPath();
              g.arc(f.x, f.y, f.size * t, 0, Math.PI * 2);
              g.stroke();
              return true;
            });

            // Wish sparkles: the click's own small reward, independent of any
            // meteor — it rises and fades in about a second.
            wishes = wishes.filter((wi) => {
              wi.age += dt;
              if (wi.age >= 1) return false;
              const t = wi.age;
              g.fillStyle = withAlpha(c.cyan, (1 - t) * 0.85);
              g.font = "600 10px ui-monospace, monospace";
              g.textAlign = "center";
              g.fillText("✦ wish", wi.x, wi.y - t * 18);
              g.textAlign = "left";
              return true;
            });
          },
        });

        /* ---------------- catching a wish ---------------- */

        const canvas = stageHost.querySelector("canvas");
        const onClick = (e: PointerEvent) => {
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;

          let closest: Meteor | null = null;
          let closestD = WISH_RADIUS;
          for (const m of active) {
            if (m.caught) continue;
            const d = Math.hypot(m.x - x, m.y - y);
            if (d < closestD) {
              closestD = d;
              closest = m;
            }
          }
          if (!closest) return;
          closest.caught = true;

          wishCount += 1;
          ctx.state.set(WISH_KEY, wishCount);
          wishes.push({ x, y, age: 0 });
          refreshFacts();

          if (ctx.state.get<boolean>(SOUND_KEY, true)) {
            try {
              ctx.audio.tone({ freq: 720, toFreq: 1180, gain: 0.05, decay: 0.5, wave: "sine" });
            } catch {
              // Audio is a nicety; a frame must never go down for it.
            }
          }
          if (wishCount === 1 || wishCount % 25 === 0) {
            ctx.notify(`${wishCount} wish${wishCount === 1 ? "" : "es"} made under this sky`, "good");
          }
        };
        canvas?.addEventListener("pointerdown", onClick);

        /* ---------------- controls ---------------- */

        toolButton(bar, `sky: ${rateLabel()}`, (b) => {
          const i = (RATE_ORDER.indexOf(rateId) + 1) % RATE_ORDER.length;
          rateId = RATE_ORDER[i];
          ctx.state.set(RATE_KEY, rateId);
          b.textContent = `sky: ${rateLabel()}`;
          refreshFacts();
        });

        const soundBtn = toolButton(bar, "sound on", (b) => {
          const next = !ctx.state.get<boolean>(SOUND_KEY, true);
          ctx.state.set(SOUND_KEY, next);
          b.textContent = next ? "sound on" : "sound off";
          b.classList.toggle("on", next);
        });
        soundBtn.textContent = ctx.state.get<boolean>(SOUND_KEY, true) ? "sound on" : "sound off";
        soundBtn.classList.toggle("on", ctx.state.get<boolean>(SOUND_KEY, true));

        toolButton(bar, "clear sky", () => {
          active = [];
          flashes = [];
          wishes = [];
        });

        refreshFacts();

        return () => {
          stop();
          canvas?.removeEventListener("pointerdown", onClick);
        };
      },
    });
  },
};
