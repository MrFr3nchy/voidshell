import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";

const BALLS = 5;
const G = 9.81;
const ROPE_M = 1; // pendulum length in metres — sets the swing period, not the look
const SUBSTEPS = 8;
const SOUND_KEY = "cradle.sound";

/**
 * Five steel balls and one conservation law. Nothing here is faked: each ball
 * is an independent pendulum integrated at 8 substeps a frame, and a "click" is
 * an elastic collision between equal masses, which is just a velocity swap.
 * The famous behaviour — lift two, two come out the far side — falls out of
 * that on its own. Nobody scripted it.
 */
export const cradle: VoidModule = {
  manifest: {
    id: "cradle",
    name: "Cradle",
    kind: "app",
    glyph: "\u26ad",
    blurb: "five balls, one conservation law",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineSetting({
      key: SOUND_KEY,
      label: "cradle clack",
      kind: "toggle",
      group: "Apps",
      hint: "let the cradle make a noise when the balls meet.",
      default: false,
      order: 10,
    });
    ctx.defineCommand({
      id: "cradle.open",
      label: "cradle",
      hint: "swing something",
      glyph: "\u26ad",
      run: (c) => c.launch("cradle"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "cradle",
      width: 380,
      height: 300,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);

        const bar = toolbar(root);

        /* ---------------- state ---------------- */

        const theta = new Array<number>(BALLS).fill(0);
        const omega = new Array<number>(BALLS).fill(0);
        const flash = new Array<number>(BALLS).fill(0);

        let radius = 16;
        let rope = 120;
        let barY = 16;
        let cx = 0;

        const restX = (i: number) => cx + (i - (BALLS - 1) / 2) * radius * 2;
        const ballX = (i: number) => restX(i) + rope * Math.sin(theta[i]);
        const ballY = (i: number) => barY + rope * Math.cos(theta[i]);

        const lift = (count: number) => {
          for (let i = 0; i < BALLS; i++) {
            theta[i] = 0;
            omega[i] = 0;
          }
          for (let i = 0; i < Math.min(count, BALLS); i++) theta[i] = -0.62;
        };

        /* ---------------- sound ---------------- */

        let audio: AudioContext | null = null;
        let noise: AudioBuffer | null = null;
        let soundOn = ctx.state.get<boolean>(SOUND_KEY, false);

        const clack = (strength: number) => {
          if (!soundOn) return;
          try {
            if (!audio) {
              const Ctor =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext?: typeof AudioContext })
                  .webkitAudioContext;
              if (!Ctor) return;
              audio = new Ctor();
            }
            if (audio.state === "suspended") void audio.resume();
            if (!noise) {
              const len = Math.floor(audio.sampleRate * 0.05);
              noise = audio.createBuffer(1, len, audio.sampleRate);
              const data = noise.getChannelData(0);
              for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
            }
            const src = audio.createBufferSource();
            src.buffer = noise;
            const band = audio.createBiquadFilter();
            band.type = "bandpass";
            band.frequency.value = 1500 + Math.random() * 500;
            band.Q.value = 3;
            const gain = audio.createGain();
            const peak = Math.min(0.22, strength * 0.09);
            gain.gain.setValueAtTime(peak, audio.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.05);
            src.connect(band).connect(gain).connect(audio.destination);
            src.start();
          } catch {
            /* audio is a nicety; never let it take the app down */
          }
        };

        /* ---------------- physics ---------------- */

        let dragging = -1;

        const step = (dt: number) => {
          const h = dt / SUBSTEPS;
          for (let s = 0; s < SUBSTEPS; s++) {
            for (let i = 0; i < BALLS; i++) {
              if (i === dragging) continue;
              omega[i] += -(G / ROPE_M) * Math.sin(theta[i]) * h;
              omega[i] *= 1 - 0.04 * h; // air, rope, honesty
              theta[i] += omega[i] * h;
            }
            // Equal masses, elastic: a collision is a velocity swap. Several
            // passes so an impulse can travel the whole chain in one substep.
            for (let pass = 0; pass < BALLS; pass++) {
              for (let i = 0; i < BALLS - 1; i++) {
                const touching = theta[i + 1] <= theta[i];
                const closing = omega[i] - omega[i + 1] > 0;
                if (!touching || !closing) continue;
                const impact = omega[i] - omega[i + 1];
                const swap = omega[i];
                omega[i] = omega[i + 1];
                omega[i + 1] = swap;
                const mid = (theta[i] + theta[i + 1]) / 2;
                theta[i] = mid;
                theta[i + 1] = mid;
                if (impact > 0.35 && s === 0 && pass === 0) {
                  flash[i] = Math.min(1, impact / 3);
                  flash[i + 1] = flash[i];
                  clack(impact);
                }
              }
            }
          }
          for (let i = 0; i < BALLS; i++) flash[i] = Math.max(0, flash[i] - dt * 4);
        };

        /* ---------------- drawing ---------------- */

        const stop = mountStage(stageHost, {
          className: "cradle-canvas",
          layout: (st) => {
            cx = st.w / 2;
            radius = Math.max(6, Math.min(st.w / (BALLS * 2 + 2.5), 22));
            barY = 14;
            rope = Math.max(40, st.h - barY - radius - 16);
          },
          frame: (st, dt) => {
            if (dragging < 0) step(dt);

            const { g, w, h } = st;
            const c = palette();
            g.clearRect(0, 0, w, h);

            // frame: the beam the ropes hang from
            g.strokeStyle = c.dim;
            g.globalAlpha = 0.5;
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(cx - radius * BALLS - 8, barY);
            g.lineTo(cx + radius * BALLS + 8, barY);
            g.stroke();
            g.globalAlpha = 1;

            for (let i = 0; i < BALLS; i++) {
              const x = ballX(i);
              const y = ballY(i);

              g.strokeStyle = c.dim;
              g.globalAlpha = 0.45;
              g.lineWidth = 1;
              g.beginPath();
              g.moveTo(restX(i), barY);
              g.lineTo(x, y);
              g.stroke();
              g.globalAlpha = 1;

              if (flash[i] > 0.01) {
                g.beginPath();
                g.arc(x, y, radius * (1.4 + flash[i]), 0, Math.PI * 2);
                g.fillStyle = withAlpha(c.cyan, flash[i] * 0.22);
                g.fill();
              }

              const grad = g.createRadialGradient(
                x - radius * 0.35,
                y - radius * 0.4,
                radius * 0.1,
                x,
                y,
                radius
              );
              grad.addColorStop(0, withAlpha(c.text, 0.95));
              grad.addColorStop(0.45, withAlpha(c.cyan, 0.55));
              grad.addColorStop(1, "rgba(8,11,22,0.95)");
              g.beginPath();
              g.arc(x, y, radius, 0, Math.PI * 2);
              g.fillStyle = grad;
              g.fill();
              g.strokeStyle = withAlpha(c.cyan, 0.55);
              g.lineWidth = 1;
              g.stroke();
            }
          },
        });

        /* ---------------- pointer ---------------- */

        const canvas = stageHost.querySelector("canvas");
        let lastAngle = 0;
        let lastTime = 0;

        const angleFromPointer = (i: number, px: number, py: number) => {
          const dx = px - restX(i);
          const dy = Math.max(6, py - barY);
          return Math.max(-1.35, Math.min(1.35, Math.atan2(dx, dy)));
        };

        const onDown = (e: PointerEvent) => {
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          let best = -1;
          let bestD = radius * 2.2;
          for (let i = 0; i < BALLS; i++) {
            const d = Math.hypot(px - ballX(i), py - ballY(i));
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          if (best < 0) return;
          dragging = best;
          omega[best] = 0;
          theta[best] = angleFromPointer(best, px, py);
          lastAngle = theta[best];
          lastTime = performance.now();
          canvas.setPointerCapture(e.pointerId);
          e.preventDefault();
        };

        const onMove = (e: PointerEvent) => {
          if (dragging < 0 || !canvas) return;
          const rect = canvas.getBoundingClientRect();
          const next = angleFromPointer(
            dragging,
            e.clientX - rect.left,
            e.clientY - rect.top
          );
          const now = performance.now();
          const dt = Math.max(0.008, (now - lastTime) / 1000);
          omega[dragging] = (next - lastAngle) / dt;
          theta[dragging] = next;
          lastAngle = next;
          lastTime = now;
        };

        const onUp = () => {
          if (dragging < 0) return;
          // Hand the swing back to physics with whatever speed you let go at.
          omega[dragging] = Math.max(-6, Math.min(6, omega[dragging]));
          dragging = -1;
        };

        canvas?.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);

        /* ---------------- controls ---------------- */

        toolButton(bar, "lift 1", () => lift(1));
        toolButton(bar, "lift 2", () => lift(2));
        toolButton(bar, "lift 3", () => lift(3));
        toolButton(bar, "still", () => lift(0));

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

        lift(1);

        return () => {
          stop();
          unsub();
          canvas?.removeEventListener("pointerdown", onDown);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          void audio?.close();
        };
      },
    });
  },
};
