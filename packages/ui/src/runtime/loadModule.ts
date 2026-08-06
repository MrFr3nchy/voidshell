import type { ModuleManifest, VoidModule } from "../kernel/types";

/**
 * Turn module source into a live module, without rebuilding the shell.
 *
 * The whole trick is something the module contract already got right:
 * `activate(ctx)` takes the kernel as an *argument*. A module therefore
 * imports nothing from the shell, which means it can be evaluated as an
 * ordinary standalone ES module — no import map, no externals, no shared
 * runtime to thread through. The kernel arrives as a function parameter the
 * way it always has.
 *
 * What this deliberately does NOT do is compile anything. Source in, module
 * out, and the source has to already be JavaScript. Putting a TypeScript
 * compiler in the browser is a real feature with real weight; keeping it out
 * of here means the loading path can be proven on its own first.
 */

const KINDS: ModuleManifest["kind"][] = ["app", "world", "service"];

/** Where in the author's own source something went wrong. 1-based, like a gutter. */
export interface SourceLocation {
  line: number;
  column: number;
}

/**
 * A load that failed, with the author's line attached when that is knowable.
 *
 * Knowable is doing real work in that sentence — see `locateError`. The
 * location is absent far more often than you would hope, and callers must
 * render the message perfectly well without one.
 */
export class ModuleLoadError extends Error {
  readonly line?: number;
  readonly column?: number;

  constructor(message: string, at?: SourceLocation | null) {
    super(message);
    this.name = "ModuleLoadError";
    if (at) {
      this.line = at.line;
      this.column = at.column;
    }
  }
}

/** The `:line:column` tail of a stack frame, with V8's optional closing paren. */
const FRAME_TAIL = /:(\d+):(\d+)\)?\s*$/;

/**
 * Find where in the author's source an error came from, or admit that we can't.
 *
 * Two facts make this less obvious than it looks.
 *
 * The first is that **a parse error has no stack of its own**, because nothing
 * ever ran. Firefox and Safari hang `lineNumber` on the error object, which is
 * the only reason a syntax error is ever locatable at all. V8 does not, so in
 * Chrome and in Node a module that doesn't parse simply has no location to
 * report, and saying so is the honest outcome.
 *
 * The second is the trap that makes the first one dangerous. Node *does* give
 * a syntax error a stack — one made entirely of its own loader internals:
 *
 *     at compileSourceTextModule (node:internal/modules/esm/utils:318:16)
 *
 * Read the topmost frame and you will confidently report "line 318", underline
 * it in the gutter, and send the author to inspect a file they did not write.
 * A wrong location is materially worse than no location, so a frame only
 * counts if it names *our* module URL. Everything else is discarded.
 *
 * `lines` is the source's line count: it rejects a location past the end of
 * the file, including the uniquifying comment the loader appends.
 */
export function locateError(err: unknown, url: string, lines: number): SourceLocation | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { lineNumber?: unknown; columnNumber?: unknown; stack?: unknown };

  const at = (line: unknown, column: unknown): SourceLocation | null => {
    const l = Number(line);
    if (!Number.isInteger(l) || l < 1 || l > lines) return null;
    const c = Number(column);
    return { line: l, column: Number.isInteger(c) && c >= 1 ? c : 1 };
  };

  // SpiderMonkey and JavaScriptCore, and the only path that locates a parse error.
  const own = at(e.lineNumber, e.columnNumber);
  if (own) return own;

  if (typeof e.stack !== "string") return null;
  for (const frame of e.stack.split("\n")) {
    if (!frame.includes(url)) continue;
    const m = FRAME_TAIL.exec(frame);
    const found = m && at(m[1], m[2]);
    if (found) return found;
  }
  return null;
}

/** Base64 of a UTF-8 string, assuming neither Node's Buffer nor the DOM. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Whether this runtime can `import()` a blob: URL.
 *
 * Not a question that can be answered by feature detection. Node defines both
 * `Blob` and `URL.createObjectURL`, and its ESM loader then refuses the
 * resulting URL outright — so "the API exists" and "the import works" are
 * different facts, and only one of them matters. Probed once with a trivial
 * module and remembered, because the alternative is retrying every real load
 * and evaluating an author's side effects twice on the way to finding out.
 */
let blobsImportable: boolean | null = null;

/** Bumped per load so no two loads share a URL, and so no load is cached. */
let loads = 0;

async function canImportBlobs(): Promise<boolean> {
  if (blobsImportable !== null) return blobsImportable;
  if (
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return (blobsImportable = false);
  }
  const url = URL.createObjectURL(new Blob(["export default 0"], { type: "text/javascript" }));
  try {
    await import(/* @vite-ignore */ /* webpackIgnore: true */ url);
    blobsImportable = true;
  } catch {
    blobsImportable = false;
  } finally {
    URL.revokeObjectURL(url);
  }
  return blobsImportable;
}

/**
 * A URL an ES module can be imported from, and a way to let it go.
 *
 * Blob URLs are preferred in the browser because they are same-origin: a
 * `script-src` strict enough to reject a `data:` import still accepts them.
 * The data: fallback is what lets this path run under Node at all, which is
 * where the smoke harness lives — so the loader is covered headlessly rather
 * than only by hand in a tab.
 */
async function sourceUrl(source: string): Promise<{ url: string; release: () => void }> {
  // Reloading has to actually re-evaluate. A data: URL is derived from the
  // source, so re-loading an unchanged file hits the module cache and hands
  // back the *same* instance, module-level state and all — while the blob path
  // mints a fresh URL every time and doesn't. Same button, two behaviours,
  // depending on which runtime you happened to be in. Make every load unique.
  const unique = `${source}\n// voidshell:load-${Date.now()}-${++loads}\n`;
  if (await canImportBlobs()) {
    const url = URL.createObjectURL(new Blob([unique], { type: "text/javascript" }));
    return { url, release: () => URL.revokeObjectURL(url) };
  }
  return { url: `data:text/javascript;base64,${toBase64(unique)}`, release: () => {} };
}

/**
 * Check that something claiming to be a module actually is one.
 *
 * Every failure here is a sentence the author can act on. The alternative is
 * letting a typo reach `register()` and surface later as a module that is
 * present in the launcher and does nothing when clicked, which is a much
 * worse place to learn that `activate` was spelled `activeate`.
 *
 * Exported separately from the loading path so the rules can be tested
 * without a module URL in sight.
 */
export function asVoidModule(candidate: unknown): VoidModule {
  const source =
    candidate && typeof candidate === "object" && "default" in candidate
      ? (candidate as { default: unknown }).default
      : candidate;

  if (!source || typeof source !== "object") {
    throw new ModuleLoadError("module exported nothing — expected `export default { manifest, activate }`");
  }

  const mod = source as Partial<VoidModule>;
  const manifest = mod.manifest as Partial<ModuleManifest> | undefined;

  if (!manifest || typeof manifest !== "object") {
    throw new ModuleLoadError("module has no manifest");
  }
  if (typeof manifest.id !== "string" || !manifest.id.trim()) {
    throw new ModuleLoadError("manifest.id must be a non-empty string");
  }
  const at = manifest.id;
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new ModuleLoadError(`${at}: manifest.name must be a non-empty string`);
  }
  if (!KINDS.includes(manifest.kind as ModuleManifest["kind"])) {
    throw new ModuleLoadError(`${at}: manifest.kind must be one of ${KINDS.join(", ")}`);
  }
  if (typeof mod.activate !== "function") {
    throw new ModuleLoadError(`${at}: activate(ctx) is required`);
  }
  if (mod.launch !== undefined && typeof mod.launch !== "function") {
    throw new ModuleLoadError(`${at}: launch must be a function`);
  }
  // An app with no launch() registers cleanly, appears in the launcher, and
  // then does nothing at all when it is clicked. Refuse it here instead.
  if (manifest.kind === "app" && typeof mod.launch !== "function") {
    throw new ModuleLoadError(`${at}: an "app" module needs a launch(ctx) — nothing would open it`);
  }

  return mod as VoidModule;
}

/**
 * Evaluate module source and hand back the module it exports.
 *
 * Throws with the author's own syntax error if the source doesn't parse, and
 * with a description of what's missing if it parses into something that isn't
 * a module. Always a `ModuleLoadError`, carrying `line`/`column` when the
 * runtime gave us enough to place the blame — see `locateError`.
 */
export async function loadModuleSource(source: string): Promise<VoidModule> {
  const { url, release } = await sourceUrl(source);
  const lines = source.split("\n").length;
  try {
    // The specifier is a runtime value on purpose — bundlers must leave it
    // alone rather than try to resolve it at build time.
    const namespace: unknown = await import(/* @vite-ignore */ /* webpackIgnore: true */ url);
    return asVoidModule(namespace);
  } catch (err) {
    // `asVoidModule` already phrased its own complaints for the author, and
    // none of them happened anywhere in particular. Anything else came out of
    // the source itself and is worth trying to place.
    if (err instanceof ModuleLoadError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ModuleLoadError(message, locateError(err, url, lines));
  } finally {
    // Safe the moment the import settles: the module has been evaluated and
    // is held by the module map, so the URL has nothing left to point at.
    release();
  }
}
