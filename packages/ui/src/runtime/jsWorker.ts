/// <reference lib="webworker" />
export {}; // module scope, so this file's helpers stay off the global namespace

/**
 * JavaScript sandbox.
 *
 * Runs a script off the main thread so a runaway loop wedges the worker rather
 * than the whole shell — the Runner can terminate it. `console` is redirected
 * to the host panel, and a tiny `vsh` object exposes the parts of the shell a
 * script has any business touching.
 */

interface RunMessage {
  type: "run";
  code: string;
  path: string;
  /** Files the script may import, keyed by absolute VFS path. */
  modules?: Record<string, string>;
}

const post = (kind: string, text: string) =>
  (self as unknown as Worker).postMessage({ type: "output", kind, text });

const format = (args: unknown[]): string =>
  args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a, null, 2);
      } catch {
        return String(a);
      }
    })
    .join(" ");

self.console = {
  ...self.console,
  log: (...a: unknown[]) => post("out", format(a)),
  info: (...a: unknown[]) => post("out", format(a)),
  warn: (...a: unknown[]) => post("warn", format(a)),
  error: (...a: unknown[]) => post("err", format(a)),
  debug: (...a: unknown[]) => post("muted", format(a)),
} as Console;

self.addEventListener("message", async (e: MessageEvent<RunMessage>) => {
  if (e.data.type !== "run") return;
  const { code, path, modules = {} } = e.data;

  try {
    // Resolve `require("./x.js")` against the VFS snapshot handed to us, so a
    // multi-file script runs without the worker reaching back to the main
    // thread mid-execution.
    const cache: Record<string, unknown> = {};
    const dir = path.slice(0, path.lastIndexOf("/"));

    const req = (spec: string): unknown => {
      const resolved = spec.startsWith(".")
        ? normalizeJoin(dir, spec)
        : spec;
      const candidates = [resolved, `${resolved}.js`, `${resolved}/index.js`];
      const hit = candidates.find((c) => modules[c] !== undefined);
      if (!hit) throw new Error(`Cannot find module '${spec}'`);
      if (cache[hit]) return cache[hit];
      const mod = { exports: {} as unknown };
      cache[hit] = mod.exports;
      const fn = new Function("module", "exports", "require", "vsh", modules[hit]);
      fn(mod, mod.exports, req, vsh);
      cache[hit] = mod.exports;
      return mod.exports;
    };

    const vsh = {
      print: (...a: unknown[]) => post("out", format(a)),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 30000))),
      path,
    };

    const module = { exports: {} as unknown };
    const fn = new Function(
      "module",
      "exports",
      "require",
      "vsh",
      `return (async () => {\n${code}\n})()`
    );
    await fn(module, module.exports, req, vsh);
    (self as unknown as Worker).postMessage({ type: "done" });
  } catch (err) {
    post("err", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    (self as unknown as Worker).postMessage({ type: "done", failed: true });
  }
});

/** Minimal path join for relative requires, mirroring the VFS's normalize. */
function normalizeJoin(base: string, rel: string): string {
  const out = base.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}
