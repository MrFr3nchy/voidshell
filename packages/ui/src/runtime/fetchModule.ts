/**
 * Getting a module from somewhere else.
 *
 * The runtime loader has been able to run a module the user wrote since PR #44,
 * and the only way to get somebody else's was to copy it into the editor by
 * hand. That is tedious, and — this is the part worth noticing — it is *also*
 * the entire review step. You read a module while you paste it.
 *
 * So this fetches, and deliberately stops there. The source lands as a file in
 * `~/modules` and opens in the editor; nothing is evaluated, nothing is
 * installed, and the Reload button that has always been the way to load a
 * module is still the way to load this one. The tedium goes, the review stays.
 *
 * ## What this is not
 *
 * It is not a package manager and there is no registry behind it. There is no
 * signature, no integrity hash, no version resolution, and nothing here can
 * tell a useful module from a hostile one. A module is ordinary JavaScript on
 * the page: the capability fence in `kernel/caps.ts` covers the *kernel* — the
 * filesystem, the window table, the settings registry — and explicitly does
 * not cover `fetch`, `document`, or anything else the browser hands a script.
 *
 * What the fence can honestly do is stop treating a stranger's code the way it
 * treats yours. A runtime module that declares no permissions is trusted today,
 * which is a defensible default for a file you wrote and an indefensible one
 * for a file you downloaded — so a module with a recorded origin is fenced to
 * `SAFE_DEFAULT` whatever the global strict setting says. See `Kernel.grantsFor`.
 */

/** Refused before anything is fetched, with a sentence a person can act on. */
export class FetchModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchModuleError";
  }
}

/**
 * Bigger than any hand-written module and smaller than anything that should be
 * arriving as a single file. A bundle is not a module here — a module imports
 * nothing — so anything past this is the wrong shape rather than merely large.
 */
export const MAX_MODULE_BYTES = 512 * 1024;

/** Extensions the loader knows how to evaluate. */
const LOADABLE = [".js", ".mjs", ".ts", ".mts"];

export interface ModuleTarget {
  url: string;
  /** Where it will land under `~/modules`, extension included. */
  filename: string;
  /** Shown to the user before anything is fetched. */
  host: string;
}

/**
 * Turn what somebody pasted into a URL and a filename, or refuse it.
 *
 * Refusals are ordered by how likely the mistake is, and every one names what
 * was wrong rather than saying "invalid URL" — the person is holding a link
 * they believe in and needs to know which part of it this disagrees with.
 */
export function parseModuleUrl(raw: string): ModuleTarget {
  const text = raw.trim();
  if (!text) throw new FetchModuleError("No URL.");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // The overwhelmingly common version of this is a bare host with no scheme.
    throw new FetchModuleError(
      text.includes("://")
        ? `That isn't a URL this can read: ${text}`
        : `That has no scheme — try https://${text}`
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FetchModuleError(
      `Only http and https are fetched, not ${url.protocol.replace(":", "")}. ` +
        `A local file is already reachable — put it in ~/modules yourself.`
    );
  }

  // GitHub's blob view is an HTML page, and fetching it gets you a page of
  // markup that fails to parse as a module several steps later, with an error
  // about an unexpected `<`. Rewriting it is worth more than explaining it.
  if (url.hostname === "github.com" && url.pathname.includes("/blob/")) {
    url = new URL(
      url.href.replace("://github.com/", "://raw.githubusercontent.com/").replace("/blob/", "/")
    );
  }

  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const ext = LOADABLE.find((e) => last.toLowerCase().endsWith(e));
  if (!ext) {
    throw new FetchModuleError(
      `That URL doesn't end in a file the loader can evaluate ` +
        `(${LOADABLE.join(", ")}). A module is one file that imports nothing.`
    );
  }

  return { url: url.href, host: url.hostname, filename: safeName(last) };
}

/**
 * A filename that cannot escape `~/modules` or collide with the shell's own
 * ideas about paths. Everything outside a conservative set becomes a dash.
 */
export function safeName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]/g, "-")
    // A leading dot would make it hidden, and `..` is the only sequence here
    // that could mean anything other than a name.
    .replace(/^\.+/, "")
    .replace(/\.{2,}/g, ".");
  return cleaned || "module.js";
}

/**
 * A banner written into the top of the fetched file.
 *
 * The kernel records the origin in state, which is what the fence actually
 * consults; this is for the person who opens the file in six months. Two
 * different audiences, so two records rather than one that serves neither.
 */
export function originBanner(url: string, when = new Date()): string {
  return [
    "// fetched by voidshell — review this before loading it.",
    `// from ${url}`,
    `// on   ${when.toISOString()}`,
    "//",
    "// Nothing has run yet. Loading this evaluates it on the page, where the",
    "// capability fence covers the kernel and not the browser.",
    "",
    "",
  ].join("\n");
}

/**
 * Fetch the source, or throw a `FetchModuleError` explaining what happened.
 *
 * Nothing is evaluated here. This is a network read and a string.
 */
export async function fetchModuleSource(
  target: ModuleTarget,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(target.url, { credentials: "omit", redirect: "follow" });
  } catch (err) {
    // Overwhelmingly this is CORS rather than the host being down, and the two
    // look identical from here — so name both rather than guess.
    throw new FetchModuleError(
      `Couldn't reach ${target.host}. Either it is down, or it does not allow ` +
        `cross-origin reads — raw.githubusercontent.com and most gist and CDN ` +
        `hosts do. (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (!res.ok) {
    throw new FetchModuleError(
      res.status === 404
        ? `${target.host} has nothing at that path (404).`
        : `${target.host} answered ${res.status} ${res.statusText}.`
    );
  }

  const source = await res.text();
  if (source.length > MAX_MODULE_BYTES) {
    throw new FetchModuleError(
      `That file is ${Math.round(source.length / 1024)}KB, over the ${
        MAX_MODULE_BYTES / 1024
      }KB limit. A module is one file that imports nothing; a bundle is not a module.`
    );
  }
  if (!source.trim()) throw new FetchModuleError(`${target.host} returned an empty file.`);

  // A cheap, honest check that catches the single most common wrong URL: a
  // documentation page instead of a source file. Deliberately not a parser —
  // it only has to be right about the obvious case.
  if (/^\s*<(!doctype|html)\b/i.test(source)) {
    throw new FetchModuleError(
      `That URL returned an HTML page, not source. If it is a GitHub or GitLab ` +
        `file view, use the "raw" link.`
    );
  }

  return source;
}
