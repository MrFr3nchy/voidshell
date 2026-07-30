import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  rgbOf,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";

const CELL = 3;

/** Each rule is one turn per colour. The ant cycles colours as it goes. */
const RULES = [
  { rule: "RL", note: "the highway" },
  { rule: "LLRR", note: "grows a square" },
  { rule: "RLR", note: "chaotic blob" },
  { rule: "LRRRRRLLR", note: "cardioid" },
  { rule: "RRLLLRLLLRRR", note: "filigree" },
];

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/**
 * Langton's ant, and its larger family. One ant, four directions, and a rule
 * string with one turn per colour: read the cell you're on, turn that way,
 * advance the cell's colour, step forward. That is the whole program.
 *
 * With rule "RL" it scribbles chaotically for about ten thousand steps and
 * then — with no special case anywhere in the code, and for reasons still not
 * really proven — starts building a perfectly periodic diagonal highway and
 * never stops. Change the rule string and you get a different universe.
 */
export const turmite: VoidModule = {
  manifest: {
    id: "turmite",
    name: "Turmite",
    kind: "app",
    glyph: "\u259a",
    blurb: "one ant, one rule, a highway",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "turmite.open",
      label: "turmite",
      hint: "let an ant out",
      glyph: "\u259a",
      run: (c) => c.launch("turmite"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "turmite",
      width: 400,
      height: 360,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        let gw = 1;
        let gh = 1;
        let cells = new Uint8Array(1);

        let off: HTMLCanvasElement | null = null;
        let offG: CanvasRenderingContext2D | null = null;
        let image: ImageData | null = null;

        let ruleIndex = 0;
        let rule = RULES[0].rule;
        let x = 0;
        let y = 0;
        let dir = 0;
        let steps = 0;
        let perFrame = 2000;
        let running = true;

        const restart = () => {
          cells.fill(0);
          x = gw >> 1;
          y = gh >> 1;
          dir = 0;
          steps = 0;
        };

        const reshape = (w: number, h: number) => {
          gw = Math.max(16, Math.floor(w / CELL));
          gh = Math.max(16, Math.floor(h / CELL));
          cells = new Uint8Array(gw * gh);
          off = document.createElement("canvas");
          off.width = gw;
          off.height = gh;
          offG = off.getContext("2d");
          image = offG ? offG.createImageData(gw, gh) : null;
          restart();
        };

        const advance = (n: number) => {
          const states = rule.length;
          for (let s = 0; s < n; s++) {
            const i = y * gw + x;
            const state = cells[i];
            // Turn by this colour's rule, repaint, step. Four lines, no cases.
            dir = rule[state] === "R" ? (dir + 1) & 3 : (dir + 3) & 3;
            cells[i] = (state + 1) % states;
            x = (x + DX[dir] + gw) % gw;
            y = (y + DY[dir] + gh) % gh;
          }
          steps += n;
        };

        const stop = mountStage(stageHost, {
          className: "ant-canvas",
          layout: (st) => reshape(st.w, st.h),
          frame: (st) => {
            if (running) advance(perFrame);

            const { g, w, h } = st;
            if (!image || !offG || !off) return;

            const c = palette();
            const [cr, cg, cb] = rgbOf(c.cyan);
            const [mr, mg, mb] = rgbOf(c.magenta);
            const states = rule.length;
            const data = image.data;

            for (let i = 0; i < cells.length; i++) {
              const state = cells[i];
              const p = i * 4;
              if (state === 0) {
                data[p + 3] = 0;
                continue;
              }
              // Colour by how far round the cycle the cell has been pushed.
              const t = states > 2 ? (state - 1) / (states - 2) : 0;
              data[p] = cr + (mr - cr) * t;
              data[p + 1] = cg + (mg - cg) * t;
              data[p + 2] = cb + (mb - cb) * t;
              data[p + 3] = 120 + t * 110;
            }

            offG.putImageData(image, 0, 0);
            g.clearRect(0, 0, w, h);
            g.imageSmoothingEnabled = false;
            g.drawImage(off, 0, 0, w, h);

            // The ant itself, so you can watch it work.
            const sx = w / gw;
            const sy = h / gh;
            g.beginPath();
            g.arc((x + 0.5) * sx, (y + 0.5) * sy, Math.max(2, sx), 0, Math.PI * 2);
            g.fillStyle = withAlpha(c.ember, 0.95);
            g.fill();

            g.fillStyle = withAlpha(c.dim, 0.75);
            g.font = "9px ui-monospace, monospace";
            g.fillText(
              `${rule}  \u2014  ${RULES[ruleIndex].note}  \u2014  ${steps.toLocaleString()} steps`,
              6,
              h - 6
            );
          },
        });

        toolButton(bar, "pause", (b) => {
          running = !running;
          b.textContent = running ? "pause" : "play";
          b.classList.toggle("on", running);
        }).classList.add("on");

        toolButton(bar, RULES[0].rule, (b) => {
          ruleIndex = (ruleIndex + 1) % RULES.length;
          rule = RULES[ruleIndex].rule;
          restart();
          b.textContent = rule;
          ctx.notify(`turmite: ${rule} \u2014 ${RULES[ruleIndex].note}`, "info");
        });

        toolButton(bar, "2k/frame", (b) => {
          perFrame = perFrame === 2000 ? 20000 : perFrame === 20000 ? 200 : 2000;
          b.textContent = perFrame >= 1000 ? `${perFrame / 1000}k/frame` : `${perFrame}/frame`;
        });

        toolButton(bar, "restart", () => restart());

        return () => stop();
      },
    });
  },
};
