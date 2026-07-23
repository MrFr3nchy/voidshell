import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";
import { basename, dirname } from "../../kernel/vfs";

/**
 * Runs programs.
 *
 * JavaScript executes in a plain worker; Python executes in Pyodide. Both
 * stream output into the panel, and both are killable — a runaway loop takes
 * the worker with it, not the shell.
 *
 * The panel doubles as the program's terminal: when Python blocks on `input()`
 * the prompt here is what unblocks it.
 */

const HEADER_BYTES = 8;
const MAX_INPUT_BYTES = 65536;
const STATE = 0;
const LENGTH = 1;

type Lang = "js" | "py";

function langFor(path: string): Lang | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "js";
  if (ext === "py") return "py";
  return null;
}

/** Gather sibling source files so imports/requires resolve like they do on disk. */
function siblings(ctx: KernelContext, path: string, lang: Lang): Record<string, string> {
  const dir = dirname(path);
  const out: Record<string, string> = {};
  let entries;
  try {
    entries = ctx.fs.ls(dir);
  } catch {
    return out;
  }
  const want = lang === "py" ? [".py"] : [".js", ".mjs", ".cjs", ".json"];
  for (const e of entries) {
    if (e.kind !== "file") continue;
    if (!want.some((w) => e.name.toLowerCase().endsWith(w))) continue;
    try {
      out[lang === "py" ? e.name : e.path] = ctx.fs.read(e.path);
    } catch {
      /* binary or unembedded — skip it */
    }
  }
  return out;
}

export const runner: VoidModule = {
  manifest: {
    id: "runner",
    name: "Run",
    kind: "app",
    glyph: "▶",
    version: "0.1.0",
  },

  handles: ["py", "js", "mjs", "cjs"],

  activate() {},

  launch(ctx: KernelContext, args?: LaunchArgs) {
    const path = args?.path;

    ctx.openSurface({
      title: path ? `run ${basename(path)}` : "run",
      width: 620,
      height: 420,
      render: (root) => {
        root.innerHTML = "";
        root.className = "run-root";

        const head = document.createElement("div");
        head.className = "run-head";
        const title = document.createElement("span");
        title.className = "run-title";
        title.textContent = path ?? "no program";
        const status = document.createElement("span");
        status.className = "run-status";
        const stopBtn = document.createElement("button");
        stopBtn.className = "fm-btn";
        stopBtn.textContent = "stop";
        stopBtn.disabled = true;
        const runBtn = document.createElement("button");
        runBtn.className = "fm-btn";
        runBtn.textContent = "run";
        head.append(title, status, stopBtn, runBtn);

        const log = document.createElement("div");
        log.className = "run-log";

        const inputRow = document.createElement("div");
        inputRow.className = "run-input-row";
        const inputPrompt = document.createElement("span");
        inputPrompt.className = "run-input-prompt";
        inputPrompt.textContent = "›";
        const input = document.createElement("input");
        input.className = "run-input";
        input.placeholder = "stdin — the program is not waiting for input";
        input.disabled = true;
        inputRow.append(inputPrompt, input);

        root.append(head, log, inputRow);

        if (!path) {
          print("muted", "Nothing to run. Open a .py or .js file, or use `run <file>`.");
          return () => root.replaceChildren();
        }

        const lang = langFor(path);
        if (!lang) {
          print("err", `Don't know how to run ${basename(path)}.`);
          return () => root.replaceChildren();
        }

        let worker: Worker | null = null;
        let ctrl: Int32Array | null = null;
        let data: Uint8Array | null = null;
        let awaitingInput = false;

        function print(kind: string, text: string): void {
          const el = document.createElement("div");
          el.className = `run-line ${kind}`;
          el.textContent = text;
          log.appendChild(el);
          log.scrollTop = log.scrollHeight;
        }

        const setRunning = (on: boolean) => {
          runBtn.disabled = on;
          stopBtn.disabled = !on;
          status.textContent = on ? "running" : "";
          if (!on) {
            awaitingInput = false;
            input.disabled = true;
            input.placeholder = "stdin — the program is not waiting for input";
          }
        };

        const stop = () => {
          if (!worker) return;
          // Release a blocked stdin read first, or the worker dies mid-wait.
          if (ctrl) {
            Atomics.store(ctrl, STATE, 2);
            Atomics.notify(ctrl, STATE);
          }
          worker.terminate();
          worker = null;
          print("muted", "— stopped —");
          setRunning(false);
        };

        const start = () => {
          stop();
          log.replaceChildren();

          let code: string;
          try {
            code = ctx.fs.read(path);
          } catch (err) {
            print("err", err instanceof Error ? err.message : String(err));
            return;
          }

          setRunning(true);
          const started = performance.now();

          if (lang === "js") {
            worker = new Worker(new URL("../../runtime/jsWorker.ts", import.meta.url), {
              type: "module",
            });
          } else {
            worker = new Worker(new URL("../../runtime/pyWorker.ts", import.meta.url), {
              type: "module",
            });

            // Blocking stdin needs SharedArrayBuffer, which needs the page to
            // be cross-origin isolated. Degrade with an explanation instead of
            // hanging forever on the first input().
            if (typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated) {
              const sab = new SharedArrayBuffer(HEADER_BYTES + MAX_INPUT_BYTES);
              ctrl = new Int32Array(sab, 0, 2);
              data = new Uint8Array(sab, HEADER_BYTES, MAX_INPUT_BYTES);
              worker.postMessage({ type: "init", sab });
            } else {
              ctrl = null;
              data = null;
              worker.postMessage({ type: "init" });
              print(
                "warn",
                "interactive input() unavailable: page is not cross-origin isolated"
              );
            }
          }

          worker.addEventListener("message", (e: MessageEvent<any>) => {
            const m = e.data;
            if (m.type === "output") {
              print(m.kind, m.text);
            } else if (m.type === "stdin") {
              awaitingInput = true;
              input.disabled = false;
              input.placeholder = "";
              input.focus();
            } else if (m.type === "done") {
              const ms = Math.round(performance.now() - started);
              print("muted", m.failed ? `— failed in ${ms}ms —` : `— finished in ${ms}ms —`);
              worker?.terminate();
              worker = null;
              setRunning(false);
            }
          });

          worker.addEventListener("error", (e) => {
            print("err", e.message || "worker error");
            setRunning(false);
          });

          worker.postMessage({
            type: "run",
            code,
            path,
            [lang === "py" ? "files" : "modules"]: siblings(ctx, path, lang),
          });
        };

        /** Hand a typed line to the blocked worker. */
        const submitInput = (line: string) => {
          if (!awaitingInput || !ctrl || !data) return;
          const bytes = new TextEncoder().encode(line + "\n");
          data.set(bytes.subarray(0, MAX_INPUT_BYTES));
          Atomics.store(ctrl, LENGTH, Math.min(bytes.length, MAX_INPUT_BYTES));
          Atomics.store(ctrl, STATE, 1);
          Atomics.notify(ctrl, STATE);
          awaitingInput = false;
          input.disabled = true;
          input.placeholder = "stdin — the program is not waiting for input";
        };

        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key !== "Enter") return;
          const line = input.value;
          print("echoed", `› ${line}`);
          input.value = "";
          submitInput(line);
        });

        runBtn.addEventListener("click", start);
        stopBtn.addEventListener("click", stop);

        start();

        return () => {
          stop();
          root.replaceChildren();
        };
      },
    });
  },
};
