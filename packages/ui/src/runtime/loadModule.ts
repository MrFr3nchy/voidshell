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
    throw new Error("module exported nothing — expected `export default { manifest, activate }`");
  }

  const mod = source as Partial<VoidModule>;
  const manifest = mod.manifest as Partial<ModuleManifest> | undefined;

  if (!manifest || typeof manifest !== "object") {
    throw new Error("module has no manifest");
  }
  if (typeof manifest.id !== "string" || !manifest.id.trim()) {
    throw new Error("manifest.id must be a non-empty string");
  }
  const at = manifest.id;
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error(`${at}: manifest.name must be a non-empty string`);
  }
  if (!KINDS.includes(manifest.kind as ModuleManifest["kind"])) {
    throw new Error(`${at}: manifest.kind must be one of ${KINDS.join(", ")}`);
  }
  if (typeof mod.activate !== "function") {
    throw new Error(`${at}: activate(ctx) is required`);
  }
  if (mod.launch !== undefined && typeof mod.launch !== "function") {
    throw new Error(`${at}: launch must be a function`);
  }
  // An app with no launch() registers cleanly, appears in the launcher, and
  // then does nothing at all when it is clicked. Refuse it here instead.
  if (manifest.kind === "app" && typeof mod.launch !== "function") {
    throw new Error(`${at}: an "app" module needs a launch(ctx) — nothing would open it`);
  }

  return mod as VoidModule;
}

/**
 * Evaluate module source and hand back the module it exports.
 *
 * Throws with the author's own syntax error if the source doesn't parse, and
 * with a description of what's missing if it parses into something that isn't
 * a module.
 */
export async function loadModuleSource(source: string): Promise<VoidModule> {
  const { url, release } = await sourceUrl(source);
  try {
    // The specifier is a runtime value on purpose — bundlers must leave it
    // alone rather than try to resolve it at build time.
    const namespace: unknown = await import(/* @vite-ignore */ /* webpackIgnore: true */ url);
    return asVoidModule(namespace);
  } finally {
    // Safe the moment the import settles: the module has been evaluated and
    // is held by the module map, so the URL has nothing left to point at.
    release();
  }
}
