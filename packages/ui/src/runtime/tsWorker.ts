/// <reference lib="webworker" />
export {}; // module scope, so this file's helpers stay off the global namespace

/**
 * TypeScript, compiled in the tab.
 *
 * esbuild's WebAssembly build, off the main thread, doing exactly one job:
 * **transform**, never bundle. A module imports nothing — that is the property
 * the whole runtime loader rests on — so there is no graph to walk, and asking
 * for one would mean resolving bare specifiers that deliberately don't resolve.
 *
 * The alternative was a compile endpoint on the API. "POST arbitrary source and
 * we run the compiler on the droplet" is remote code execution offered as a
 * feature, and it would need its own auth design before it needed anything
 * else. Compiling in the tab keeps the author's code on the author's machine.
 *
 * The wasm binary is ~9MB and instantiating it takes a moment, so it is
 * initialised on the first request rather than on load: a shell that never
 * compiles anything never pays for this.
 */

import * as esbuild from "esbuild-wasm/esm/browser.js";
// Vite rewrites this to a hashed asset URL and emits the binary alongside the
// bundle. It must be same-origin — fetching it cross-origin would run into the
// shell's COEP policy.
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import {
  describeBuildFailure,
  type TransformReply,
  type TransformRequest,
} from "./transformProtocol";

const post = (reply: TransformReply) => (self as unknown as Worker).postMessage(reply);

/**
 * Started once, awaited by everybody.
 *
 * Two requests arriving before the wasm is up must not each call `initialize` —
 * esbuild throws on the second, and the failure surfaces as a compile error on
 * whichever file happened to be unlucky.
 */
let starting: Promise<void> | null = null;

const ready = (): Promise<void> => {
  // `worker: false` because we already are one. Left at its default, esbuild
  // would spawn a second worker underneath this one and pay for the wasm twice.
  starting ??= esbuild.initialize({ wasmURL, worker: false });
  return starting;
};

self.addEventListener("message", async (e: MessageEvent<TransformRequest>) => {
  const request = e.data;
  if (request?.type !== "transform") return;

  try {
    await ready();
    const out = await esbuild.transform(request.source, {
      loader: "ts",
      format: "esm",
      target: "es2021",
      // The map is not a nicety. Stripping types moves every line below the
      // types it removed, so without this a runtime error would be reported
      // against a line the author never wrote.
      sourcemap: true,
      sourcefile: request.path,
    });
    post({ type: "ok", id: request.id, code: out.code, map: out.map });
  } catch (err) {
    post({ type: "fail", id: request.id, ...describeBuildFailure(err) });
  }
});
