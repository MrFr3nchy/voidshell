import "./style.css";
import "./ui/canvasStage.css";
import { Kernel } from "./kernel/Kernel";
import { ThreeCompositor } from "./compositor/ThreeCompositor";
import { runBootSequence } from "./boot/bootSequence";
import { createSpawner } from "./ui/spawner";
import { createAppDrawer } from "./ui/appDrawer";
import { createPalette } from "./ui/palette";
import { createToasts } from "./ui/toasts";
import { createStatusBar } from "./ui/statusBar";
import { createPower } from "./ui/power";
import { monitor } from "./modules/monitor";
import { portal } from "./modules/portal";
import { workspace } from "./modules/workspace";
import { chronos } from "./modules/chronos";
import { cosmos } from "./modules/cosmos";
import { editor } from "./modules/editor";
import { webapp } from "./modules/webapp";
import { desktop } from "./modules/desktop";
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

async function main() {
  const gl = document.getElementById("void")!;
  const hud = document.getElementById("hud")!;

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
  const kernel = new Kernel(compositor);

  kernel
    // services and world modules first — they publish settings the apps read
    .register(aurora)
    .register(horizon)
    .register(shell)
    // apps
    // Before the editor: it claims "dir", so directories open here rather than
    // falling through to the editor's "*" catch-all.
    .register(workspace)
    .register(webapp)
    .register(editor)
    .register(desktop)
    .register(chronos)
    .register(cosmos)
    .register(settings)
    .register(dashboards)
    .register(notes)
    .register(vitals)
    .register(monitor)
    .register(portal)
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
    .register(sunclock);

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

  await runBootSequence();
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
  ctx.on("shell.factoryReset", () => {
    resetting = true;
    kernel.factoryReset();
    location.reload();
  });

  /* ---------------- keybinds ---------------- */

  const typing = (t: EventTarget | null) =>
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement;

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
    if (mod && e.key === ",") {
      e.preventDefault();
      kernel.launch("settings");
      return;
    }
    if (e.key === "Escape") {
      palette.toggle(false);
      drawer.toggle(false);
      spawner.toggle(false);
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
  window.addEventListener("beforeunload", save);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
  window.setInterval(save, 15000);
}

main().catch((err) => console.error("[voidshell] failed to boot:", err));
