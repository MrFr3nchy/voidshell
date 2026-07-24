import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";
import { tone } from "../../ui/blip";

const TARGET = 26; // preferred bubble diameter in CSS pixels
const SOUND_KEY = "bubblewrap.sound";

interface Bubble {
  x: number;
  y: number;
  r: number;
  popped: boolean;
  /** 1 the instant it pops, decaying to 0 — drives the squash animation. */
  t: number;
  /** Per-bubble pitch, so a run of pops sounds like a run and not a metronome. */
  pitch: number;
}

/**
 * Bubble wrap. There is no goal, no score and no way to lose, which is the
 * entire appeal. Bubbles sit on an offset lattice like the real sheet, pop
 * under the cursor as you drag across them, and the sheet refills on demand.
 * The pop is a swept sine — a pitch drop is what your ear reads as "collapse".
 */
export const bubblewrap: VoidModule = {
  manifest: {
    id: "bubblewrap",
    name: "Bubblewrap",
    kind: "app",
    glyph: "\u25cc",
    blurb: "no score, no way to lose",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineSetting({
      key: SOUND_KEY,
      label: "bubble pop",
      kind: "toggle",
      group: "Apps",
      hint: "make a noise when a bubble goes.",
      default: true,
      order: 11,
    });
    ctx.defineCommand({
      id: "bubblewrap.open",
      label: "bubblewrap",
      hint: "pop something",
      glyph: "\u25cc",
      run: (c) => c.launch("bubblewrap"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "bubblewrap",
      width: 360,
      height: 320,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        let bubbles: Bubble[] = [];
        let popped = 0;
        let soundOn = ctx.state.get<boolean>(SOUND_KEY, true);

        const build = (w: number, h: number) => {
          const r = TARGET / 2;
          const stepX = TARGET * 0.96;
          const stepY = TARGET * 0.84; // rows nest, the way real sheets do
          const cols = Math.max(2, Math.floor((w - r) / stepX));
          const rows = Math.max(2, Math.floor((h - r) / stepY));
          const padX = (w - (cols - 1) * stepX) / 2;
          const padY = (h - (rows - 1) * stepY) / 2;

          bubbles = [];
          for (let row = 0; row < rows; row++) {
            const offset = row % 2 ? stepX / 2 : 0;
            for (let col = 0; col < cols; col++) {
              const x = padX + col * stepX + offset;
              if (x > w - r * 0.4) continue;
              bubbles.push({
                x,
                y: padY + row * stepY,
                r: r * 0.92,
                popped: false,
                t: 0,
                pitch: 620 + Math.random() * 340,
              });
            }
          }
          popped = 0;
        };

        const pop = (b: Bubble) => {
          if (b.popped) return;
          b.popped = true;
          b.t = 1;
          popped++;
          if (soundOn) {
            tone({
              freq: b.pitch,
              toFreq: b.pitch * 0.35,
              gain: 0.09,
              decay: 0.07,
              wave: "triangle",
            });
          }
          if (popped === bubbles.length) {
            ctx.notify("sheet cleared. that's the whole game", "good");
          }
        };

        const stop = mountStage(stageHost, {
          className: "bubble-canvas",
          layout: (st) => build(st.w, st.h),
          frame: (st, dt) => {
            const { g, w, h } = st;
            const c = palette();
            g.clearRect(0, 0, w, h);

            for (const b of bubbles) {
              if (b.t > 0) b.t = Math.max(0, b.t - dt * 3.2);

              if (!b.popped) {
                // A dome: highlight up and left, shadow bottom right.
                const grad = g.createRadialGradient(
                  b.x - b.r * 0.32,
                  b.y - b.r * 0.36,
                  b.r * 0.1,
                  b.x,
                  b.y,
                  b.r
                );
                grad.addColorStop(0, withAlpha(c.text, 0.5));
                grad.addColorStop(0.55, withAlpha(c.cyan, 0.2));
                grad.addColorStop(1, withAlpha(c.cyan, 0.06));
                g.beginPath();
                g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
                g.fillStyle = grad;
                g.fill();
                g.strokeStyle = withAlpha(c.cyan, 0.4);
                g.lineWidth = 1;
                g.stroke();

                g.beginPath();
                g.ellipse(
                  b.x - b.r * 0.3,
                  b.y - b.r * 0.38,
                  b.r * 0.26,
                  b.r * 0.16,
                  -0.6,
                  0,
                  Math.PI * 2
                );
                g.fillStyle = withAlpha(c.text, 0.5);
                g.fill();
              } else {
                // A spent bubble is a slack dimple with a crease in it.
                g.beginPath();
                g.ellipse(b.x, b.y + b.r * 0.12, b.r * 0.82, b.r * 0.6, 0, 0, Math.PI * 2);
                g.fillStyle = withAlpha(c.dim, 0.1);
                g.fill();
                g.strokeStyle = withAlpha(c.dim, 0.3);
                g.lineWidth = 1;
                g.stroke();
                g.beginPath();
                g.moveTo(b.x - b.r * 0.5, b.y + b.r * 0.1);
                g.lineTo(b.x + b.r * 0.45, b.y + b.r * 0.24);
                g.strokeStyle = withAlpha(c.dim, 0.24);
                g.stroke();

                if (b.t > 0) {
                  g.beginPath();
                  g.arc(b.x, b.y, b.r * (1 + (1 - b.t) * 1.4), 0, Math.PI * 2);
                  g.strokeStyle = withAlpha(c.cyan, b.t * 0.5);
                  g.lineWidth = 1.5;
                  g.stroke();
                }
              }
            }

            g.fillStyle = withAlpha(c.dim, 0.75);
            g.font = "9px ui-monospace, monospace";
            g.fillText(`${popped} / ${bubbles.length}`, 6, h - 6);
          },
        });

        /* ---------------- pointer ---------------- */

        const canvas = stageHost.querySelector("canvas");
        let down = false;

        const popAt = (clientX: number, clientY: number) => {
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const px = ((clientX - rect.left) / rect.width) * canvas.clientWidth;
          const py = ((clientY - rect.top) / rect.height) * canvas.clientHeight;
          for (const b of bubbles) {
            if (b.popped) continue;
            if (Math.hypot(px - b.x, py - b.y) <= b.r) {
              pop(b);
              break; // one bubble per sample, or a fast drag clears the sheet
            }
          }
        };

        const onDown = (e: PointerEvent) => {
          down = true;
          popAt(e.clientX, e.clientY);
          canvas?.setPointerCapture(e.pointerId);
          e.preventDefault();
        };
        const onMove = (e: PointerEvent) => {
          if (down) popAt(e.clientX, e.clientY);
        };
        const onUp = () => {
          down = false;
        };

        canvas?.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);

        /* ---------------- controls ---------------- */

        toolButton(bar, "new sheet", () => {
          for (const b of bubbles) {
            b.popped = false;
            b.t = 0;
          }
          popped = 0;
        });

        toolButton(bar, "pop all", () => {
          for (const b of bubbles) {
            b.popped = true;
            b.t = 0;
          }
          popped = bubbles.length;
        });

        const soundBtn = toolButton(bar, "", () => {
          soundOn = !soundOn;
          ctx.state.set(SOUND_KEY, soundOn);
        });
        const paintSound = () => {
          soundBtn.textContent = soundOn ? "sound on" : "sound off";
          soundBtn.classList.toggle("on", soundOn);
        };
        paintSound();
        const unsub = ctx.state.subscribe(SOUND_KEY, (v) => {
          soundOn = Boolean(v);
          paintSound();
        });

        return () => {
          stop();
          unsub();
          canvas?.removeEventListener("pointerdown", onDown);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
      },
    });
  },
};
