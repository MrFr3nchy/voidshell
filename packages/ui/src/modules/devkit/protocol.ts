/**
 * The conversation between the editor and devkit.
 *
 * Reloading a module means installing one, and `install` is deliberately not on
 * `KernelContext` — devkit receives it from `main.ts` because "can replace any
 * running module" is not a capability every app should hold. So the editor does
 * not reload anything. It *asks*, over the bus, and devkit — which owns both the
 * capability and the path→id map — answers.
 *
 * That is the ordinary rule ("modules never talk to each other directly") doing
 * exactly what it is for. The constants live in their own file rather than in
 * `index.ts` so the editor can import the protocol without importing devkit.
 */

import type { KernelContext } from "../../kernel/types";

/** Where hand-written modules live. */
export const MODULE_DIR = "/home/void/modules";

/**
 * How long to wait for devkit before giving up.
 *
 * There has to be a limit, because the request goes out on the bus and nothing
 * guarantees anybody is listening — devkit can be uninstalled, or the request
 * can arrive before it has activated. Silence would otherwise leave a caller
 * waiting forever, which reads as a hang in the loader rather than as an
 * answer that never came.
 */
export const RELOAD_TIMEOUT = 5000;

/** Editor → devkit: save is done, please re-install this path. */
export const RELOAD_REQUEST = "devkit.reload.request";
/** devkit → editor: how that went. Correlated by `nonce`. */
export const RELOAD_RESULT = "devkit.reload.result";
/** Raised whenever the installed set changes, so open windows redraw. */
export const CHANGED = "devkit.changed";

export interface ReloadRequest {
  path: string;
  /**
   * Ties an answer to its question. Two editor windows on two module files can
   * be mid-reload at once, and each must ignore the other's result rather than
   * report it against the wrong file.
   */
  nonce: string;
}

/**
 * Where the most recent load failure is parked.
 *
 * `tmp.` on purpose: it describes this session and nothing else, and a failure
 * restored from the server next boot would be describing a problem that may no
 * longer exist. Read by the assistant's `last_build_error` tool.
 */
export const LAST_ERROR_KEY = "tmp.devkit.lastError";

export interface BuildFailure {
  path: string;
  message: string;
  line?: number;
  column?: number;
  /** Epoch millis, so a caller can say how long ago it happened. */
  at: number;
}

export interface ReloadResult {
  nonce: string;
  ok: boolean;
  /** The module id that is now live. Present when `ok`. */
  id?: string;
  /** Present when not `ok`. Already phrased for a human. */
  error?: string;
  /** 1-based, and frequently absent — see `locateError` in the loader. */
  line?: number;
  column?: number;
}

/**
 * Everything the loader can take. `.ts` and `.mts` go through esbuild first —
 * see `needsTransform` in `runtime/transformProtocol.ts`, which owns the
 * narrower question of which of these have to be compiled.
 */
const EXTENSIONS = [".js", ".mjs", ".ts", ".mts"];

/** Does this filename look like something the loader could take? */
export const isModuleFile = (name: string): boolean =>
  EXTENSIONS.some((ext) => name.endsWith(ext));

/**
 * Is this path a module the editor should offer to reload?
 *
 * Deliberately narrower than `isModuleFile`: a `.js` file anywhere else is just
 * a script, and offering to install it as a module would be offering to run it.
 */
export const isModulePath = (path: string): boolean =>
  path.startsWith(`${MODULE_DIR}/`) && isModuleFile(path);

/**
 * Ask devkit to install a path, and wait for the answer.
 *
 * The nonce bookkeeping lives here rather than in each caller because there is
 * more than one caller now — the editor's Reload button and the assistant's
 * `load_module` tool — and two hand-rolled copies of a correlation protocol is
 * two chances to correlate it wrong.
 *
 * Always resolves, never rejects: a timeout comes back as an ordinary failed
 * result, because "devkit didn't answer" is something the caller has to render
 * next to "your module has a syntax error" either way.
 */
export function requestReload(
  ctx: Pick<KernelContext, "emit" | "on">,
  path: string,
  timeoutMs = RELOAD_TIMEOUT
): Promise<ReloadResult> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<ReloadResult>((resolve) => {
    let done = false;
    const finish = (result: ReloadResult) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(result);
    };

    const off = ctx.on(RELOAD_RESULT, (e) => {
      const res = e.payload as Partial<ReloadResult> | undefined;
      if (!res || res.nonce !== nonce) return;
      finish({ ...res, nonce, ok: res.ok === true });
    });

    const timer = setTimeout(
      () => finish({ nonce, ok: false, error: "devkit did not answer — is it still installed?" }),
      timeoutMs
    );

    ctx.emit(RELOAD_REQUEST, { path, nonce } satisfies ReloadRequest);
  });
}
