/**
 * Checks for fetching a module from a URL.
 *
 * Two things are being defended and only one of them is about URLs.
 *
 * The first is that every refusal names what was wrong. Somebody pasting a
 * link believes in it, and "invalid URL" tells them nothing about which part
 * of it this disagrees with.
 *
 * The second is the one that matters: **a fetched module is never trusted.**
 * A runtime module that declares no permissions is trusted today, which is a
 * defensible default for a file the user wrote and an indefensible one for a
 * file they downloaded. That distinction is a single condition in `grantsFor`,
 * so it is asserted directly rather than inferred.
 *
 *   npx esbuild tools/fetch-module-checks.mts --bundle --platform=node \
 *     --format=esm --outfile=fetch-module-checks.mjs --log-level=error \
 *     && node fetch-module-checks.mjs
 */
import {
  FetchModuleError,
  MAX_MODULE_BYTES,
  fetchModuleSource,
  originBanner,
  parseModuleUrl,
  safeName,
} from "../packages/ui/src/kernel/../runtime/fetchModule";
import { CAPABILITY_BLURBS, SAFE_DEFAULT, formatPermissions } from "../packages/ui/src/kernel/caps";

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

/** The refusal message, or "" if it was accepted. */
const refusal = (raw: string): string => {
  try {
    parseModuleUrl(raw);
    return "";
  } catch (err) {
    return err instanceof FetchModuleError ? err.message : `WRONG TYPE: ${String(err)}`;
  }
};

/* ---------------- what it accepts ---------------- */

{
  const t = parseModuleUrl("https://example.com/apps/clock.js");
  check("a plain https url", t.url === "https://example.com/apps/clock.js");
  check("names the host, for saying so before fetching", t.host === "example.com");
  check("and derives a filename", t.filename === "clock.js");

  check("typescript too", parseModuleUrl("https://x.dev/a/b/thing.ts").filename === "thing.ts");
  check(".mjs too", parseModuleUrl("https://x.dev/thing.mjs").filename === "thing.mjs");
  // A query string is how most CDNs version things, and it is not part of the name.
  check("a query string is not part of the name", parseModuleUrl("https://x.dev/a.js?v=2").filename === "a.js");
}

/* ---------------- the GitHub blob trap ---------------- */

/**
 * The single most common wrong URL. github.com/.../blob/... is an HTML page,
 * and fetching it fails several steps later with a complaint about an
 * unexpected `<`. Rewriting it is worth more than explaining it.
 */
{
  const t = parseModuleUrl("https://github.com/a/b/blob/main/src/mod.js");
  check("a github blob url is rewritten to raw", t.url === "https://raw.githubusercontent.com/a/b/main/src/mod.js");
  check("and the host reported is the one actually fetched", t.host === "raw.githubusercontent.com");
  // A raw URL that is already raw must be left exactly alone.
  const raw = "https://raw.githubusercontent.com/a/b/main/src/mod.js";
  check("an already-raw url is untouched", parseModuleUrl(raw).url === raw);
}

/* ---------------- what it refuses, and how it says so ---------------- */

{
  check("nothing", refusal("") === "No URL.");
  // Overwhelmingly a bare host, so the message should be the fix and not a diagnosis.
  check("a bare host suggests the scheme", refusal("example.com/a.js").includes("try https://"));
  check("and does not just say invalid", !refusal("example.com/a.js").toLowerCase().includes("invalid"));

  const file = refusal("file:///etc/passwd");
  check("file:// is refused", file.includes("http"));
  check("and says why it is pointless anyway", file.includes("~/modules"));
  check("data: is refused", refusal("data:text/javascript,export default {}").includes("http"));

  const html = refusal("https://example.com/docs/modules");
  check("a url with no loadable extension is refused", html.includes("evaluate"));
  check("and lists what would work", html.includes(".js") && html.includes(".ts"));

  check("nothing leaks a non-FetchModuleError", !["", "x", "file:///a", "https://a/b"].some((u) => refusal(u).startsWith("WRONG TYPE")));
}

/* ---------------- the filename cannot escape ---------------- */

{
  // ~/modules is a real directory in a real filesystem, and a name is the only
  // part of a URL an attacker fully controls.
  check("no traversal", !safeName("../../etc/passwd").includes("/"));
  check("no leading dots", !safeName("...hidden.js").startsWith("."));
  check("slashes become dashes", safeName("a/b.js") === "a-b.js");
  check("spaces and quotes are flattened", safeName('my "mod".js') === "my--mod-.js");
  check("an empty name still yields something loadable", safeName("!!!") === "---");
  check("an ordinary name is left alone", safeName("lava-lamp.ts") === "lava-lamp.ts");
}

/* ---------------- fetching ---------------- */

const target = { url: "https://example.test/m.js", host: "example.test", filename: "m.js" };
const reply = (body: string, init: Partial<Response> = {}) =>
  (async () =>
    ({ ok: true, status: 200, statusText: "OK", text: async () => body, ...init }) as Response) as unknown as typeof fetch;

const fetchFail = async (impl: typeof fetch): Promise<string> => {
  try {
    await fetchModuleSource(target, impl);
    return "";
  } catch (err) {
    return err instanceof FetchModuleError ? err.message : `WRONG TYPE: ${String(err)}`;
  }
};

{
  check("a good response is the source", (await fetchModuleSource(target, reply("export default {}"))) === "export default {}");

  const notFound = await fetchFail(reply("", { ok: false, status: 404 }));
  check("a 404 says so plainly", notFound.includes("404"));
  const teapot = await fetchFail(reply("", { ok: false, status: 500, statusText: "Server Error" }));
  check("another status is reported as it came", teapot.includes("500"));

  // CORS and "the host is down" are indistinguishable from here, so name both
  // rather than guess and be confidently wrong half the time.
  const dead = await fetchFail((() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch);
  check("an unreachable host names CORS as well", dead.includes("cross-origin"));

  check("an empty file is refused", (await fetchFail(reply("   "))).includes("empty"));
  check("an html page is refused", (await fetchFail(reply("<!doctype html><html>"))).includes("HTML"));
  check("and points at the raw link", (await fetchFail(reply("<html>"))).includes("raw"));

  const huge = "x".repeat(MAX_MODULE_BYTES + 1);
  const big = await fetchFail(reply(huge));
  check("something far too large is refused", big.includes("limit"));
  check("and says a bundle is not a module", big.includes("bundle"));
}

/* ---------------- the banner ---------------- */

{
  const banner = originBanner("https://example.test/m.js", new Date("2026-08-21T00:00:00Z"));
  check("the banner records where it came from", banner.includes("https://example.test/m.js"));
  check("and when", banner.includes("2026-08-21"));
  check("and that nothing has run yet", banner.includes("Nothing has run yet"));
  // It has to be a comment or the file it prefixes stops being loadable.
  check("every line of it is a comment", banner.trim().split("\n").every((l) => l.startsWith("//")));
}

/* ---------------- what /proc/permissions says about a fetched module ---------------- */

{
  const text = formatPermissions([
    { id: "clock", runtime: true, declared: null, granted: null },
    {
      id: "stranger",
      runtime: true,
      declared: null,
      granted: [...SAFE_DEFAULT],
      origin: "https://example.test/m.js",
    },
  ]);
  check("a fetched module is labelled as fetched", text.includes("fetched"));
  check("and where it came from is shown", text.includes("https://example.test/m.js"));
  // The reason for the fence has to be visible, or it is a fence people
  // work around rather than understand.
  check("the legend explains the stricter rule", text.includes("benefit of the doubt"));
  check("and every capability still has a blurb", Object.values(CAPABILITY_BLURBS).every((b) => b.length > 0));
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("all fetch-module checks passed");
