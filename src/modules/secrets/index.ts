import type { KernelContext, VoidModule } from "../../kernel/types";

/**
 * Hands configuration to framed project apps, out of the filesystem.
 *
 * A project app is same-origin DOM in an iframe, so it cannot read `.env` and
 * has no `process.env` to read from — there is no build watching it and no
 * server behind it. What it *can* do is ask its parent. This service answers
 * that question, reading from a file the user owns and edits in the shell's own
 * editor. Apps get configuration the way a program does: from the filesystem.
 *
 * SCOPE IS THE POINT. Keys live in one file per app, and a frame may only read
 * its own. Without that, every project ever added to the catalogue could read
 * every credential ever stored — which is precisely the failure mode of a real
 * `.env`, and there is no reason to import it.
 *
 * SECURITY, PLAINLY. Anything handed to a frame is in client-side JavaScript on
 * the user's machine. Devtools can read it, and so can any app the user chooses
 * to install. That is acceptable for a personal shell holding spend-capped
 * keys, and unacceptable for anything else. Nothing here makes a browser a safe
 * place to keep a secret; it only makes it a convenient one.
 */

const KEYS_DIR = "/home/void/.keys";

/** Where an app's configuration lives. One file per app, dotenv syntax. */
export function keyFileFor(appId: string): string {
  return `${KEYS_DIR}/${appId}.env`;
}

/**
 * Minimal dotenv parse: `KEY=value`, `#` comments, blank lines ignored.
 *
 * Splits on the *first* `=` only, so values containing `=` — base64 padding,
 * connection strings, JWTs — survive intact. Matching surrounding quotes are
 * stripped, because an editor makes them easy to add by reflex.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (key) out.set(key, value);
  }
  return out;
}

const TEMPLATE = [
  "# Configuration for this app, read by the voidshell secrets service.",
  "# One KEY=value per line. Only this app can read this file.",
  "#",
  "# Anything in here is readable by devtools and by any code this app loads.",
  "# Use spend-capped keys. Never put a credential here you could not revoke.",
  "",
].join("\n");

interface SecretsRequest {
  __voidshell?: unknown;
  op?: unknown;
  key?: unknown;
}

export const secrets: VoidModule = {
  manifest: {
    id: "secrets",
    name: "Secrets",
    kind: "service",
    blurb: "Serves per-app configuration to framed projects",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    /**
     * Which app owns which frame.
     *
     * Attribution has to come from the shell, not from the message: a frame
     * that could name its own app id could name somebody else's and read their
     * keys. projectApp claims its frame over the bus when it mounts, so the
     * only windows in this map are ones the shell put there itself.
     */
    const frames = new Map<Window, string>();

    const offClaim = ctx.on("secrets.claimFrame", (e) => {
      const p = e.payload as { win?: Window; appId?: string } | undefined;
      if (p?.win && typeof p.appId === "string") frames.set(p.win, p.appId);
    });
    const offRelease = ctx.on("secrets.releaseFrame", (e) => {
      const p = e.payload as { win?: Window } | undefined;
      if (p?.win) frames.delete(p.win);
    });

    const onMessage = (event: MessageEvent) => {
      const data = event.data as SecretsRequest | null;
      if (!data || data.__voidshell !== "secrets") return;

      const port = event.ports?.[0];
      // No reply channel means nothing can be answered. Staying silent is
      // correct: posting back to the source would broadcast a value to a
      // window we have not authenticated.
      if (!port) return;

      if (event.origin && event.origin !== window.location.origin) {
        port.postMessage({ ok: false, error: "cross-origin request refused" });
        return;
      }

      const appId = event.source ? frames.get(event.source as Window) : undefined;
      if (!appId) {
        port.postMessage({ ok: false, error: "unregistered frame" });
        ctx.log("refused a config request from an unregistered frame", "warn");
        return;
      }

      const path = keyFileFor(appId);
      let env = new Map<string, string>();
      if (ctx.fs.exists(path)) {
        try {
          env = parseEnv(ctx.fs.read(path));
        } catch (err) {
          port.postMessage({ ok: false, error: `unreadable: ${String(err)}` });
          return;
        }
      }

      if (data.op === "list") {
        // Names only. An app asking what it may use should not be told the
        // values as a side effect.
        port.postMessage({ ok: true, value: [...env.keys()] });
        return;
      }

      if (data.op !== "get" || typeof data.key !== "string") {
        port.postMessage({ ok: false, error: "bad request" });
        return;
      }

      const value = env.get(data.key) ?? null;
      if (value === null) {
        ctx.log(`${appId} asked for ${data.key}, which is not set`, "warn");
      }
      port.postMessage({ ok: true, value });
    };

    window.addEventListener("message", onMessage);

    ctx.defineSetting({
      key: "secrets.seed",
      label: "Create key files",
      kind: "action",
      group: "Apps",
      hint: `One ${KEYS_DIR}/<app>.env per installed app, for keys and settings`,
      order: 90,
      run: (c) => {
        c.fs.mkdirp(KEYS_DIR);
        let made = 0;
        for (const m of c.registry()) {
          if (m.kind !== "app") continue;
          const path = keyFileFor(m.id);
          if (c.fs.exists(path)) continue;
          c.fs.write(path, TEMPLATE);
          made++;
        }
        c.notify(
          made ? `created ${made} key file${made === 1 ? "" : "s"} in ${KEYS_DIR}` : "every app already has one",
          "good"
        );
      },
    });

    return () => {
      window.removeEventListener("message", onMessage);
      offClaim();
      offRelease();
      frames.clear();
    };
  },
};
