import type { KernelContext, VoidModule } from "../../kernel/types";
import { tone } from "../../ui/blip";
import { SOUND_KEY } from "../shell";

/**
 * A calculator.
 *
 * Every desktop has one and this one did not, which meant the answer to "what
 * is 18% of 340" in an OS with a Python runtime was "open the editor, write a
 * file, run it". The console can do arithmetic too, and neither is what a
 * person reaches for.
 *
 * It is a *tape* calculator rather than a grid of buttons: you type an
 * expression, it keeps the result, and every line stays on screen where you
 * can see how you got there. `ans` is the previous result, so a long
 * calculation reads like the working you would have written down.
 */

const TAPE_KEY = "calc.tape";
const TAPE_MAX = 40;

interface Entry {
  expr: string;
  value: string;
}

/**
 * Evaluate an arithmetic expression.
 *
 * A hand-written parser rather than `eval` or `new Function`: this string
 * comes from a text box, and a calculator has no business being able to reach
 * the DOM, the network, or the kernel. Nothing here can call anything — the
 * only operations are the ones in this file.
 */
export function evaluate(input: string, ans = 0): number {
  const src = input.trim();
  if (!src) throw new Error("");

  let at = 0;
  const ws = () => {
    while (at < src.length && /\s/.test(src[at])) at++;
  };
  const eat = (token: string): boolean => {
    ws();
    if (src.startsWith(token, at)) {
      at += token.length;
      return true;
    }
    return false;
  };

  const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, ans };
  const FUNCTIONS: Record<string, (n: number) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    log: Math.log10,
    ln: Math.log,
    exp: Math.exp,
  };

  /** number | (expr) | name | -atom */
  const atom = (): number => {
    ws();
    if (eat("(")) {
      const v = expr();
      if (!eat(")")) throw new Error("expected )");
      return v;
    }
    if (eat("-")) return -atom();
    if (eat("+")) return atom();

    const num = /^\d+(\.\d+)?([eE][-+]?\d+)?/.exec(src.slice(at));
    if (num) {
      at += num[0].length;
      return Number(num[0]);
    }

    const name = /^[a-zA-Z]+/.exec(src.slice(at));
    if (name) {
      at += name[0].length;
      const key = name[0].toLowerCase();
      if (key in CONSTANTS) return CONSTANTS[key];
      const fn = FUNCTIONS[key];
      if (!fn) throw new Error(`unknown name: ${name[0]}`);
      if (!eat("(")) throw new Error(`${key} needs ( )`);
      const v = fn(expr());
      if (!eat(")")) throw new Error("expected )");
      return v;
    }
    throw new Error(`unexpected "${src.slice(at, at + 8)}"`);
  };

  /** Right-associative, so 2^3^2 is 512 the way it is on paper. */
  const power = (): number => {
    const base = atom();
    if (eat("^") || eat("**")) return base ** power();
    // A percent is a postfix operator: 15% is 0.15, and 200*15% is 30.
    if (eat("%")) return base / 100;
    return base;
  };

  const term = (): number => {
    let v = power();
    for (;;) {
      if (eat("*")) v *= power();
      else if (eat("/")) {
        const d = power();
        if (d === 0) throw new Error("divide by zero");
        v /= d;
      } else if (eat("mod")) {
        const d = power();
        if (d === 0) throw new Error("divide by zero");
        v %= d;
      } else return v;
    }
  };

  const expr = (): number => {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  };

  const result = expr();
  ws();
  if (at < src.length) throw new Error(`unexpected "${src.slice(at)}"`);
  if (!Number.isFinite(result)) throw new Error("not a number");
  return result;
}

/** Trim floating-point noise without lying about magnitude. */
export function present(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const fixed = Number(n.toPrecision(12));
  return String(fixed);
}

export const calculator: VoidModule = {
  manifest: {
    id: "calculator",
    name: "Calculator",
    kind: "app",
    glyph: "≡",
    blurb: "a tape you can type into",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "calc.open",
      label: "Calculator",
      hint: "arithmetic, with a tape",
      glyph: "≡",
      run: (c) => c.launch("calculator"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "calculator",
      width: 380,
      height: 420,
      render: (root) => {
        root.innerHTML = "";
        root.className = "calc-root";

        const tape = document.createElement("div");
        tape.className = "calc-tape";

        const row = document.createElement("div");
        row.className = "calc-row";
        const prompt = document.createElement("span");
        prompt.className = "calc-prompt";
        prompt.textContent = "=";
        const input = document.createElement("input");
        input.className = "calc-input";
        input.type = "text";
        input.placeholder = "18% of 340 → 340*18%";
        input.setAttribute("aria-label", "Expression");
        row.append(prompt, input);

        const hint = document.createElement("div");
        hint.className = "calc-hint";
        hint.textContent = "ans · pi · e · sqrt() · ln() · ^ · mod · % · ↑↓ history";

        root.append(tape, row, hint);

        const read = (): Entry[] => ctx.state.get<Entry[]>(TAPE_KEY, []);
        const write = (list: Entry[]) => ctx.state.set(TAPE_KEY, list.slice(-TAPE_MAX));

        /** Where ↑ and ↓ are in the tape. -1 means "at the live line". */
        let browsing = -1;

        const paint = () => {
          const list = read();
          tape.replaceChildren();
          if (!list.length) {
            const empty = document.createElement("div");
            empty.className = "calc-empty";
            empty.textContent = "nothing yet";
            tape.appendChild(empty);
          }
          for (const e of list) {
            const line = document.createElement("button");
            line.className = "calc-line";
            const ex = document.createElement("span");
            ex.className = "calc-expr";
            ex.textContent = e.expr;
            const val = document.createElement("span");
            val.className = "calc-val";
            val.textContent = e.value;
            line.append(ex, val);
            // Clicking a result puts it back in play, which is what the tape
            // is *for* — otherwise it is just a log.
            line.addEventListener("click", () => {
              input.value += e.value;
              input.focus();
            });
            tape.appendChild(line);
          }
          tape.scrollTop = tape.scrollHeight;
        };

        const lastValue = (): number => {
          const list = read();
          return list.length ? Number(list[list.length - 1].value) || 0 : 0;
        };

        const submit = () => {
          const expr = input.value.trim();
          if (!expr) return;
          try {
            const value = present(evaluate(expr, lastValue()));
            write([...read(), { expr, value }]);
            input.value = "";
            browsing = -1;
            paint();
            if (ctx.state.get<boolean>(SOUND_KEY, false)) {
              tone({ freq: 880, toFreq: 1180, gain: 0.05, decay: 0.06 });
            }
          } catch (err) {
            const message = err instanceof Error && err.message ? err.message : "can't read that";
            ctx.notify(message, "warn");
            input.classList.add("bad");
            window.setTimeout(() => input.classList.remove("bad"), 400);
          }
        };

        input.addEventListener("keydown", (e) => {
          // The shell binds space and Escape globally; a text field has to win.
          e.stopPropagation();
          const list = read();
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "ArrowUp" && list.length) {
            e.preventDefault();
            browsing = browsing < 0 ? list.length - 1 : Math.max(0, browsing - 1);
            input.value = list[browsing].expr;
          } else if (e.key === "ArrowDown" && browsing >= 0) {
            e.preventDefault();
            browsing++;
            if (browsing >= list.length) {
              browsing = -1;
              input.value = "";
            } else input.value = list[browsing].expr;
          } else if (e.key === "Escape") {
            input.value = "";
            browsing = -1;
          }
        });

        // Clearing the tape is a verb, not a setting, so it lives on the tape.
        tape.addEventListener("dblclick", () => {
          write([]);
          paint();
          ctx.notify("tape cleared");
        });

        paint();
        requestAnimationFrame(() => input.focus());

        return () => root.replaceChildren();
      },
    });
  },
};
