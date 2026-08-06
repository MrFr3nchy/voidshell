import { ModuleLoadError } from "./loadModule";
import type { TransformReply, TransformRequest } from "./transformProtocol";

export { needsTransform, TYPES_ARE_NOT_CHECKED } from "./transformProtocol";

/**
 * The main-thread side of the compile worker.
 *
 * Requests are correlated by id because the worker answers out of order — the
 * first call also waits on a 9MB wasm instantiation, so a second file submitted
 * a moment later can finish first. Without ids, two module files reloading at
 * once would each get whichever answer arrived, which is the kind of bug that
 * looks like a flaky compiler.
 */

/** Compiled output, and the map that puts its line numbers back. */
export interface Compiled {
  code: string;
  /** Raw source map JSON — see `createMapping` in `sourcemap.ts`. */
  map: string;
}

export interface TransformClient {
  transform(source: string, path: string): Promise<Compiled>;
  dispose(): void;
}

/**
 * Long enough to download and instantiate the wasm on a slow connection.
 *
 * There has to be a limit, because a worker that fails to start doesn't
 * necessarily fail *loudly* — a blocked fetch can simply never settle, and the
 * editor would sit on "loading" with nothing to report.
 */
const COMPILE_TIMEOUT = 30000;

/**
 * Wrap a worker in a promise-per-request.
 *
 * Takes a spawn function rather than constructing the worker itself, so the
 * correlation and failure handling below can be tested against a stub. That is
 * the half of this file most likely to be wrong and the half a browser is least
 * convenient for.
 */
export function createTransformClient(spawn: () => Worker): TransformClient {
  interface Pending {
    resolve(value: Compiled): void;
    reject(err: unknown): void;
    timer: ReturnType<typeof setTimeout>;
  }

  const pending = new Map<number, Pending>();
  let worker: Worker | null = null;
  let nextId = 0;

  const settle = (id: number): Pending | undefined => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    pending.delete(id);
    return entry;
  };

  /**
   * Fail everything outstanding.
   *
   * A worker that dies takes every in-flight request with it, and each one has
   * a caller waiting. Rejecting only the newest would leave the others hanging
   * until their own timeouts for a reason already known.
   */
  const failAll = (message: string) => {
    for (const id of [...pending.keys()]) settle(id)?.reject(new ModuleLoadError(message));
    worker?.terminate();
    worker = null;
  };

  const ensure = (): Worker => {
    if (worker) return worker;
    const spawned = spawn();
    spawned.addEventListener("message", (e: MessageEvent<TransformReply>) => {
      const reply = e.data;
      if (!reply || typeof reply.id !== "number") return;
      const entry = settle(reply.id);
      if (!entry) return;
      if (reply.type === "ok") entry.resolve({ code: reply.code, map: reply.map });
      else entry.reject(new ModuleLoadError(reply.message, locationOf(reply)));
    });
    // An `error` here is the worker itself failing — most often the wasm not
    // loading — rather than a file failing to compile.
    spawned.addEventListener("error", (e) => {
      failAll(`the TypeScript compiler could not start: ${e.message || "worker error"}`);
    });
    worker = spawned;
    return spawned;
  };

  return {
    transform(source, path) {
      const id = ++nextId;
      const target = ensure();
      return new Promise<Compiled>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(id)?.reject(
            new ModuleLoadError("the TypeScript compiler did not answer in time")
          );
        }, COMPILE_TIMEOUT);
        pending.set(id, { resolve, reject, timer });
        target.postMessage({ type: "transform", id, source, path } satisfies TransformRequest);
      });
    },
    dispose() {
      failAll("the TypeScript compiler was shut down");
    },
  };
}

function locationOf(reply: { line?: number; column?: number }) {
  return reply.line ? { line: reply.line, column: reply.column ?? 1 } : null;
}

/**
 * The shell's compiler, started on first use and kept afterwards.
 *
 * Deliberately not started at boot: instantiating the wasm costs real time and
 * memory, and a session that never opens a `.ts` module should never pay it.
 */
let shared: TransformClient | null = null;

export function transformModule(source: string, path: string): Promise<Compiled> {
  shared ??= createTransformClient(
    () => new Worker(new URL("./tsWorker.ts", import.meta.url), { type: "module" })
  );
  return shared.transform(source, path);
}
