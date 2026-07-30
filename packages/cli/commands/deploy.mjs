import { mkdtemp, rm, cp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, must, sshScript, rsync, q } from "../lib/sh.mjs";
import { REPO, resolveTarget, load } from "../lib/config.mjs";
import { step, ok, info, say, fail, dim, bold, warn } from "../lib/ui.mjs";

export const help = `
${bold("voidshell deploy")} [user@host] [options]

  Builds both packages, ships them, restarts the API, and waits for it to
  report healthy — failing loudly rather than reporting success because
  systemctl returned zero.

  ${dim("--skip-build")}   ship whatever is already in dist/
  ${dim("--api-only")}     skip the client bundle
  ${dim("--ui-only")}      skip the API
`;

/**
 * Modes for everything shipped: directories traversable, files readable.
 *
 * `-a` implies `-p`, which faithfully preserves whatever the source happened
 * to be — and the API's source is a `mkdtemp` staging directory, created 0700
 * by design. Those modes rode to the droplet and left the unprivileged
 * `voidshell` service user unable to enter its own WorkingDirectory: systemd
 * failed with `status=200/CHDIR` before Node was ever executed, which reads
 * like an application crash and isn't one.
 *
 * Stating the modes here also makes a deploy independent of the umask on
 * whichever machine ran it. Nothing is group- or world-writable: the API only
 * ever reads its own code, and root-owned files mean a compromised API cannot
 * rewrite them. The database in `dataDir` is 0700 and untouched by this.
 */
const SHIPPED_MODES = "--chmod=D755,F644";

export async function deploy(args, flags) {
  const config = load();
  const target = resolveTarget(args[0], config);
  const doApi = !flags["ui-only"];
  const doUi = !flags["api-only"];

  say();
  step(`Deploying to ${bold(target)}`);

  if (!flags["skip-build"]) {
    if (doUi) {
      step("Building the client");
      await must("npm", ["run", "build"], { cwd: REPO, message: "the client build failed" });
    }
    if (doApi) {
      step("Building the API");
      await must("npm", ["run", "build", "--workspace", "@voidshell/api"], {
        cwd: REPO,
        message: "the API build failed",
      });
    }
  }

  const stage = await mkdtemp(join(tmpdir(), "voidshell-deploy-"));
  try {
    if (doApi) {
      step("Staging API runtime dependencies");
      // Installed against the API's own manifest so the droplet gets fastify
      // without vite, three, or any of the type packages.
      await cp(join(REPO, "packages/api/dist"), join(stage, "dist"), { recursive: true });
      await copyFile(join(REPO, "packages/api/package.json"), join(stage, "package.json"));
      const install = await run("npm", ["install", "--omit=dev", "--no-package-lock", "--silent"], {
        cwd: stage,
        capture: true,
      });
      if (install.code !== 0) fail("could not stage API dependencies", install.stderr.trim());

      step(`Syncing API → ${config.apiDir}`);
      // No --delete: /opt/voidshell also holds backup.sh and anything else
      // installed by hand, and a deploy shouldn't sweep the droplet's own
      // furniture.
      const r = await rsync([
        "-az",
        SHIPPED_MODES,
        "-e",
        "ssh",
        `${stage}/`,
        `${target}:${config.apiDir}/`,
      ]);
      if (r.code !== 0) fail("could not sync the API");
    }

    if (doUi) {
      step(`Syncing client → ${config.wwwDir}`);
      const r = await rsync([
        "-az",
        "--delete",
        SHIPPED_MODES,
        "-e",
        "ssh",
        `${join(REPO, "packages/ui/dist")}/`,
        `${target}:${config.wwwDir}/`,
      ]);
      if (r.code !== 0) fail("could not sync the client");
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  if (!doApi) {
    say();
    ok("Client deployed");
    return;
  }

  step("Restarting and waiting for health");
  const result = await sshScript(
    target,
    `set -euo pipefail
systemctl restart voidshell-api
# systemctl returns as soon as the unit is active, which is before the store
# has finished loading. Poll the thing that actually answers.
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:${config.port}/api/health; then echo; exit 0; fi
  sleep 1
done
echo
echo "the api did not come back healthy" >&2
journalctl -u voidshell-api -n 40 --no-pager >&2
exit 1`,
    { capture: true }
  );

  if (result.code !== 0) {
    say();
    warn("The API did not come back healthy. Last log lines:");
    say(result.stderr.trim());
    fail("deploy failed", `the previous build is still on disk — ${dim(`voidshell logs ${target}`)}`);
  }

  say();
  ok("Deployed");
  const health = result.stdout.trim().split("\n").pop() ?? "";
  if (health) info(`health  ${health}`);
  if (config.domain) info(`live at https://${config.domain}`);
  say();
}
