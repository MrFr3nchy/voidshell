import "./style.css";
import "./ui/canvasStage.css";
import "./compositor/domCompositor.css";
import "./ui/appShelves.css";
import "./ui/surfaceForms.css";
import "./modules/devkit/devkit.css";
import "./modules/copilot/copilot.css";
import "./modules/cartograph/cartograph.css";
import "./modules/pawnageddon/pawnageddon.css";
import "./modules/workspace/workspace.css";
import { Kernel } from "./kernel/Kernel";
import { ApiWorkspaceHost, ApiError, api } from "./kernel/apiWorkspace";
import type { ShellHost } from "./kernel/persistence";
import { GUEST_KEY, GuestWorkspaceHost } from "./kernel/guest";
import {
  ImportError,
  parseWorkspaceFile,
  serialiseWorkspace,
  summarise,
  workspaceFilename,
} from "./kernel/workspaceFile";
import {
  BACKEND_KEY,
  chooseBackend,
  createCompositor,
  webglAvailable,
} from "./compositor/select";
import { runBootSequence } from "./boot/bootSequence";
import { createSpawner } from "./ui/spawner";
import { createAppDrawer } from "./ui/appDrawer";
import { createPalette } from "./ui/palette";
import { createToasts } from "./ui/toasts";
import { createStatusBar } from "./ui/statusBar";
import { createPower } from "./ui/power";
import { runLockScreen, type Session } from "./ui/lockScreen";
import { monitor } from "./modules/monitor";
import { portal } from "./modules/portal";
import { workspace } from "./modules/workspace";
import { editor } from "./modules/editor";
import { webapp } from "./modules/webapp";
import { desktop } from "./modules/desktop";
import { trash } from "./modules/trash";
import { calendar } from "./modules/calendar";
import { buildProjectsTree } from "./kernel/vfs";
import { loadProjects } from "virtual:voidshell-projects";
import { aurora } from "./modules/aurora";
import { horizon } from "./modules/horizon";
import { shell, RESTORE_KEY } from "./modules/shell";
import { settings } from "./modules/settings";
import { notes } from "./modules/notes";
import { vitals } from "./modules/vitals";
import { arcade } from "./modules/arcade";
import { cartograph } from "./modules/cartograph";
import { pawnageddon } from "./modules/pawnageddon";
import { createDevkit } from "./modules/devkit";
import { copilot } from "./modules/copilot";
import { whenReady } from "./modules/devkit/protocol";

/**
 * Whether this build was made with no server to talk to.
 *
 * Set at build time (`VITE_VOIDSHELL_GUEST=1`) for the published demo, which
 * is a static bundle on a host that has no API half at all. Probing `/api` in
 * that build asks a question with one possible answer and pays a failed
 * request and a "can't reach the server" screen to hear it — so it is skipped
 * and the shell opens straight into a guest session.
 *
 * Optional chaining because the headless harnesses bundle this tree with
 * esbuild and run it under Node, where `import.meta` exists and `env` does not.
 */
const GUEST_ONLY = import.meta.env?.VITE_VOIDSHELL_GUEST === "1";

/**
 * Get a dashboard, one way or another.
 *
 * Returns only once there is a session. Nothing that follows — no compositor,
 * no WebGL context, no module — is constructed before this resolves, which is
 * the difference between a lock screen and a login form drawn over a running
 * OS that has already leaked what it contains.
 */
/**
 * A workspace waiting to be booted into, set by an import.
 *
 * Importing replaces everything, which is a soft reboot however it is done —
 * hydrating a running kernel would mean settings subscribers firing under open
 * windows that hold files about to be replaced. The shell already has a clean
 * teardown-and-rebuild path, because signing out is one, so an import sets this
 * and signs out; the loop in `main` comes straight back with the new workspace.
 *
 * That also makes import work for a *guest*, which a reload cannot: a guest who
 * reloaded would land in a fresh empty void, having imported nothing.
 */
let pendingImport: Session | null = null;

async function openSession(): Promise<Session> {
  if (pendingImport) {
    const next = pendingImport;
    pendingImport = null;
    return next;
  }
  if (GUEST_ONLY) return { workspace: { state: {}, fs: null }, guest: true };
  try {
    return { workspace: (await api.session()).workspace, guest: false };
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
async function runShell(gl: HTMLElement, hud: HTMLElement, session: Session): Promise<void> {
  const { workspace: saved, guest } = session;

  // Starts silent: there is no toast system until the kernel is up, and a
  // save can fail before then. Upgraded to real toasts a few lines below.
  //
  // A guest gets the same kernel over a host that keeps the snapshot in the
  // tab. Everything downstream — the heartbeat, the unload flush, the signout
  // path — calls the same two methods and never learns which one it has.
  const host: ShellHost = guest ? new GuestWorkspaceHost() : new ApiWorkspaceHost();

  // The panel overlay sits above the WebGL canvas, below the HUD. It ignores
  // pointer events itself so drags on empty space reach the canvas; the panels
  // inside it re-enable pointer events and are fully interactive DOM.
  const overlay = document.createElement("div");
  overlay.id = "panel-layer";
  document.body.insertBefore(overlay, hud);

  // Pick your render backend. This used to be a literal `new ThreeCompositor()`
  // under a comment promising that swapping it for a DomCompositor would make
  // every module render unchanged in a flat world. There is a DomCompositor
  // now, so the promise is code instead of a comment — and the choice moved out
  // of the source, because the person who most needs the flat one is the person
  // whose browser cannot run the other, and they are not holding a checkout.
  //
  // Read off `saved.state` rather than the kernel's store because the kernel
  // does not exist yet: it is constructed *with* a compositor. The snapshot is
  // the same data, one hydrate earlier.
  const backend = chooseBackend(saved.state ?? {}, location.search, webglAvailable());
  const compositor = createCompositor(backend.id);
  const kernel = new Kernel(compositor, host);

  // Before register(), and so before any defineSetting() seeds a default over
  // a value the user actually chose.
  kernel.hydrate(saved);

  // Also before register(), for a second reason: a module reads this in
  // `activate` to decide what to call things. The shell publishes "sign out"
  // as a settings action and a command, and in a session with no account
  // behind it that label describes something that cannot happen.
  if (guest) kernel.context().state.set(GUEST_KEY, true);

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
    .register(calendar)
    .register(settings)
    .register(notes)
    .register(vitals)
    .register(monitor)
    .register(portal)
    .register(arcade)
    .register(cartograph)
    .register(pawnageddon)
    .register(devkit)
    // The ambient apps used to be registered here. They now ship as source in
    // stock.generated.ts, are planted in ~/modules on first run, and are loaded
    // by devkit like anything else the user wrote — see tools/emit-modules.mts.
    .register(copilot);

  /**
   * Start fetching the project scan, but do not wait for it here.
   *
   * This used to be awaited before `boot()`, which made a source tree the
   * first thing between the user and a compositor — and on the demo that tree
   * is voidshell's own, several megabytes of it. Nothing up to the point where
   * a session is restored needs /projects, so the download now overlaps
   * building a WebGL context and activating nineteen modules instead of
   * queueing in front of them.
   *
   * Deliberately not fatal, exactly as before: a shell without /projects is
   * still a shell, and one that refuses to boot over a missing side mount is a
   * bug. Caught here rather than at the await so a rejection can never race
   * ahead of its handler and surface as an unhandled rejection.
   */
  const projectsScan = loadProjects().catch((err: unknown) => {
    console.warn("[voidshell] /projects not mounted:", err);
    return null;
  });

  /**
   * Graft it into the tree, whenever it turns up.
   *
   * Mounting fires the filesystem's change event, so a Files window that
   * opened before this resolves picks /projects up on its own rather than
   * showing a tree it will never refresh.
   */
  const mountProjects = async (): Promise<void> => {
    const snapshot = await projectsScan;
    if (!snapshot?.projects.length) return;
    kernel.fs.mount("/projects", buildProjectsTree(snapshot));
    console.info(
      `[voidshell] mounted /projects — ${snapshot.projects.length} projects, ` +
        `${snapshot.entries.length} entries`
    );
  };

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
        guest
          ? "This is a real filesystem, but you are a guest: it lives in this"
          : "This is a real filesystem. Your files here persist across reloads;",
        guest
          ? "tab and goes when the tab does. /projects is a read-only mount."
          : "/projects is a read-only mount of the source on disk.",
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

  ctx.log(`compositor: ${compositor.name} (${backend.reason})`);
  // Said out loud only when the machine overrode a choice the user made. A
  // default is not news, and a URL override is something you did on purpose
  // one second ago.
  if (backend.reason === "fallback" && (saved.state ?? {})[BACKEND_KEY] === "three") {
    ctx.notify("No WebGL here \u2014 opened the flat compositor instead.", {
      kind: "warn",
      action: { label: "see the render setting", run: (c) => c.launch("settings") },
    });
  }

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

  /**
   * Write this void out as a file.
   *
   * `saveSession` first: window positions live in the compositor until
   * something asks for them, so an export taken without it describes the
   * arrangement as of the last heartbeat rather than the one on screen.
   */
  ctx.on("shell.exportWorkspace", () => {
    kernel.saveSession();
    const snapshot = kernel.snapshot();
    const blob = new Blob([serialiseWorkspace(snapshot)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = workspaceFilename();
    a.click();
    // Revoked on the next turn rather than immediately: the click is
    // synchronous but the fetch the browser starts for it is not.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

    const { files, settings } = summarise(snapshot);
    ctx.notify(`exported ${files} file${files === 1 ? "" : "s"} and ${settings} settings`, "good");
  });

  /**
   * Read one back.
   *
   * Two steps on purpose. Picking a file only *reads* it; nothing is replaced
   * until the notice's offer is taken, and the notice says what is in the file
   * and what is about to be lost. An import is the most destructive thing the
   * shell can do that isn't called "wipe everything", and it is the one where a
   * misclick costs somebody a workspace.
   */
  ctx.on("shell.importWorkspace", () => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "application/json,.json";
    picker.addEventListener("change", () => {
      const file = picker.files?.[0];
      if (!file) return;
      void file
        .text()
        .then((text) => {
          const parsed = parseWorkspaceFile(text);
          const incoming = summarise(parsed.workspace);
          const current = summarise(kernel.snapshot());
          ctx.notify(
            `“${file.name}” holds ${incoming.files} file${incoming.files === 1 ? "" : "s"} ` +
              `and ${incoming.settings} settings. Replacing this void discards ` +
              `${current.files} file${current.files === 1 ? "" : "s"} here.`,
            {
              kind: "warn",
              action: {
                label: "replace this void",
                run: () => {
                  pendingImport = { workspace: parsed.workspace, guest };
                  // A reboot, not a logout — see signOut.
                  void signOut(false);
                },
              },
            }
          );
        })
        .catch((err: unknown) => {
          // The message is the whole point: an import that fails without
          // saying why leaves somebody holding their only copy of something
          // and no idea what is wrong with it.
          ctx.notify(err instanceof ImportError ? err.message : `Couldn't read that file: ${String(err)}`, "warn");
        });
    });
    picker.click();
  });

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

  // Everything below opens windows *by module id*, and most of the apps are no
  // longer compiled in — devkit is still evaluating them when boot() returns.
  // Restoring a session, running autostart, or opening the default clock before
  // that finishes asks the kernel for a module it does not have yet, and the
  // user's first sight of the shell is `no module "chronos"`.
  await whenReady(ctx);

  // Before anything reopens a window. A restored editor holding a file under
  // /projects, or an autostart entry pointing at one, has to find it there —
  // this is the last moment that is true, which is why the wait is here and
  // not next to the fetch.
  await mountProjects();

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
  //
  // A guest gets Files instead of the clock, because their first boot is
  // somebody's first sight of the whole project and Files is the window that
  // shows this is an OS rather than a screensaver: a real tree, a console, and
  // the shell's own source mounted under /projects.
  //
  // One window, not two. An earlier version opened both and arranged them in an
  // arc, which reads fine as a description and not at all on a screen — the
  // formations in `arrange` space windows by a fixed angle, so they assume
  // every window is roughly one size. Files opens at 960px and projects to
  // ~1170 at a 1600px viewport, so the arc put the clock behind it and the
  // first thing anyone saw was one window bleeding through another's backdrop
  // blur. There is no placement that fits both on a laptop; there is a good
  // one that fits either.
  if (!restored && !autostarted) kernel.launch(guest ? "workspace" : "chronos");

  if (guest) {
    ctx.log("guest session \u2014 nothing is being saved");
    ctx.notify("You\u2019re a guest \u2014 this void is yours until the tab closes.", {
      kind: "info",
      action: { label: "see every app", run: (c) => c.emit("shell.openDrawer") },
    });
  }

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

  /**
   * End this session and let the loop in `main` start the next one.
   *
   * `endSession` separates the two callers, and the distinction is not
   * cosmetic. Signing out means "end my session on the server". An *import*
   * means "throw this kernel away and build another one" — a local reboot,
   * with the account left exactly as it was. Calling `api.signout` for an
   * import would leave somebody imported into a workspace their cookie no
   * longer authorises them to save.
   */
  async function signOut(endSession = true): Promise<void> {
    // Order matters. Flush first, because after signout the session is gone
    // and the write would 401 into a warning about losing work that was in
    // fact already lost.
    try {
      await flush();
    } catch (err) {
      console.warn("[voidshell] could not save before signing out:", err);
    }
    try {
      // Nothing to end server-side for a guest, and the request would 401 into
      // a warning about a session that never existed.
      if (endSession && !guest) await api.signout();
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
