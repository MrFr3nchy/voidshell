/**
 * Checks for the lock screen, in jsdom against a stubbed fetch.
 *
 * The states here are the ones a user hits on their worst day — a mistyped
 * key, a rate limit, a server that isn't answering — so they are worth testing
 * somewhere other than production.
 *
 *   npx esbuild tools/lock-smoke.mts --bundle --platform=node --format=esm \
 *     --outfile=lock-smoke.mjs --external:jsdom --log-level=error \
 *     && node lock-smoke.mjs
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
  pretendToBeVisual: true,
  url: "https://example.test",
});

const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
g.HTMLElement = dom.window.HTMLElement;
g.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0);

/** Scripted responses, one per call, so each test drives its own sequence. */
type Reply = { status: number; body?: unknown } | "offline";
let queue: Reply[] = [];
const calls: string[] = [];

const sent: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];

g.fetch = async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  calls.push(`${init?.method ?? "GET"} ${input}`);
  sent.push({
    url: input,
    method: init?.method ?? "GET",
    headers: init?.headers ?? {},
    ...(init?.body === undefined ? {} : { body: init.body }),
  });
  const next = queue.shift();
  if (!next || next === "offline") throw new TypeError("Failed to fetch");
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    statusText: String(next.status),
    json: async () => next.body ?? {},
  };
};

const { runLockScreen } = await import("../packages/ui/src/ui/lockScreen");

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

const doc = dom.window.document;
const $ = (sel: string) => doc.querySelector(sel) as HTMLElement | null;
const text = () => doc.body.textContent ?? "";
const tick = () => new Promise((r) => dom.window.setTimeout(r, 0));

function reset() {
  doc.body.replaceChildren();
  queue = [];
  calls.length = 0;
}

/* ---------------- a 401 asks for a key ---------------- */

{
  reset();
  const settled = runLockScreen({ unreachable: false });
  void settled;
  await tick();

  check("a locked screen offers a key field", $(".lock-input") !== null);
  check("it offers to create a dashboard", text().includes("create a new dashboard"));
  check("the warning is present without being asked for", text().includes("toy account system"));
  check("the warning names the consequence", text().includes("gone permanently"));
  check("no request was made just to render the form", calls.length === 0);
}

/* ---------------- an unreachable server is not a locked one ---------------- */

{
  reset();
  void runLockScreen({ unreachable: true });
  await tick();

  check("an unreachable server says so", text().includes("can't reach the server"));
  check("it reassures rather than alarms", text().includes("Nothing has been lost"));
  // The distinction that matters: a down server must never present as a key
  // problem, or people start doubting a key that is perfectly good.
  check("it does not ask for a key", $(".lock-input") === null);
  check("it offers a retry", text().includes("try again"));
}

/* ---------------- retry recovers ---------------- */

{
  reset();
  const settled = runLockScreen({ unreachable: true });
  await tick();

  queue = [{ status: 200, body: { user: {}, workspace: { state: { back: 1 }, fs: null } } }];
  ($(".lock-btn-primary") as HTMLButtonElement).click();
  const ws = await settled;
  check(
    "retry resolves with the workspace once the server returns",
    (ws.workspace.state as { back: number }).back === 1
  );
  check("a session reached through the server is not a guest one", ws.guest === false);
}

/* ---------------- a wrong key ---------------- */

{
  reset();
  void runLockScreen({ unreachable: false });
  await tick();

  const input = $(".lock-input") as HTMLInputElement;
  input.value = "wrong-wrong-wrong-wrong";
  queue = [{ status: 401, body: { error: "that key doesn't match a dashboard" } }];
  ($(".lock-form") as HTMLFormElement).dispatchEvent(new dom.window.Event("submit"));
  await tick();
  await tick();

  check("a wrong key shows an error", $(".lock-error")?.hidden === false);
  check("the error does not blame the network", !(text().includes("Can't reach")));
  check("the field is usable again", !input.disabled);
}

/* ---------------- a rate limit says something useful ---------------- */

{
  reset();
  void runLockScreen({ unreachable: false });
  await tick();

  const input = $(".lock-input") as HTMLInputElement;
  input.value = "some-key-goes-here";
  queue = [{ status: 429, body: { error: "rate limited" } }];
  ($(".lock-form") as HTMLFormElement).dispatchEvent(new dom.window.Event("submit"));
  await tick();
  await tick();

  // Telling someone their key is wrong when it isn't is how a good key gets
  // thrown away.
  check("a 429 is reported as a rate limit, not a bad key", text().includes("Too many attempts"));
}

/* ---------------- a good key ---------------- */

{
  reset();
  const settled = runLockScreen({ unreachable: false });
  await tick();

  const input = $(".lock-input") as HTMLInputElement;
  input.value = "shiny-gold-tooth-harbor";
  queue = [
    { status: 200, body: { user: {} } },
    { status: 200, body: { user: {}, workspace: { state: { hue: 7 }, fs: null } } },
  ];
  ($(".lock-form") as HTMLFormElement).dispatchEvent(new dom.window.Event("submit"));
  const ws = await settled;

  check("a good key resolves with the dashboard", (ws.workspace.state as { hue: number }).hue === 7);
  check("it signed in and then loaded the session", calls.join(" ") === "POST /api/auth/signin GET /api/session");
}

/* ---------------- signup shows the key exactly once ---------------- */

{
  reset();
  const settled = runLockScreen({ unreachable: false });
  await tick();

  queue = [{ status: 201, body: { key: "shiny-gold-tooth-harbor", user: {} } }];
  const create = [...doc.querySelectorAll(".lock-btn-ghost")].find(
    (b) => b.textContent === "create a new dashboard"
  ) as HTMLButtonElement;
  create.click();
  await tick();
  await tick();

  check("the new key is shown", $(".lock-key")?.textContent === "shiny-gold-tooth-harbor");
  check("it says the key won't be shown again", text().includes("will not see it again"));
  check("the full warning is shown at signup", text().includes("toy account system"));
  check("the warning is not dismissible here", $(".lock-warn.is-dismissible") === null);

  // The confirmation is the last chance to notice, so it must actually gate.
  const enter = [...doc.querySelectorAll(".lock-btn-primary")].find(
    (b) => b.textContent === "enter the void"
  ) as HTMLButtonElement;
  check("entering is blocked until the key is acknowledged", enter.disabled === true);

  const box = doc.querySelector(".lock-confirm input") as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new dom.window.Event("change"));
  check("acknowledging unblocks it", enter.disabled === false);

  queue = [{ status: 200, body: { user: {}, workspace: { state: {}, fs: null } } }];
  enter.click();
  const ws = await settled;
  check("a new dashboard starts empty", JSON.stringify(ws.workspace) === '{"state":{},"fs":null}');
}

/* ---------------- going in without an account ---------------- */

/**
 * The offer has to be on *both* screens, and the reasons differ.
 *
 * On the locked screen it is the answer to being asked for a credential before
 * being shown what it unlocks. On the unreachable one it is the difference
 * between a dead page and a working shell — nothing behind that screen needs
 * the server except the saving, so refusing to boot over an outage costs the
 * user the whole OS rather than one of its properties.
 */
const guestButton = () =>
  doc.querySelector(".lock-guest .lock-btn") as HTMLButtonElement | null;

{
  reset();
  const settled = runLockScreen({ unreachable: false });
  await tick();

  const btn = guestButton();
  check("the locked screen offers a way in without an account", btn !== null);
  check("it says what you give up", text().includes("saved when the tab closes"));

  btn!.click();
  const session = await settled;
  check("it resolves as a guest", session.guest === true);
  check("a guest starts from an empty dashboard", JSON.stringify(session.workspace) === '{"state":{},"fs":null}');
  // The whole point is that this path needs nothing from the server. A request
  // here would mean guest mode is unavailable in exactly the case it exists for.
  check("nothing was asked of the server", calls.length === 0);
}

{
  reset();
  const settled = runLockScreen({ unreachable: true });
  await tick();

  check("an unreachable server offers it too", guestButton() !== null);
  check("it says only the saving needs the server", text().includes("only the saving needs the server"));

  guestButton()!.click();
  const session = await settled;
  check("an outage still gets you a shell", session.guest === true);
  check("still nothing was asked of the server", calls.length === 0);
}

/* ---------------- what goes on the wire ---------------- */

{
  // The stub above means this harness never talks to a real server, so it has
  // to assert the request shape itself. Declaring a JSON content-type on a
  // bodyless POST is what broke signup in the browser while three harnesses
  // reported green.
  const signup = sent.find((r) => r.url === "/api/auth/signup");
  check("signup posts no content-type, because it posts no body", !!signup && signup.body === undefined && !("content-type" in signup.headers));

  const signin = sent.find((r) => r.url === "/api/auth/signin");
  check("signin does declare json, because it sends some", !!signin && typeof signin.body === "string" && signin.headers["content-type"] === "application/json");
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all lock screen checks passed");
