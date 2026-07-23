import type { ModuleManifest } from "../kernel/types";

interface SpawnerDeps {
  registry: () => ModuleManifest[];
  launch: (id: string) => void;
}

/**
 * No taskbar, no dock, no start menu. You summon a constellation of the
 * installed apps and pick one. The nodes fan out in an upward arc above the
 * core button so they never run off the bottom of the viewport, however many
 * apps are installed. Toggle with the button or the Space key.
 */
export function createSpawner(hud: HTMLElement, deps: SpawnerDeps): void {
  const root = document.createElement("div");
  root.className = "spawner";

  const summon = document.createElement("button");
  summon.className = "spawner-core";
  summon.setAttribute("aria-label", "Summon apps");
  summon.textContent = "\u25ce";

  const ring = document.createElement("div");
  ring.className = "spawner-ring";

  const hint = document.createElement("div");
  hint.className = "spawner-hint";
  hint.textContent =
    "space to summon \u00b7 drag the void to look around \u00b7 drag a title bar to move \u00b7 scroll to push away";

  root.append(ring, summon, hint);
  hud.appendChild(root);

  let open = false;

  const build = () => {
    ring.replaceChildren();
    const apps = deps.registry().filter((m) => m.kind === "app");
    const n = apps.length;
    const radius = 118;
    // Fan across an upward arc centred on straight-up (-90deg). Capped below a
    // half-turn so the outermost nodes never dip past horizontal.
    const spread = Math.min(Math.PI * 0.92, 0.5 * Math.PI + (n - 1) * 0.34);
    const start = -Math.PI / 2 - spread / 2;

    apps.forEach((m, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const angle = start + t * spread;
      const node = document.createElement("button");
      node.className = "spawner-node";
      node.style.setProperty("--x", `${(Math.cos(angle) * radius).toFixed(1)}px`);
      node.style.setProperty("--y", `${(Math.sin(angle) * radius).toFixed(1)}px`);
      node.title = m.name;
      node.innerHTML = `<span class="node-glyph">${m.glyph ?? "\u00b7"}</span><span class="node-name">${m.name}</span>`;
      node.addEventListener("click", () => {
        deps.launch(m.id);
        toggle(false);
      });
      ring.appendChild(node);
    });
  };

  const toggle = (next?: boolean) => {
    open = next ?? !open;
    root.classList.toggle("open", open);
    if (open) build();
  };

  summon.addEventListener("click", () => toggle());
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      toggle();
    }
    if (e.code === "Escape") toggle(false);
  });
}
