import type { KernelContext, VoidModule } from "../../kernel/types";

/**
 * A countdown and a stopwatch.
 *
 * The shell has a clock, an orrery, a sunclock and a bell that chimes the
 * hour — every way of telling you what time it is, and no way of telling you
 * when a length of time has passed, which is the thing people actually set.
 *
 * The important part is that it keeps time against `Date.now()` rather than
 * counting frames or intervals. A background tab is throttled to roughly one
 * timer a minute, so anything that counts ticks silently runs slow — and a
 * timer that is wrong is worse than no timer, because you trusted it.
 */

const PRESETS = [1, 3, 5, 10, 25, 45];

type Mode = "timer" | "stopwatch";

export const timer: VoidModule = {
  manifest: {
    id: "timer",
    name: "Timer",
    kind: "app",
    glyph: "◔",
    blurb: "countdown and stopwatch",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "timer.open",
      label: "Set a timer",
      hint: "countdown or stopwatch",
      glyph: "◔",
      run: (c) => c.launch("timer"),
    });
  },

  launch(ctx: KernelContext) {
    const { tone } = ctx.audio;
    ctx.openSurface({
      title: "timer",
      width: 340,
      height: 300,
      render: (root) => {
        root.innerHTML = "";
        root.className = "tm-root";

        const tabs = document.createElement("div");
        tabs.className = "tm-tabs";
        const timerTab = document.createElement("button");
        timerTab.className = "tm-tab on";
        timerTab.textContent = "timer";
        const watchTab = document.createElement("button");
        watchTab.className = "tm-tab";
        watchTab.textContent = "stopwatch";
        tabs.append(timerTab, watchTab);

        const face = document.createElement("div");
        face.className = "tm-face";

        const ring = document.createElement("div");
        ring.className = "tm-ring";
        face.appendChild(ring);

        const readout = document.createElement("div");
        readout.className = "tm-readout";
        face.appendChild(readout);

        const presets = document.createElement("div");
        presets.className = "tm-presets";

        const controls = document.createElement("div");
        controls.className = "tm-controls";
        const startBtn = document.createElement("button");
        startBtn.className = "fm-btn";
        const resetBtn = document.createElement("button");
        resetBtn.className = "fm-btn";
        resetBtn.textContent = "reset";
        const lapBtn = document.createElement("button");
        lapBtn.className = "fm-btn";
        lapBtn.textContent = "lap";
        controls.append(startBtn, lapBtn, resetBtn);

        const laps = document.createElement("div");
        laps.className = "tm-laps";

        root.append(tabs, face, presets, controls, laps);

        let mode: Mode = "timer";
        /** Milliseconds the countdown was set to. */
        let duration = 5 * 60_000;
        /** When the current run started, or 0 when stopped. */
        let startedAt = 0;
        /** Accumulated time from previous runs, so pause/resume is exact. */
        let carried = 0;
        let lapTimes: number[] = [];
        let rang = false;

        const elapsed = () => carried + (startedAt ? Date.now() - startedAt : 0);
        const running = () => startedAt !== 0;

        /** mm:ss.t — minutes keep counting past 60 rather than rolling over. */
        const format = (ms: number): string => {
          const seconds = Math.max(0, ms) / 1000;
          const m = Math.floor(seconds / 60);
          const s = seconds - m * 60;
          return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
        };

        const paintPresets = () => {
          presets.replaceChildren();
          presets.classList.toggle("hidden", mode !== "timer");
          for (const min of PRESETS) {
            const b = document.createElement("button");
            b.className = "tm-preset";
            b.classList.toggle("on", duration === min * 60_000 && !running());
            b.textContent = `${min}m`;
            b.addEventListener("click", () => {
              duration = min * 60_000;
              carried = 0;
              startedAt = 0;
              rang = false;
              paint();
            });
            presets.appendChild(b);
          }
        };

        const paint = () => {
          const ms = elapsed();
          const remaining = Math.max(0, duration - ms);
          const shown = mode === "timer" ? remaining : ms;
          readout.textContent = format(shown);
          readout.classList.toggle("done", mode === "timer" && remaining === 0);

          const frac = mode === "timer" ? (duration ? remaining / duration : 0) : (ms % 60_000) / 60_000;
          ring.style.setProperty("--frac", frac.toFixed(4));

          startBtn.textContent = running() ? "pause" : ms > 0 ? "resume" : "start";
          lapBtn.classList.toggle("hidden", mode !== "stopwatch");
          lapBtn.disabled = !running();
          paintPresets();

          // The alarm fires from the paint loop rather than a setTimeout, for
          // the same reason the clock is wall-time: a throttled background tab
          // would deliver the timeout late, and this way it is late by at most
          // one frame after the tab comes back.
          if (mode === "timer" && running() && remaining === 0 && !rang) {
            rang = true;
            startedAt = 0;
            carried = duration;
            chime();
            ctx.notify("timer finished", {
              kind: "good",
              action: { label: "reset", run: () => reset() },
            });
          }
        };

        const chime = () => {
          // Three rising notes: audible, brief, and not the system warning
          // sound — a finished timer is good news.
          [0, 180, 360].forEach((delay, i) =>
            window.setTimeout(() => tone({ freq: 660 + i * 220, gain: 0.09, decay: 0.35 }), delay)
          );
        };

        const reset = () => {
          startedAt = 0;
          carried = 0;
          lapTimes = [];
          rang = false;
          paintLaps();
          paint();
        };

        const paintLaps = () => {
          laps.replaceChildren();
          laps.classList.toggle("hidden", mode !== "stopwatch" || !lapTimes.length);
          lapTimes.forEach((t, i) => {
            const row = document.createElement("div");
            row.className = "tm-lap";
            const n = document.createElement("span");
            n.textContent = `${i + 1}`;
            const at = document.createElement("span");
            at.textContent = format(t);
            const delta = document.createElement("span");
            delta.className = "tm-lap-delta";
            delta.textContent = i ? `+${format(t - lapTimes[i - 1])}` : "";
            row.append(n, at, delta);
            laps.appendChild(row);
          });
        };

        startBtn.addEventListener("click", () => {
          if (running()) {
            carried = elapsed();
            startedAt = 0;
          } else {
            if (mode === "timer" && carried >= duration) carried = 0;
            rang = false;
            startedAt = Date.now();
          }
          paint();
        });

        resetBtn.addEventListener("click", reset);
        lapBtn.addEventListener("click", () => {
          if (!running()) return;
          lapTimes.push(elapsed());
          paintLaps();
        });

        const setMode = (next: Mode) => {
          mode = next;
          timerTab.classList.toggle("on", next === "timer");
          watchTab.classList.toggle("on", next === "stopwatch");
          reset();
        };
        timerTab.addEventListener("click", () => setMode("timer"));
        watchTab.addEventListener("click", () => setMode("stopwatch"));

        paint();
        // 100ms is enough for a tenth-of-a-second readout and cheap enough to
        // leave running; the value shown is computed from the clock either way.
        const tick = window.setInterval(paint, 100);

        return () => {
          window.clearInterval(tick);
          root.replaceChildren();
        };
      },
    });
  },
};
