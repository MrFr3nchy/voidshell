#!/usr/bin/env node
/**
 * voidshell — set up, deploy, and operate a droplet.
 *
 * Plain ESM rather than TypeScript, deliberately. Everything else in this repo
 * compiles, but a CLI whose first job is provisioning a machine should not
 * itself need a build step to run — `npx voidshell setup` has to work on a
 * fresh clone, before anything has been built.
 */
import { say, fail, dim, bold, cyan } from "../lib/ui.mjs";
import { load, save } from "../lib/config.mjs";

import { setup, help as setupHelp } from "../commands/setup.mjs";
import { deploy, help as deployHelp } from "../commands/deploy.mjs";
import { status, help as statusHelp } from "../commands/status.mjs";
import { dev, help as devHelp } from "../commands/dev.mjs";
import { doctor, help as doctorHelp } from "../commands/doctor.mjs";
import { backup, backupHelp, restore, restoreHelp, key, keyHelp, logs, logsHelp } from "../commands/data.mjs";

/**
 * Flags are separated from positionals before dispatch.
 *
 * `--flag value` and `--flag=value` both work; a bare `--flag` is `true`.
 * Everything after a lone `--` is positional, so a filename that starts with a
 * dash can still be passed.
 */
function parse(argv) {
  const args = [];
  const flags = {};
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (literal) {
      args.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("-")) flags[name] = argv[++i];
      else flags[name] = true;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const name = token.slice(1);
      if (argv[i + 1] && !argv[i + 1].startsWith("-")) flags[name] = argv[++i];
      else flags[name] = true;
      continue;
    }
    args.push(token);
  }
  return { args, flags };
}

const COMMANDS = {
  dev: { run: dev, help: devHelp, blurb: "run the client and API together locally" },
  doctor: { run: doctor, help: doctorHelp, blurb: "check everything a deploy depends on" },
  setup: { run: setup, help: setupHelp, blurb: "provision a fresh droplet (idempotent)" },
  deploy: { run: deploy, help: deployHelp, blurb: "build, ship, restart, verify" },
  status: { run: status, help: statusHelp, blurb: "services, dashboards, backups, disk" },
  logs: { run: logs, help: logsHelp, blurb: "tail the API or proxy journal" },
  backup: { run: backup, help: backupHelp, blurb: "back up now, list what's kept" },
  restore: { run: restore, help: restoreHelp, blurb: "replace the live database" },
  key: { run: key, help: keyHelp, blurb: "store the model API key on the droplet" },
  config: { run: config, help: configHelp(), blurb: "show or set saved defaults" },
};

function configHelp() {
  return `
${bold("voidshell config")} [key] [value]

  With no arguments, prints the current settings. With a key and value, saves
  one. Settings live in ${dim(".voidshell.json")} beside the repo, which is gitignored —
  the droplet belongs to this checkout, not to your machine.

    voidshell config                          ${dim("show everything")}
    voidshell config target root@1.2.3.4
    voidshell config domain voidshell.example
    voidshell config proxy nginx
`;
}

const SETTABLE = new Set(["target", "domain", "proxy", "wwwDir", "apiDir", "dataDir", "port"]);

async function config(args) {
  const current = load();
  const [name, value] = args;

  if (!name) {
    say();
    for (const [k, v] of Object.entries(current)) {
      say(`  ${dim(k.padEnd(8))}  ${v === null ? dim("(unset)") : v}`);
    }
    say();
    return;
  }
  if (!SETTABLE.has(name)) {
    fail(`"${name}" is not a setting`, `try one of: ${[...SETTABLE].join(", ")}`);
  }
  if (value === undefined) {
    say(current[name] === null ? "" : String(current[name]));
    return;
  }
  current[name] = name === "port" ? Number(value) : value;
  save(current);
  say(`${cyan("→")} ${name} = ${current[name]}`);
}

function usage() {
  say();
  say(`  ${bold("voidshell")} ${dim("— set up, deploy, and operate a voidshell droplet")}`);
  say();
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, { blurb }] of Object.entries(COMMANDS)) {
    say(`  ${cyan(name.padEnd(width))}  ${blurb}`);
  }
  say();
  say(`  ${dim(`voidshell <command> --help  for details on any of them`)}`);
  say();
  say(`  ${dim("First time:")}  voidshell config domain example.com`);
  say(`               voidshell setup root@1.2.3.4`);
  say(`               voidshell deploy`);
  say();
}

const [, , name, ...rest] = process.argv;

if (!name || name === "help" || name === "--help" || name === "-h") {
  const topic = rest[0] ?? (name === "help" ? undefined : undefined);
  if (topic && COMMANDS[topic]) say(COMMANDS[topic].help);
  else usage();
  process.exit(0);
}

const command = COMMANDS[name];
if (!command) {
  const near = Object.keys(COMMANDS).filter((c) => c.startsWith(name[0]));
  fail(`unknown command "${name}"`, near.length ? `did you mean: ${near.join(", ")}?` : "run `voidshell` for the list");
}

const { args, flags } = parse(rest);
if (flags.help || flags.h) {
  say(command.help);
  process.exit(0);
}

try {
  await command.run(args, flags);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack?.split("\n")[1]?.trim() : undefined);
}
