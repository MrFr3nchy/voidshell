import type { KernelContext, VoidModule } from "../../kernel/types";
import { mountStage, palette, toolbar, toolButton, withAlpha } from "../../ui/canvasStage";

/**
 * A Bell test you can turn the dials on.
 *
 * A source in the middle emits a pair, one photon each way, and each side
 * passes its photon through a polarizer set to an angle you choose. Every
 * detection is a single click — `+` if it passed, `-` if it didn't. Neither
 * tape means anything alone; both are fair coins no matter where you point
 * the filters. The whole result lives in the comparison.
 *
 * Two source models are provided, and switching between them is the point:
 *
 *   quantum — the real thing. Correlation E = cos(2Δ).
 *   local   — a coin factory. Each pair leaves carrying a shared secret
 *             polarization λ, and each side's outcome is a fixed function of
 *             λ and its own angle. Exactly the "they agreed in advance"
 *             story everyone reaches for first.
 *
 * The local model is not a strawman: it reproduces perfect agreement at equal
 * angles and perfectly fair marginals, which is everything a casual account
 * of entanglement asks of it. It fails anyway, and the CHSH readout is where
 * you watch it fail — it saturates at S = 2 and cannot be pushed past, while
 * the quantum source walks up to 2.83.
 */

const D2R = Math.PI / 180;

/** Alice's two settings and Bob's two, the standard CHSH choice. */
const A_ANGLES = [0, 45];
const B_ANGLES = [22.5, 67.5];

/** Free-dial presets, in degrees off vertical. */
const DIAL = [0, 22.5, 45, 67.5, 90];

type Model = "quantum" | "local";

interface Pair {
  /** 0 at the source, 1 at the polarizers. */
  t: number;
  a: number;
  b: number;
  outA: 1 | -1;
  outB: 1 | -1;
}

interface Tally {
  n: number;
  /** Running sum of outA*outB, so E = sum / n. */
  sum: number;
  same: number;
}

/**
 * The Phi+ state. Conditional on Alice's outcome, Bob matches with
 * probability cos²Δ — and Alice's own outcome is a fair coin regardless of
 * either angle, which is what "a single entangled photon is unpolarized"
 * means in code.
 */
function sampleQuantum(a: number, b: number): [1 | -1, 1 | -1] {
  const outA: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  const pSame = Math.cos((a - b) * D2R) ** 2;
  const outB: 1 | -1 = Math.random() < pSame ? outA : ((-outA) as 1 | -1);
  return [outA, outB];
}

/**
 * A local hidden-variable source. One shared angle λ per pair, drawn at the
 * crystal and carried outward; each detector then just asks whether its own
 * axis lands in the passing half. No communication, no lookahead.
 */
function sampleLocal(a: number, b: number): [1 | -1, 1 | -1] {
  const lam = Math.random() * 180;
  const outA: 1 | -1 = Math.cos(2 * (a - lam) * D2R) >= 0 ? 1 : -1;
  const outB: 1 | -1 = Math.cos(2 * (b - lam) * D2R) >= 0 ? 1 : -1;
  return [outA, outB];
}

/** Predicted correlation, quantum: a clean cosine. */
function eQuantum(d: number): number {
  return Math.cos(2 * d * D2R);
}

/** Predicted correlation for the coin factory: a triangle wave, not a cosine. */
function eLocal(d: number): number {
  let x = ((d % 180) + 180) % 180;
  if (x > 90) x = 180 - x;
  return 1 - x / 45;
}

function key(a: number, b: number): string {
  return `${a}|${b}`;
}

export const bell: VoidModule = {
  manifest: {
    id: "bell",
    name: "Bell Test",
    kind: "app",
    glyph: "\u25c8",
    blurb: "two detectors, one impossible correlation",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "bell.open",
      label: "bell",
      hint: "violate an inequality",
      glyph: "\u25c8",
      run: (c) => c.launch("bell"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "bell test",
      width: 600,
      height: 540,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        let model: Model = "quantum";
        let aIdx = 1; // 22.5 deg
        let bIdx = 0; // 0 deg
        let aliceAngle = DIAL[aIdx];
        let bobAngle = DIAL[bIdx];

        /** CHSH mode randomizes both settings per trial, as the real ones do. */
        let chsh = false;
        let running = true;
        let rate = 6; // pairs per second

        const inflight: Pair[] = [];
        const tallies = new Map<string, Tally>();
        const tape: Pair[] = [];
        let emitAcc = 0;
        let flashA = 0;
        let flashB = 0;
        let announced = false;

        const sample = (a: number, b: number) =>
          model === "quantum" ? sampleQuantum(a, b) : sampleLocal(a, b);

        const record = (p: Pair) => {
          const k = key(p.a, p.b);
          let tl = tallies.get(k);
          if (!tl) {
            tl = { n: 0, sum: 0, same: 0 };
            tallies.set(k, tl);
          }
          tl.n += 1;
          tl.sum += p.outA * p.outB;
          if (p.outA === p.outB) tl.same += 1;
        };

        const eOf = (a: number, b: number): number | null => {
          const tl = tallies.get(key(a, b));
          return tl && tl.n > 0 ? tl.sum / tl.n : null;
        };

        /** S = E(a0,b0) - E(a0,b1) + E(a1,b0) + E(a1,b1). */
        const chshS = (): number | null => {
          const e00 = eOf(A_ANGLES[0], B_ANGLES[0]);
          const e01 = eOf(A_ANGLES[0], B_ANGLES[1]);
          const e10 = eOf(A_ANGLES[1], B_ANGLES[0]);
          const e11 = eOf(A_ANGLES[1], B_ANGLES[1]);
          if (e00 === null || e01 === null || e10 === null || e11 === null) return null;
          return e00 - e01 + e10 + e11;
        };

        const settingsForTrial = (): [number, number] => {
          if (!chsh) return [aliceAngle, bobAngle];
          return [
            A_ANGLES[Math.floor(Math.random() * A_ANGLES.length)],
            B_ANGLES[Math.floor(Math.random() * B_ANGLES.length)],
          ];
        };

        const emit = () => {
          const [a, b] = settingsForTrial();
          const [outA, outB] = sample(a, b);
          inflight.push({ t: 0, a, b, outA, outB });
        };

        /** Skip the animation and just pile up statistics. */
        const burst = (n: number) => {
          for (let i = 0; i < n; i += 1) {
            const [a, b] = settingsForTrial();
            const [outA, outB] = sample(a, b);
            const p: Pair = { t: 1, a, b, outA, outB };
            record(p);
            tape.push(p);
          }
          while (tape.length > 40) tape.shift();
        };

        const reset = () => {
          tallies.clear();
          tape.length = 0;
          inflight.length = 0;
          announced = false;
        };

        const stop = mountStage(stageHost, {
          className: "bell-canvas",
          frame: (st, dt) => {
            const { g, w, h } = st;
            const c = palette();
            g.clearRect(0, 0, w, h);

            /* ---------------- advance ---------------- */

            if (running) {
              emitAcc += dt * rate;
              while (emitAcc >= 1) {
                emitAcc -= 1;
                emit();
              }
            }
            for (let i = inflight.length - 1; i >= 0; i -= 1) {
              const p = inflight[i];
              p.t += dt * 1.5;
              if (p.t >= 1) {
                record(p);
                tape.push(p);
                if (p.outA === 1) flashA = 0.2;
                if (p.outB === 1) flashB = 0.2;
                inflight.splice(i, 1);
              }
            }
            while (tape.length > 40) tape.shift();
            flashA = Math.max(0, flashA - dt);
            flashB = Math.max(0, flashB - dt);

            /* ---------------- apparatus ---------------- */

            const beamY = h * 0.17;
            const cx = w / 2;
            const fAx = w * 0.26;
            const fBx = w * 0.74;
            const dAx = w * 0.1;
            const dBx = w * 0.9;

            g.strokeStyle = withAlpha(c.dim, 0.3);
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(dAx, beamY);
            g.lineTo(dBx, beamY);
            g.stroke();

            // source
            g.fillStyle = c.ember;
            g.beginPath();
            g.moveTo(cx, beamY - 7);
            g.lineTo(cx + 6, beamY);
            g.lineTo(cx, beamY + 7);
            g.lineTo(cx - 6, beamY);
            g.closePath();
            g.fill();
            g.fillStyle = c.dim;
            g.font = "9px ui-monospace, monospace";
            g.textAlign = "center";
            g.fillText("source", cx, beamY + 22);

            const drawFilter = (x: number, angle: number, col: string) => {
              g.strokeStyle = withAlpha(col, 0.85);
              g.lineWidth = 1.2;
              g.strokeRect(x - 9, beamY - 15, 18, 30);
              // the axis: 0 deg is vertical, rotating clockwise on screen
              const r = 12;
              const rad = angle * D2R;
              const dx = Math.sin(rad) * r;
              const dy = -Math.cos(rad) * r;
              g.strokeStyle = col;
              g.lineWidth = 2;
              g.beginPath();
              g.moveTo(x - dx, beamY - dy);
              g.lineTo(x + dx, beamY + dy);
              g.stroke();
            };

            const drawDetector = (x: number, flash: number, col: string) => {
              const hot = flash > 0;
              g.fillStyle = hot ? col : withAlpha(col, 0.12);
              g.strokeStyle = withAlpha(col, 0.8);
              g.lineWidth = 1.2;
              g.beginPath();
              g.rect(x - 11, beamY - 9, 22, 18);
              g.fill();
              g.stroke();
            };

            drawFilter(fAx, aliceAngle, c.cyan);
            drawFilter(fBx, bobAngle, c.magenta);
            drawDetector(dAx, flashA, c.cyan);
            drawDetector(dBx, flashB, c.magenta);

            g.font = "9px ui-monospace, monospace";
            g.fillStyle = c.cyan;
            g.fillText(chsh ? "A  ?" : `A  ${aliceAngle}\u00b0`, fAx, beamY + 30);
            g.fillStyle = c.magenta;
            g.fillText(chsh ? "B  ?" : `B  ${bobAngle}\u00b0`, fBx, beamY + 30);

            // photons in flight
            for (const p of inflight) {
              const xa = cx - p.t * (cx - fAx);
              const xb = cx + p.t * (fBx - cx);
              g.fillStyle = c.cyan;
              g.beginPath();
              g.arc(xa, beamY, 2.6, 0, Math.PI * 2);
              g.fill();
              g.fillStyle = c.magenta;
              g.beginPath();
              g.arc(xb, beamY, 2.6, 0, Math.PI * 2);
              g.fill();
            }

            /* ---------------- correlation curve ---------------- */

            const cyTop = h * 0.32;
            const cyBot = h * 0.62;
            const cxL = w * 0.1;
            const cxR = w * 0.92;
            const xOf = (d: number) => cxL + (d / 90) * (cxR - cxL);
            const yOf = (e: number) => cyBot - ((e + 1) / 2) * (cyBot - cyTop);

            g.strokeStyle = withAlpha(c.dim, 0.28);
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(cxL, yOf(0));
            g.lineTo(cxR, yOf(0));
            g.stroke();
            g.beginPath();
            g.moveTo(cxL, yOf(1));
            g.lineTo(cxL, yOf(-1));
            g.stroke();

            g.fillStyle = c.dim;
            g.textAlign = "right";
            g.fillText("+1", cxL - 5, yOf(1) + 3);
            g.fillText("0", cxL - 5, yOf(0) + 3);
            g.fillText("-1", cxL - 5, yOf(-1) + 3);
            g.textAlign = "center";
            g.fillText("\u0394 = 0\u00b0", cxL, cyBot + 14);
            g.fillText("45\u00b0", xOf(45), cyBot + 14);
            g.fillText("90\u00b0", cxR, cyBot + 14);

            const curve = (fn: (d: number) => number, col: string, strong: boolean) => {
              g.strokeStyle = strong ? col : withAlpha(col, 0.3);
              g.lineWidth = strong ? 1.8 : 1;
              g.beginPath();
              for (let d = 0; d <= 90; d += 1) {
                const x = xOf(d);
                const y = yOf(fn(d));
                if (d === 0) g.moveTo(x, y);
                else g.lineTo(x, y);
              }
              g.stroke();
            };

            curve(eLocal, c.ember, model === "local");
            curve(eQuantum, c.cyan, model === "quantum");

            // measured points, one per angle pair we have data for
            for (const [k, tl] of tallies) {
              if (tl.n < 8) continue;
              const [as, bs] = k.split("|");
              let d = Math.abs(Number(as) - Number(bs)) % 180;
              if (d > 90) d = 180 - d;
              g.fillStyle = c.text;
              g.beginPath();
              g.arc(xOf(d), yOf(tl.sum / tl.n), 3, 0, Math.PI * 2);
              g.fill();
            }

            g.textAlign = "left";
            g.fillStyle = model === "quantum" ? c.cyan : withAlpha(c.cyan, 0.4);
            g.fillText("cos 2\u0394  (quantum)", cxL + 6, cyTop - 6);
            g.fillStyle = model === "local" ? c.ember : withAlpha(c.ember, 0.4);
            g.fillText("shared-\u03bb  (local)", cxL + 6, cyTop + 7);

            /* ---------------- tapes ---------------- */

            const tapeY = h * 0.73;
            const step = 13;
            const shown = tape.slice(-Math.max(1, Math.floor((w - 60) / step)));
            g.font = "11px ui-monospace, monospace";
            g.textAlign = "left";
            g.fillStyle = c.dim;
            g.fillText("A", 12, tapeY);
            g.fillText("B", 12, tapeY + 15);

            g.textAlign = "center";
            shown.forEach((p, i) => {
              const x = 32 + i * step;
              const agree = p.outA === p.outB;
              g.fillStyle = agree ? c.cyan : c.ember;
              g.fillText(p.outA === 1 ? "+" : "\u2212", x, tapeY);
              g.fillStyle = agree ? c.magenta : c.ember;
              g.fillText(p.outB === 1 ? "+" : "\u2212", x, tapeY + 15);
            });

            /* ---------------- readout ---------------- */

            const lineY = h * 0.86;
            g.textAlign = "left";
            g.font = "10px ui-monospace, monospace";

            let total = 0;
            for (const tl of tallies.values()) total += tl.n;

            if (chsh) {
              const s = chshS();
              g.fillStyle = c.dim;
              g.fillText(
                `CHSH  \u2014  settings randomized per pair  \u2014  n = ${total}`,
                12,
                lineY
              );
              if (s === null) {
                g.fillStyle = c.dim;
                g.fillText("collecting all four angle pairs\u2026", 12, lineY + 15);
              } else {
                const violates = Math.abs(s) > 2;
                g.fillStyle = violates ? c.ember : c.text;
                g.fillText(
                  `S = ${s.toFixed(3)}    classical limit 2    quantum max 2.828`,
                  12,
                  lineY + 15
                );
                g.fillStyle = c.dim;
                g.fillText(
                  violates
                    ? "no shared-\u03bb story can produce this number."
                    : "within the classical bound \u2014 a coin factory could fake this.",
                  12,
                  lineY + 30
                );
                if (violates && !announced && total > 400) {
                  announced = true;
                  ctx.notify(`Bell inequality violated \u2014 S = ${s.toFixed(2)}`, "good");
                }
              }
            } else {
              const tl = tallies.get(key(aliceAngle, bobAngle));
              let d = Math.abs(aliceAngle - bobAngle) % 180;
              if (d > 90) d = 180 - d;
              const pred = model === "quantum" ? eQuantum(d) : eLocal(d);
              g.fillStyle = c.dim;
              g.fillText(
                `\u0394 = ${d}\u00b0    n = ${tl?.n ?? 0}    predicted E = ${pred.toFixed(3)}`,
                12,
                lineY
              );
              g.fillStyle = c.text;
              if (tl && tl.n > 0) {
                const pct = ((tl.same / tl.n) * 100).toFixed(1);
                g.fillText(
                  `measured E = ${(tl.sum / tl.n).toFixed(3)}    tapes agree ${pct}% of the time`,
                  12,
                  lineY + 15
                );
              } else {
                g.fillText("no data at this setting yet", 12, lineY + 15);
              }
              g.fillStyle = c.dim;
              g.fillText(
                "each tape alone is a fair coin \u2014 the result is only in the comparison.",
                12,
                lineY + 30
              );
            }
          },
        });

        /* ---------------- controls ---------------- */

        const runBtn = toolButton(bar, "pause", (b) => {
          running = !running;
          b.textContent = running ? "pause" : "run";
        });
        runBtn.textContent = "pause";

        toolButton(bar, "fire", () => emit());
        toolButton(bar, "+500", () => burst(500));

        const aBtn = toolButton(bar, `A ${aliceAngle}\u00b0`, (b) => {
          aIdx = (aIdx + 1) % DIAL.length;
          aliceAngle = DIAL[aIdx];
          b.textContent = `A ${aliceAngle}\u00b0`;
        });
        const bBtn = toolButton(bar, `B ${bobAngle}\u00b0`, (b) => {
          bIdx = (bIdx + 1) % DIAL.length;
          bobAngle = DIAL[bIdx];
          b.textContent = `B ${bobAngle}\u00b0`;
        });

        toolButton(bar, "quantum", (b) => {
          model = model === "quantum" ? "local" : "quantum";
          b.textContent = model;
          reset();
        });

        toolButton(bar, "chsh", (b) => {
          chsh = !chsh;
          b.textContent = chsh ? "free dials" : "chsh";
          aBtn.disabled = chsh;
          bBtn.disabled = chsh;
          reset();
        });

        toolButton(bar, "reset", () => reset());

        return () => stop();
      },
    });
  },
};
