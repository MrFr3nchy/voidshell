import "./style.css";
import { Kernel } from "./kernel/Kernel";
import { ThreeCompositor } from "./compositor/ThreeCompositor";
import { runBootSequence } from "./boot/bootSequence";
import { createSpawner } from "./ui/spawner";
import { terminal } from "./modules/terminal";
import { chronos } from "./modules/chronos";
import { auroraForge } from "./modules/aurora-forge";
import { cosmos } from "./modules/cosmos";
import { files } from "./modules/files";
import { editor } from "./modules/editor";
import { runner } from "./modules/runner";
import { webapp } from "./modules/webapp";
import { desktop } from "./modules/desktop";
import { buildProjectsTree } from "./kernel/vfs";
import { loadProjects } from "virtual:voidshell-projects";

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
    .register(terminal)
    .register(files)
    // Before the editor: both claim .py/.js, and first match wins, so
    // double-clicking a script runs it rather than opening it for editing.
    .register(runner)
    .register(webapp)
    .register(editor)
    .register(desktop)
    .register(chronos)
    .register(auroraForge)
    .register(cosmos);

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
  await kernel.boot({ gl, overlay });

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

  createSpawner(hud, {
    registry: () => kernel.registry(),
    launch: (id) => kernel.launch(id),
  });

  // Give the fresh void something to hold so it doesn't open empty.
  kernel.launch("chronos");
}

main().catch((err) => console.error("[voidshell] failed to boot:", err));
