import "./style.css";
import { Kernel } from "./kernel/Kernel";
import { ThreeCompositor } from "./compositor/ThreeCompositor";
import { runBootSequence } from "./boot/bootSequence";
import { createSpawner } from "./ui/spawner";
import { terminal } from "./modules/terminal";
import { chronos } from "./modules/chronos";
import { auroraForge } from "./modules/aurora-forge";

async function main() {
  const gl = document.getElementById("void")!;
  const hud = document.getElementById("hud")!;

  // The CSS3D panel layer sits above the WebGL canvas, below the HUD.
  const overlay = document.createElement("div");
  overlay.id = "panel-layer";
  document.body.insertBefore(overlay, hud);

  // Pick your render backend here. This one line is the whole "renderer is a
  // plugin" story: swap ThreeCompositor for a DomCompositor and every module
  // above renders unchanged in a flat 2D world instead.
  const compositor = new ThreeCompositor();
  const kernel = new Kernel(compositor);

  kernel.register(terminal).register(chronos).register(auroraForge);

  // Panels emit a DOM event when their close button is hit; route it home.
  window.addEventListener("voidshell:close-surface", (e) => {
    const id = (e as CustomEvent<{ id: string }>).detail?.id;
    if (id) kernel.closeSurface(id);
  });

  await runBootSequence();
  await kernel.boot({ gl, overlay });

  createSpawner(hud, {
    registry: () => kernel.registry(),
    launch: (id) => kernel.launch(id),
  });

  // Give the fresh void something to hold so it doesn't open empty.
  kernel.launch("chronos");
}

main().catch((err) => console.error("[voidshell] failed to boot:", err));
