import { defineConfig } from "vite";
import { voidshellProjects } from "./plugins/projects";
import { voidshellHost } from "./plugins/host";

/**
 * Cross-origin isolation. Required for SharedArrayBuffer, which is what lets
 * the Python worker block on `Atomics.wait` for `input()` — without it,
 * interactive terminal programs can't read stdin at all.
 *
 * Pyodide is fetched from jsDelivr, which serves
 * `Cross-Origin-Resource-Policy: cross-origin`, so `require-corp` doesn't
 * break it. Any *new* cross-origin asset must send CORP or it will be blocked.
 * Deployments need these same two headers — see DEPLOY.md.
 */
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  // `credentialless` rather than `require-corp`: it still grants
  // SharedArrayBuffer, but cross-origin subresources load (without credentials)
  // instead of being hard-blocked for lacking a CORP header. That matters
  // because the host bridge frames real dev servers, which don't send CORP.
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  // Mounts the sibling project directories at /projects inside the shell:
  // live during dev, frozen into the bundle at build.
  // voidshellHost is `apply: "serve"` — it exists only while the dev server is
  // running, so the deployed static build has no command bridge at all.
  plugins: [voidshellProjects(), voidshellHost()],
  server: { port: 5173, open: true, headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: { target: "es2021" },
  worker: { format: "es" },
});
