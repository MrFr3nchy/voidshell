import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Colour is off unless stdout is a terminal, and off entirely under NO_COLOR.
 * The CLI gets piped into logs and CI as often as it gets read by a person.
 */
const useColor = stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const dim = c("2");
export const bold = c("1");
export const cyan = c("36");
export const green = c("32");
export const yellow = c("33");
export const red = c("31");

export const say = (msg = "") => console.log(msg);
export const step = (msg) => console.log(`${cyan("→")} ${msg}`);
export const ok = (msg) => console.log(`${green("✓")} ${msg}`);
export const warn = (msg) => console.log(`${yellow("!")} ${msg}`);
export const info = (msg) => console.log(`  ${dim(msg)}`);

export function fail(msg, hint) {
  console.error(`${red("✗")} ${msg}`);
  if (hint) console.error(`  ${dim(hint)}`);
  process.exit(1);
}

/** A two-column table that lines up without pulling in a formatting library. */
export function table(rows) {
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v, tint] of rows) {
    const label = dim(k.padEnd(width));
    console.log(`  ${label}  ${tint ? tint(v) : v}`);
  }
}

async function prompt(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Confirmation for anything hard to undo.
 *
 * Refuses rather than assumes when there is nobody to ask — a restore that
 * silently proceeds because it was run from a script is exactly the situation
 * the prompt exists to prevent. `--yes` is the way through.
 */
export async function confirm(question) {
  if (!stdin.isTTY) {
    fail("this needs confirmation but there is no terminal to ask", "re-run with --yes if you're sure");
  }
  const answer = await prompt(`${yellow("?")} ${question} ${dim("[y/N]")} `);
  return /^y(es)?$/i.test(answer);
}

/** Reads a secret without echoing it, and without it ever touching argv. */
export async function secret(question) {
  if (!stdin.isTTY) {
    // Piped in: read the whole of stdin and use it. Lets `pass show … | voidshell key` work.
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  stdout.write(`${yellow("?")} ${question} `);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  const ENTER = 13, NEWLINE = 10, CTRL_C = 3, BACKSPACE = 127, DELETE = 8;
  let value = "";

  try {
    outer: for await (const chunk of stdin) {
      for (const byte of chunk) {
        if (byte === ENTER || byte === NEWLINE) break outer;
        if (byte === CTRL_C) {
          stdin.setRawMode(wasRaw);
          stdout.write("\n");
          process.exit(130);
        }
        if (byte === BACKSPACE || byte === DELETE) {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore the rest of the control range: arrow keys and friends would
        // otherwise land in the middle of a key as escape-sequence garbage.
        if (byte < 32) continue;
        value += String.fromCharCode(byte);
      }
    }
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
  }
  stdout.write("\n");
  return value.trim();
}
