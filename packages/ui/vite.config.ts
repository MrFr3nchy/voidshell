import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { voidshellProjects } from "./plugins/projects";
import { voidshellHost } from "./plugins/host";
import {
  CONFIG_FILE,
  ENV_VAR,
  createRootHandle,
  resolveProjectsRoot,
} from "./plugins/projectsRoot";

const uiDir = fileURLToPath(new URL(".", import.meta.url));

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

export default defineConfig(({ mode }) => {
  /**
   * Where /projects and the host bridge look for your repos.
   *
   * This was pinned to `path.resolve(uiDir, "../../..")` — the directory
   * holding the checkout — which is right only when voidshell happens to live
   * beside the things you want mounted. Now it is stated: an env var, or
   * `projectsRoot` in `voidshell.local.json`, with that old path as the
   * fallback so an untouched clone behaves exactly as before.
   *
   * `loadEnv` with the `VOIDSHELL_` prefix so the variable also works from
   * `.env.local`, which is the only one of the two that survives a reboot.
   */
  const env = { ...process.env, ...loadEnv(mode, uiDir, "VOIDSHELL_") };
  const resolved = resolveProjectsRoot({ uiDir, env });

  if (!resolved.exists) {
    console.warn(
      `[voidshell] projects root does not exist: ${resolved.root} (from ${resolved.source})\n` +
        `            /projects will be empty. Set ${ENV_VAR}, or "projectsRoot" in ${CONFIG_FILE}.`
    );
  }

  const root = createRootHandle(resolved);

  return {
    // Mounts the project directories at /projects inside the shell: live
    // during dev, frozen into the bundle at build.
    // voidshellHost is `apply: "serve"` — it exists only while the dev server
    // is running, so the deployed static build has no command bridge at all.
    //
    // Both take the same live handle, so repointing the root moves the scan
    // and the command sandbox together. Were the bridge given a fixed string,
    // the two would drift apart and the shell would list files it then
    // refused to run anything against.
    plugins: [voidshellProjects({ root }), voidshellHost({ root })],
    server: {
      port: 5173,
      open: true,
      headers: isolationHeaders,
      // Same-origin /api in dev as in production, so the session cookie —
      // which is SameSite=Strict — behaves identically in both. Pointing the
      // client at http://localhost:3000 directly would work right up until the
      // cookie didn't.
      proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: false } },
    },
    preview: { headers: isolationHeaders },
    build: { target: "es2021" },
    worker: { format: "es" as const },
  };
});
