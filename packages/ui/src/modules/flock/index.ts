import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";

const VIEW = 46; // how far a boid can see, in CSS pixels
const SEPARATION = 21;
const MAX_SPEED = 105;
const MIN_SPEED = 42;
const MAX_FORCE = 190;
const WANDER = 420; // keeps the flock breathing instead of locking rigid
const FEAR = 105; // radius at which the cursor becomes a problem

interface Boid {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: number;
}

/**
 * Reynolds' boids, 1986: separation, alignment, cohesion. Three rules, no
 * leader, no choreography, no global plan — and you get murmuration anyway.
 * That's the entire reason this is worth staring at.
 *
 * The cursor is a predator while it's over the panel. Watch the flock split
 * around it and re-merge behind: nothing in the code knows how to do that.
 */
export const flock: VoidModule = {
  manifest: {
    id: "flock",
    name: "Flock",
    kind: "app",
    glyph: "\u2234",
    blurb: "three rules, no leader",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "flock.open",
      label: "flock",
      hint: "watch something organise itself",
      glyph: "\u2234",
      run: (c) => c.launch("flock"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "flock",
      width: 420,
      height: 320,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        let boids: Boid[] = [];
        let count = 140;
        let trails = true;
        let w = 1;
        let h = 1;

        let hunterX = -1;
        let hunterY = -1;

        const spawn = (n: number) => {
          boids = Array.from({ length: n }, () => {
            const angle = Math.random() * Math.PI * 2;
            const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
            return {
              x: Math.random() * w,
              y: Math.random() * h,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              hue: Math.random(),
            };
          });
        };

        const limit = (x: number, y: number, max: number): [number, number] => {
          const m = Math.hypot(x, y);
          if (m <= max || m === 0) return [x, y];
          return [(x / m) * max, (y / m) * max];
        };

        const step = (dt: number) => {
          const view2 = VIEW * VIEW;
          const sep2 = SEPARATION * SEPARATION;

          for (const b of boids) {
            let ax = 0;
            let ay = 0;

            let cx = 0;
            let cy = 0;
            let avx = 0;
            let avy = 0;
            let sx = 0;
            let sy = 0;
            let seen = 0;

            for (const o of boids) {
              if (o === b) continue;
              const dx = o.x - b.x;
              const dy = o.y - b.y;
              const d2 = dx * dx + dy * dy;
              if (d2 > view2 || d2 === 0) continue;
              seen++;
              cx += o.x;
              cy += o.y;
              avx += o.vx;
              avy += o.vy;
              if (d2 < sep2) {
                // Push away, weighted by closeness — crowding hurts more up close.
                sx -= dx / d2;
                sy -= dy / d2;
              }
            }

            if (seen > 0) {
              // Cohesion: steer toward where everyone nearby is.
              const [chx, chy] = limit(cx / seen - b.x, cy / seen - b.y, MAX_FORCE);
              ax += chx;
              ay += chy;
              // Alignment: match their heading. Held deliberately below cohesion —
              // crank this up and the flock converges into a rigid lattice that
              // drifts without ever turning, which is worse to watch.
              const [alx, aly] = limit(avx / seen - b.vx, avy / seen - b.vy, MAX_FORCE);
              ax += alx * 0.9;
              ay += aly * 0.9;
            }

            // Separation: get out of each other's way. Strongest of the three,
            // otherwise cohesion collapses the flock into a single point.
            const [spx, spy] = limit(sx * 5200, sy * 5200, MAX_FORCE * 1.6);
            ax += spx;
            ay += spy;

            // A little private noise per bird. Without it the whole flock
            // settles at order ~0.99 and stops looking alive.
            ax += (Math.random() - 0.5) * WANDER;
            ay += (Math.random() - 0.5) * WANDER;

            if (hunterX >= 0) {
              const dx = b.x - hunterX;
              const dy = b.y - hunterY;
              const d = Math.hypot(dx, dy);
              if (d < FEAR && d > 0.01) {
                const push = (1 - d / FEAR) * MAX_FORCE * 6;
                ax += (dx / d) * push;
                ay += (dy / d) * push;
              }
            }

            b.vx += ax * dt;
            b.vy += ay * dt;

            const speed = Math.hypot(b.vx, b.vy);
            if (speed > MAX_SPEED) {
              b.vx = (b.vx / speed) * MAX_SPEED;
              b.vy = (b.vy / speed) * MAX_SPEED;
            } else if (speed < MIN_SPEED && speed > 0) {
              b.vx = (b.vx / speed) * MIN_SPEED;
              b.vy = (b.vy / speed) * MIN_SPEED;
            }

            b.x += b.vx * dt;
            b.y += b.vy * dt;

            // Toroidal, like driftfield. Walls would create corners to hide in.
            if (b.x < 0) b.x += w;
            else if (b.x >= w) b.x -= w;
            if (b.y < 0) b.y += h;
            else if (b.y >= h) b.y -= h;
          }
        };

        const stop = mountStage(stageHost, {
          className: "flock-canvas",
          layout: (st) => {
            const first = boids.length === 0;
            w = st.w;
            h = st.h;
            if (first) spawn(count);
          },
          frame: (st, dt) => {
            step(dt);

            const { g } = st;
            const c = palette();

            if (trails) {
              // Wipe with transparency instead of clearing: old frames survive a
              // little, which is what draws the streaks.
              g.globalCompositeOperation = "destination-out";
              g.fillStyle = `rgba(0,0,0,${Math.min(0.45, dt * 7)})`;
              g.fillRect(0, 0, w, h);
              g.globalCompositeOperation = "source-over";
            } else {
              g.clearRect(0, 0, w, h);
            }

            for (const b of boids) {
              const speed = Math.hypot(b.vx, b.vy);
              const heat = Math.min(1, (speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED));
              const color = heat > 0.5 ? c.magenta : c.cyan;
              const ang = Math.atan2(b.vy, b.vx);
              const nose = 5.2;
              const tail = 3.4;

              g.beginPath();
              g.moveTo(b.x + Math.cos(ang) * nose, b.y + Math.sin(ang) * nose);
              g.lineTo(
                b.x + Math.cos(ang + 2.5) * tail,
                b.y + Math.sin(ang + 2.5) * tail
              );
              g.lineTo(
                b.x + Math.cos(ang - 2.5) * tail,
                b.y + Math.sin(ang - 2.5) * tail
              );
              g.closePath();
              g.fillStyle = withAlpha(color, 0.35 + b.hue * 0.5);
              g.fill();
            }

            if (hunterX >= 0) {
              g.beginPath();
              g.arc(hunterX, hunterY, FEAR, 0, Math.PI * 2);
              g.strokeStyle = withAlpha(c.ember, 0.14);
              g.lineWidth = 1;
              g.stroke();
            }
          },
        });

        /* ---------------- pointer ---------------- */

        const canvas = stageHost.querySelector("canvas");

        const onMove = (e: PointerEvent) => {
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * w;
          const y = ((e.clientY - rect.top) / rect.height) * h;
          const inside = x >= 0 && y >= 0 && x <= w && y <= h;
          hunterX = inside ? x : -1;
          hunterY = inside ? y : -1;
        };
        const onLeave = () => {
          hunterX = -1;
          hunterY = -1;
        };

        canvas?.addEventListener("pointermove", onMove);
        canvas?.addEventListener("pointerleave", onLeave);

        /* ---------------- controls ---------------- */

        toolButton(bar, "scatter", () => {
          for (const b of boids) {
            const angle = Math.random() * Math.PI * 2;
            b.vx = Math.cos(angle) * MAX_SPEED;
            b.vy = Math.sin(angle) * MAX_SPEED;
          }
        });

        toolButton(bar, `${count} birds`, (b) => {
          count = count === 140 ? 260 : count === 260 ? 60 : 140;
          spawn(count);
          b.textContent = `${count} birds`;
        });

        const trailBtn = toolButton(bar, "trails", (b) => {
          trails = !trails;
          b.classList.toggle("on", trails);
        });
        trailBtn.classList.toggle("on", trails);

        return () => {
          stop();
          canvas?.removeEventListener("pointermove", onMove);
          canvas?.removeEventListener("pointerleave", onLeave);
        };
      },
    });
  },
};
