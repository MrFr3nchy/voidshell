/// <reference lib="webworker" />
export {}; // module scope, so this file's helpers stay off the global namespace

/**
 * CPython, via Pyodide.
 *
 * The interesting part is `input()`. Python's stdin is synchronous, but the
 * line the user types only exists on the main thread — so the worker blocks on
 * `Atomics.wait` against a SharedArrayBuffer while the host collects the line
 * and writes it back. That is the only way to make a genuinely interactive
 * terminal program work unmodified in a browser.
 *
 * SharedArrayBuffer requires the page to be cross-origin isolated (COOP+COEP,
 * set in vite.config.ts). Without it, `input()` reports why rather than hanging.
 */

const PYODIDE_VERSION = "0.28.3";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.mjs`;

/** Control block layout: [0] = state flag, [1] = byte length of the payload. */
const STATE = 0;
const LENGTH = 1;
const HEADER_BYTES = 8;
const MAX_INPUT_BYTES = 65536;

interface InitMessage {
  type: "init";
  sab?: SharedArrayBuffer;
}
interface RunMessage {
  type: "run";
  code: string;
  path: string;
  /** Sibling files written into Pyodide's FS so imports resolve. */
  files?: Record<string, string>;
}

let pyodide: any = null;
let ctrl: Int32Array | null = null;
let data: Uint8Array | null = null;

const post = (kind: string, text: string) =>
  (self as unknown as Worker).postMessage({ type: "output", kind, text });

/**
 * Line-buffered UTF-8 output.
 *
 * Pyodide's batched stdout only emits on newline, which swallows prompts —
 * `input("your name: ")` writes no newline, so the question would never reach
 * the screen. We buffer bytes ourselves and flush the partial line explicitly
 * whenever the program blocks for input.
 */
function makeSink(kind: string) {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  return {
    write(bytes: Uint8Array): number {
      buf += decoder.decode(bytes, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        post(kind, buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      return bytes.length;
    },
    /** Emit whatever is sitting in the buffer without a trailing newline. */
    flush(): void {
      if (buf) {
        post(kind, buf);
        buf = "";
      }
    },
  };
}

const stdout = makeSink("out");
const stderr = makeSink("err");

/**
 * Block this worker until the host supplies a line. Returns null at EOF so
 * Python raises EOFError rather than spinning.
 */
function blockingStdin(): string | null {
  if (!ctrl || !data) {
    throw new Error(
      "input() needs SharedArrayBuffer, which needs cross-origin isolation. " +
        "Serve voidshell with COOP/COEP headers (see vite.config.ts)."
    );
  }
  // Push the pending prompt out before parking, or the user is asked to type
  // with nothing on screen telling them what for.
  stdout.flush();
  stderr.flush();

  // Arm the flag BEFORE announcing we want input. If the host answered while
  // we were still between postMessage and this store, we would clobber its
  // reply with 0 and then wait forever for a notify that already happened.
  Atomics.store(ctrl, STATE, 0);
  (self as unknown as Worker).postMessage({ type: "stdin" });
  Atomics.wait(ctrl, STATE, 0);

  const state = Atomics.load(ctrl, STATE);
  if (state === 2) return null; // host signalled EOF / stop

  const len = Atomics.load(ctrl, LENGTH);
  const bytes = data.slice(0, len);
  return new TextDecoder().decode(bytes);
}

async function ensurePyodide(): Promise<any> {
  if (pyodide) return pyodide;
  post("muted", "loading python runtime…");
  const { loadPyodide } = await import(/* @vite-ignore */ PYODIDE_URL);
  pyodide = await loadPyodide({
    indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
  });
  // isatty makes CPython treat these as a terminal, which switches stdout from
  // block buffering to line buffering. Without it a program's output sits in
  // Python's own buffer until it fills — so a game prints nothing between
  // prompts and looks hung.
  pyodide.setStdout({ ...stdout, isatty: true });
  pyodide.setStderr({ ...stderr, isatty: true });
  // autoEOF inserts an EOF after each callback return, which is what makes a
  // single call satisfy one `input()`. With it off, Python's buffered reader
  // keeps asking for more to fill its buffer and the same input() never
  // returns — it looks like a second prompt but the first one is still looping.
  pyodide.setStdin({ stdin: blockingStdin, autoEOF: true, isatty: true });

  // Belt and braces: force line buffering even if isatty is ignored.
  pyodide.runPython(
    "import sys\n" +
      "sys.stdout.reconfigure(line_buffering=True)\n" +
      "sys.stderr.reconfigure(line_buffering=True)\n"
  );
  post("muted", `python ${pyodide.version} ready`);
  return pyodide;
}

self.addEventListener("message", async (e: MessageEvent<InitMessage | RunMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    if (msg.sab) {
      ctrl = new Int32Array(msg.sab, 0, 2);
      data = new Uint8Array(msg.sab, HEADER_BYTES, MAX_INPUT_BYTES);
    }
    return;
  }

  if (msg.type !== "run") return;

  try {
    const py = await ensurePyodide();

    // Materialise the project's files so `import example_cards` resolves the
    // same way it would on disk.
    const dir = "/vsh";
    try {
      py.FS.mkdir(dir);
    } catch {
      /* already exists from a previous run */
    }
    for (const [name, text] of Object.entries(msg.files ?? {})) {
      py.FS.writeFile(`${dir}/${name}`, text);
    }
    py.runPython(`import sys\nif ${JSON.stringify(dir)} not in sys.path: sys.path.insert(0, ${JSON.stringify(dir)})`);

    await py.runPythonAsync(msg.code);
    stdout.flush();
    stderr.flush();
    (self as unknown as Worker).postMessage({ type: "done" });
  } catch (err) {
    stdout.flush();
    stderr.flush();
    const text = err instanceof Error ? err.message : String(err);
    post("err", text);
    (self as unknown as Worker).postMessage({ type: "done", failed: true });
  }
});
