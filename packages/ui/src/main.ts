import "./style.css";
import "./ui/canvasStage.css";
import "./ui/appShelves.css";
import "./ui/surfaceForms.css";
import "./modules/devkit/devkit.css";
import { Kernel } from "./kernel/Kernel";
import { ApiWorkspaceHost, ApiError, api } from "./kernel/apiWorkspace";
import type { WorkspaceSnapshot } from "./kernel/persistence";
import { ThreeCompositor } from "./compositor/ThreeCompositor";
import { runBootSequence } from "./boot/bootSequence";
import { createSpawner } from "./ui/spawner";
import { createAppDrawer } from "./ui/appDrawer";
import { createPalette } from "./ui/palette";
import { createToasts } from "./ui/toasts";
import { createStatusBar } from "./ui/statusBar";
import { createPower } from "./ui/power";
import { runLockScreen } from "./ui/lockScreen";
import { monitor } from "./modules/monitor";
import { portal } from "./modules/portal";
import { workspace } from "./modules/workspace";
import { chronos } from "./modules/chronos";
import { cosmos } from "./modules/cosmos";
import { editor } from "./modules/editor";
import { webapp } from "./modules/webapp";
import { desktop } from "./modules/desktop";
import { trash } from "./modules/trash";
import { calculator } from "./modules/calculator";
import { calendar } from "./modules/calendar";
import { timer } from "./modules/timer";
import { buildProjectsTree } from "./kernel/vfs";
import { loadProjects } from "virtual:voidshell-projects";
import { aurora } from "./modules/aurora";
import { horizon } from "./modules/horizon";
import { shell, RESTORE_KEY } from "./modules/shell";
import { settings } from "./modules/settings";
import { dashboards } from "./modules/dashboards";
import { notes } from "./modules/notes";
import { vitals } from "./modules/vitals";
import { cradle } from "./modules/cradle";
import { driftfield } from "./modules/driftfield";
import { sandbox } from "./modules/sandbox";
import { harmonograph } from "./modules/harmonograph";
import { lunaria } from "./modules/lunaria";
import { bubblewrap } from "./modules/bubblewrap";
import { ripple } from "./modules/ripple";
import { flock } from "./modules/flock";
import { orrery } from "./modules/orrery";
import { lavalamp } from "./modules/lavalamp";
import { turmite } from "./modules/turmite";
import { chaos } from "./modules/chaos";
import { sunclock } from "./modules/sunclock";
import { bell } from "./modules/bell";
import { arcade } from "./modules/arcade";
import { createDevkit } from "./modules/devkit";

/**
 * Get a dashboard, one way or another.
 *
 * Returns only once there is a session. Nothing that follows — no compositor,
 * no WebGL context, no module — is constructed before this resolves, which is
 * the difference between a lock screen and a login form drawn over a running
 * OS that has already leaked what it contains.
 */
async function openSession(): Promise<WorkspaceSnapshot> {
  try {
    return (await api.session()).workspace;
  } catch (err) {
    // A 401 is "sign in". Anything else is the server being unreachable, and
    // answering that with a lock screen teaches people their key stopped
    // working — so the two get visibly different screens.
    const unreachable = err instanceof ApiError && err.offline;
    return runLockScreen({ unreachable });
  }
}

/**
 * One signed-in session, start to finish.
 *
 * Resolves when the user signs out, having torn down everything it built. The
 * caller loops, so signing out lands back on the lock screen without a page
 * reload — and, more importantly, without a second WebGL context.
 */
async function runShell(gl: HTMLElement, hud: HTMLElement, saved: WorkspaceSnapshot): Promise<void> {
  // Starts silent: there is no toast system until the kernel is up, and a
  // save can fail before then. Upgraded to real toasts a few lines below.
  const host = new ApiWorkspaceHost();

  // The panel overlay sits above the WebGL canvas, below the HUD. It ignores
  // pointer events itself so drags on empty space reach the canvas; the panels
  // inside it re-enable pointer events and are fully interactive DOM.
  const overlay = document.createElement("div");
  overlay.id = "panel-layer";
  document.body.insertBefore(overlay, hud);

  // Pick your render backend here. This one line is the whole "renderer is a
  // plugin" story: swap ThreeCompositor for a DomCompositor and every module
  // above renders unchanged in a flat 2D world instead.
  const compositor = new ThreeCompositor();
  const kernel = new Kernel(compositor, host);

  // Before register(), and so before any defineSetting() seeds a default over
  // a value the user actually chose.
  kernel.hydrate(saved);

  /** Everything registered on the way up, undone on the way out. */
  const teardown = new AbortController();
  let signedOut: () => void = () => {};
  const untilSignout = new Promise<void>((r) => (signedOut = r));

  // The one module that installs other modules, so it is handed the kernel
  // itself rather than finding that capability on the ordinary context. Same
  // arrangement as createPower below, which receives the two things a module
  // is not allowed to do for itself.
  const devkit = createDevkit(kernel);

  kernel
    // services and world modules first — they publish settings the apps read
    .register(aurora)
    .register(horizon)
    .register(shell)
    // apps. Registration order no longer decides which app opens what — see
    // kernel/assoc.ts, where a module states its types and a priority.
    .register(workspace)
    .register(webapp)
    .register(editor)
    .register(desktop)
    .register(trash)
    .register(calculator)
    .register(calendar)
    .register(timer)
    .register(chronos)
    .register(cosmos)
    .register(settings)
    .register(dashboards)
    .register(notes)
    .register(vitals)
    .register(monitor)
    .register(portal)
    .register(arcade)
    .register(devkit)
    // ambient apps — things to leave open and look at
    .register(cradle)
    .register(driftfield)
    .register(sandbox)
    .register(harmonograph)
    .register(lunaria)
    .register(bubblewrap)
    .register(ripple)
    .register(flock)
    .register(orrery)
    .register(lavalamp)
    .register(turmite)
    .register(chaos)
    .register(sunclock)
    .register(bell);

  // Mount the real project directory. This is deliberately not fatal: if the
  // scan is unavailable the shell still boots, just without /projects.
  try {
    const snapshot = await loadProjects();
    if (snapshot.projects.length) {
      kernel.fs.mount("/projects", buildProjectsTree(snapshot));
      console.info(
        `[voidshell] mounted /projects — ${snapshot.projects.length} projects, ` +
          `${snapshot.entries.length} entries`
      );
    }
  } catch (err) {
    console.warn("[voidshell] /projects not mounted:", err);
  }

  // Panels emit a DOM event when their close button is hit; route it home.
  window.addEventListener("voidshell:close-surface", (e) => {
    const id = (e as CustomEvent<{ id: string }>).detail?.id;
    if (id) kernel.closeSurface(id);
  });

  await kernel.boot({ gl, overlay, hud });

  // First-run only: leave something in the home directory so it isn't a void
  // inside the void. Guarded on existence so it never clobbers real edits.
  if (!kernel.fs.exists("/home/void/welcome.md")) {
    kernel.fs.write(
      "/home/void/welcome.md",
      [
        "# welcome to voidshell",
        "",
        "This is a real filesystem. Your files here persist across reloads;",
        "/projects is a read-only mount of the source on disk.",
        "",
        "Try in the console:",
        "  ls /projects",
        "  cat /projects/voidshell/README.md",
        "  cd /projects && find shader",
        "",
        "Files you create here are yours. Edit this one and hit save.",
      ].join("\n")
    );
    // Put something on the desktop too, so the first boot demonstrates it.
    kernel.fs.mkdirp("/home/void/Desktop");
    kernel.fs.write(
      "/home/void/Desktop/readme.md",
      [
        "# the desktop is a directory",
        "",
        "This file lives at /home/void/Desktop/readme.md. Its icon is just that",
        "directory drawn into the void — delete the file in the console and the",
        "icon goes with it.",
        "",
        "- right-click the void for New Folder / New File",
        "- drag files out of the Files window to drop them here",
        "- double-click to open, drag an icon to move it",
      ].join("\n")
    );
  }

  const ctx = kernel.context();

  createToasts(hud, ctx);
  createStatusBar(hud, ctx);

  host.setNotifier((message, opts) => ctx.notify(message, opts));

  // Power owns the veil, so it needs the two things a module can't do for
  // itself: write the session down, and close windows it doesn't own.
  const power = createPower(hud, ctx, {
    save: () => {
      if (!resetting) kernel.saveSession();
    },
    closeAll: () => {
      for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
    },
  });

  const spawner = createSpawner(hud, ctx, () => drawer.toggle(true));
  const drawer = createAppDrawer(hud, ctx, {
    openRing: (open) => spawner.toggle(open),
  });
  const palette = createPalette(hud, ctx);

  /* ---------------- things modules can only ask the shell to do ---------- */

  ctx.on("shell.openDrawer", () => drawer.toggle(true));
  ctx.on("shell.openPalette", () => palette.toggle(true));
  ctx.on("shell.saveSession", () => kernel.saveSession());
  ctx.on("shell.reopenWindow", () => kernel.reopenLast());
  ctx.on("shell.signOut", () => void signOut());

  ctx.on("shell.factoryReset", () => {
    resetting = true;
    // Awaited: the reload would otherwise outrun the write and leave the old
    // dashboard on the server.
    void kernel.factoryReset().finally(() => location.reload());
  });

  /* ---------------- keybinds ---------------- */

  const typing = (t: EventTarget | null) =>
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement;

  /**
   * Step focus through the open windows and turn the void to face each one.
   *
   * Deliberately not "the most recently used first": in a place where windows
   * have positions, a stable order you can walk in both directions is easier to
   * predict than a stack that reshuffles itself every time you look at
   * something.
   */
  const cycleWindows = (dir: number) => {
    const open = ctx.openSurfaces();
    if (!open.length) return;
    const active = ctx.activeSurface();
    const at = open.findIndex((s) => s.id === active);
    const next = open[(at + dir + open.length) % open.length];
    ctx.focusSurface(next.id);
    ctx.lookAt(next.id);
  };

  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;

    // Locking has to beat every other bind, including the ones that fire while
    // typing — walking away from a machine shouldn't require focusing the void.
    if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      power.lock();
      return;
    }
    if (power.locked()) return;

    if (mod && e.key.toLowerCase() === "k" && !e.shiftKey) {
      e.preventDefault();
      palette.toggle();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      drawer.toggle();
      return;
    }
    // Escape hatches. These have to work when the layout is broken enough
    // that reaching a window or a menu isn't realistic.
    if (mod && e.shiftKey && e.key.toLowerCase() === "u") {
      e.preventDefault();
      const groups = ctx.listGroups();
      for (const g of groups) ctx.unlinkGroup(g.id);
      ctx.notify(`dissolved ${groups.length} constellation${groups.length === 1 ? "" : "s"}`, "good");
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const open = ctx.openSurfaces();
      for (const s of open) kernel.closeSurface(s.id);
      ctx.notify(`closed ${open.length} window${open.length === 1 ? "" : "s"}`, "good");
      return;
    }
    // The counterpart to closing one. Deliberately above the typing guard: it
    // is the browser's own reopen-tab shortcut, and muscle memory doesn't stop
    // at the edge of a text field.
    if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      kernel.reopenLast();
      return;
    }
    if (mod && e.key === ",") {
      e.preventDefault();
      kernel.launch("settings");
      return;
    }
    // Cycling and the overview both work while typing: they are about which
    // window you are in, and needing to leave a text field to change windows
    // is exactly the friction they exist to remove.
    if (mod && (e.key === "`" || e.key === "~")) {
      e.preventDefault();
      cycleWindows(e.shiftKey ? -1 : 1);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      ctx.expose();
      return;
    }
    if (e.key === "Escape") {
      palette.toggle(false);
      drawer.toggle(false);
      spawner.toggle(false);
      ctx.expose(false);
      return;
    }
    if (typing(e.target)) return;

    if (e.code === "Space") {
      e.preventDefault();
      spawner.toggle();
    } else if (e.key === "Home") {
      e.preventDefault();
      ctx.resetView();
    }
  });

  /* ---------------- session ---------------- */

  // A wipe must not be undone by the unload handler writing the session back.
  let resetting = false;

  const restore = ctx.state.get<boolean>(RESTORE_KEY, true);
  let restored = false;
  if (restore) {
    try {
      kernel.restoreSession();
      restored = kernel.context().openSurfaces().length > 0;
    } catch (err) {
      console.warn("[voidshell] session restore failed:", err);
    }
  }

  // /etc/autostart runs on every boot, restored session or not — that's what
  // makes it autostart rather than a second session file. The singleton guard
  // means anything the restore already re-opened is refocused, not cloned.
  const autostarted = kernel.runAutostart();

  // Give the fresh void something to hold so it doesn't open empty.
  if (!restored && !autostarted) kernel.launch("chronos");

  const save = () => {
    if (resetting) return;
    if (ctx.state.get<boolean>(RESTORE_KEY, true)) kernel.saveSession();
  };

  /**
   * The layout is in memory and the server's copy may be a second behind, so
   * every exit has to flush rather than schedule. beforeunload is the one that
   * cannot await, which is why visibilitychange carries the real weight — on
   * mobile it is often the only one that fires at all.
   */
  const flush = async () => {
    save();
    await kernel.flush();
  };

  window.addEventListener(
    "beforeunload",
    () => {
      save();
      // Cannot await here, so this is a keepalive request rather than a flush.
      host.flushOnUnload();
    },
    { signal: teardown.signal }
  );
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") void flush();
    },
    { signal: teardown.signal }
  );
  const heartbeat = window.setInterval(save, 15000);

  async function signOut(): Promise<void> {
    // Order matters. Flush first, because after signout the session is gone
    // and the write would 401 into a warning about losing work that was in
    // fact already lost.
    try {
      await flush();
    } catch (err) {
      console.warn("[voidshell] could not save before signing out:", err);
    }
    try {
      await api.signout();
    } catch (err) {
      // The local teardown happens regardless: a user who asked to sign out
      // should not be left staring at their dashboard because a request failed.
      console.warn("[voidshell] signout request failed:", err);
    }
    signedOut();
  }

  await untilSignout;

  /* ---------------- teardown ---------------- */

  window.clearInterval(heartbeat);
  teardown.abort();
  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
  // Releases the WebGL context along with everything else. Without this, each
  // signout leaks one, and browsers cap them at around sixteen before they
  // start killing the oldest — the void goes black several signouts later,
  // somewhere that looks nothing like the cause.
  kernel.dispose();
  overlay.remove();
  hud.replaceChildren();
}

async function main() {
  const gl = document.getElementById("void")!;
  const hud = document.getElementById("hud")!;

  await runBootSequence();

  // Sign in, run, sign out, repeat. A loop rather than a reload so signing out
  // stays instant and the next session starts from a clean kernel.
  for (;;) {
    const saved = await openSession();
    await runShell(gl, hud, saved);
  }
}

main().catch((err) => console.error("[voidshell] failed to boot:", err));
