import type { KernelContext } from "../kernel/types";
import { dirname } from "../kernel/vfs";

/**
 * Running a program, minus any opinion about how it looks.
 *
 * JavaScript executes in a plain worker; Python executes in Pyodide. Both
 * stream output back, and both are killable — a runaway loop takes the worker
 * with it, not the shell.
 *
 * This is deliberately headless so the same machinery can back an embedded run
 * pane in the editor, a standalone window, or anything else later. The caller
 * supplies `print` and the state callbacks; nothing here touches the DOM.
 */

const HEADER_BYTES = 8;
const MAX_INPUT_BYTES = 65536;
const STATE = 0;
const LENGTH = 1;

export type Lang = "js" | "py";

/** Output channel names the workers emit; callers map these onto styling. */
export type OutputKind = "out" | "err" | "warn" | "muted" | "echoed";

export function langFor(path: string): Lang | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "js";
  if (ext === "py") return "py";
  return null;
}

/** True if this path is something `run` knows how to execute. */
export function isRunnable(path: string): boolean {
  return langFor(path) !== null;
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

export interface ProgramHooks {
  /** A line of program output. */
  print(kind: OutputKind, text: string): void;
  /** Running state changed — enable/disable the run and stop affordances. */
  onState?(running: boolean): void;
  /** The program is blocked on stdin and wants a line. */
  onStdin?(waiting: boolean): void;
}

export interface Program {
  /** Read the file fresh and execute it. Restarts if already running. */
  start(source?: string): void;
  stop(): void;
  /** Hand a typed line to a program blocked on input(). */
  send(line: string): void;
  readonly running: boolean;
  readonly awaitingInput: boolean;
  dispose(): void;
}

/**
 * Build a runner for one file. `source` may be passed to `start` so an editor
 * can run the buffer the user is looking at rather than the last saved copy.
 */
export function createProgram(
  ctx: KernelContext,
  path: string,
  hooks: ProgramHooks
): Program {
  const lang = langFor(path);

  let worker: Worker | null = null;
  let ctrl: Int32Array | null = null;
  let data: Uint8Array | null = null;
  let awaiting = false;

  const setAwaiting = (on: boolean) => {
    awaiting = on;
    hooks.onStdin?.(on);
  };

  const setRunning = (on: boolean) => {
    if (!on) setAwaiting(false);
    hooks.onState?.(on);
  };

  const stop = (): void => {
    if (!worker) return;
    // Release a blocked stdin read first, or the worker dies mid-wait.
    if (ctrl) {
      Atomics.store(ctrl, STATE, 2);
      Atomics.notify(ctrl, STATE);
    }
    worker.terminate();
    worker = null;
    hooks.print("muted", "— stopped —");
    setRunning(false);
  };

  const start = (source?: string): void => {
    if (!lang) {
      hooks.print("err", `Don't know how to run ${path}.`);
      return;
    }
    stop();

    let code: string;
    if (typeof source === "string") {
      code = source;
    } else {
      try {
        code = ctx.fs.read(path);
      } catch (err) {
        hooks.print("err", err instanceof Error ? err.message : String(err));
        return;
      }
    }

    setRunning(true);
    const started = performance.now();

    if (lang === "js") {
      worker = new Worker(new URL("./jsWorker.ts", import.meta.url), { type: "module" });
    } else {
      worker = new Worker(new URL("./pyWorker.ts", import.meta.url), { type: "module" });

      // Blocking stdin needs SharedArrayBuffer, which needs the page to be
      // cross-origin isolated. Degrade with an explanation instead of hanging
      // forever on the first input().
      if (typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated) {
        const sab = new SharedArrayBuffer(HEADER_BYTES + MAX_INPUT_BYTES);
        ctrl = new Int32Array(sab, 0, 2);
        data = new Uint8Array(sab, HEADER_BYTES, MAX_INPUT_BYTES);
        worker.postMessage({ type: "init", sab });
      } else {
        ctrl = null;
        data = null;
        worker.postMessage({ type: "init" });
        hooks.print(
          "warn",
          "interactive input() unavailable: page is not cross-origin isolated"
        );
      }
    }

    worker.addEventListener("message", (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "output") {
        hooks.print(m.kind as OutputKind, m.text);
      } else if (m.type === "stdin") {
        setAwaiting(true);
      } else if (m.type === "done") {
        const ms = Math.round(performance.now() - started);
        hooks.print("muted", m.failed ? `— failed in ${ms}ms —` : `— finished in ${ms}ms —`);
        worker?.terminate();
        worker = null;
        setRunning(false);
      }
    });

    worker.addEventListener("error", (e) => {
      hooks.print("err", e.message || "worker error");
      setRunning(false);
    });

    worker.postMessage({
      type: "run",
      code,
      path,
      [lang === "py" ? "files" : "modules"]: siblings(ctx, path, lang),
    });
  };

  const send = (line: string): void => {
    if (!awaiting || !ctrl || !data) return;
    const bytes = new TextEncoder().encode(line + "\n");
    data.set(bytes.subarray(0, MAX_INPUT_BYTES));
    Atomics.store(ctrl, LENGTH, Math.min(bytes.length, MAX_INPUT_BYTES));
    Atomics.store(ctrl, STATE, 1);
    Atomics.notify(ctrl, STATE);
    setAwaiting(false);
  };

  return {
    start,
    stop,
    send,
    get running() {
      return worker !== null;
    },
    get awaitingInput() {
      return awaiting;
    },
    dispose: stop,
  };
}
