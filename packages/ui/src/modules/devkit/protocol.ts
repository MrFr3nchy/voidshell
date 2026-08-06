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

/** Where hand-written modules live. */
export const MODULE_DIR = "/home/void/modules";

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

const EXTENSIONS = [".js", ".mjs"];

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
