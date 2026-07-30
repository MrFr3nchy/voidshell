import { existsSync } from "node:fs";
import { join } from "node:path";
import { run, have, sshScript } from "../lib/sh.mjs";
import { REPO, load } from "../lib/config.mjs";
import { say, ok, warn, fail, dim, bold, step, green, red, yellow, table } from "../lib/ui.mjs";

export const help = `
${bold("voidshell doctor")} [user@host]

  Checks the things that make a deploy fail in a confusing way: missing local
  tools, an unbuildable tree, an unreachable droplet, a key that isn't trusted.

  Exits non-zero if anything is actually broken, so CI can run it.
`;

export async function doctor(args) {
  const config = load();
  const target = args[0] ?? config.target;
  const rows = [];
  let broken = 0;
  let warned = 0;

  const record = (label, state, detail) => {
    if (state === "ok") rows.push([label, detail ?? "ok", green]);
    else if (state === "warn") (warned++, rows.push([label, detail, yellow]));
    else (broken++, rows.push([label, detail, red]));
  };

  step("Local");

  const major = Number(process.versions.node.split(".")[0]);
  record("node", major >= 22 ? "ok" : "bad", `${process.version}${major >= 22 ? "" : " — needs 22 or newer"}`);

  for (const tool of ["ssh", "rsync", "scp", "npm"]) {
    record(tool, (await have(tool)) ? "ok" : "bad", (await have(tool)) ? "found" : "not on PATH");
  }

  record(
    "dependencies",
    existsSync(join(REPO, "node_modules")) ? "ok" : "bad",
    existsSync(join(REPO, "node_modules")) ? "installed" : `run ${dim("npm install")}`
  );

  const tc = await run("npm", ["run", "typecheck"], { cwd: REPO, capture: true });
  record("typecheck", tc.code === 0 ? "ok" : "bad", tc.code === 0 ? "clean" : "failing — deploy would ship this");

  say();
  table(rows);
  rows.length = 0;

  if (!target) {
    say();
    warn(`No droplet configured — skipping remote checks. ${dim("voidshell config target root@1.2.3.4")}`);
  } else {
    say();
    step(`Remote (${bold(target)})`);

    const probe = await sshScript(
      target,
      `echo "reach=ok"
echo "node=$(node -v 2>/dev/null || echo missing)"
echo "unit=$(systemctl list-unit-files voidshell-api.service --no-legend 2>/dev/null | wc -l)"
echo "data=$([ -d ${config.dataDir} ] && stat -c %a ${config.dataDir} || echo missing)"
echo "www=$([ -d ${config.wwwDir} ] && echo ok || echo missing)"
echo "sudo=$(sudo -n true 2>/dev/null && echo ok || echo no)"
echo "disk=$(df --output=pcent / | tail -1 | tr -d ' %')"`,
      { capture: true }
    );

    if (probe.code !== 0) {
      record("ssh", "bad", probe.stderr.trim().split("\n")[0] || "could not connect");
    } else {
      const f = Object.fromEntries(
        probe.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
      );
      record("ssh", "ok", "connected without a password");
      record("node", f.node === "missing" ? "bad" : "ok", f.node === "missing" ? `run ${dim("voidshell setup")}` : f.node);
      record("service", f.unit === "0" ? "bad" : "ok", f.unit === "0" ? `not installed — run ${dim("voidshell setup")}` : "installed");
      record(
        "data dir",
        f.data === "missing" ? "bad" : f.data === "700" ? "ok" : "warn",
        f.data === "missing" ? `run ${dim("voidshell setup")}` : `mode ${f.data}${f.data === "700" ? "" : ", expected 700"}`
      );
      record("web root", f.www === "ok" ? "ok" : "bad", f.www === "ok" ? config.wwwDir : "missing");
      record("sudo", f.sudo === "ok" ? "ok" : "warn", f.sudo === "ok" ? "passwordless" : "needs a password — deploys will hang on restart");
      const pct = Number(f.disk);
      record("disk", pct >= 90 ? "bad" : pct >= 75 ? "warn" : "ok", `${pct}% used`);
    }

    say();
    table(rows);
  }

  say();
  if (broken) fail(`${broken} problem${broken === 1 ? "" : "s"} to fix${warned ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}`);
  if (warned) warn(`${warned} warning${warned === 1 ? "" : "s"}, nothing blocking`);
  else ok("Everything checks out");
  say();
}
