import type { ModuleManifest } from "../kernel/types";

interface SpawnerDeps {
  registry: () => ModuleManifest[];
  launch: (id: string) => void;
}

/**
 * No taskbar, no dock, no start menu. You summon a constellation of the
 * installed apps around a center point and pick one. Toggle with the ◎ button
 * or the Space key. Only "app" modules surface here — world and service
 * modules stay invisible, exactly like daemons.
 */
export function createSpawner(hud: HTMLElement, deps: SpawnerDeps): void {
  const root = document.createElement("div");
  root.className = "spawner";

  const summon = document.createElement("button");
  summon.className = "spawner-core";
  summon.setAttribute("aria-label", "Summon apps");
  summon.textContent = "◎";

  const ring = document.createElement("div");
  ring.className = "spawner-ring";

  const hint = document.createElement("div");
  hint.className = "spawner-hint";
  hint.textContent = "space to summon · drag the void to look around";

  root.append(ring, summon, hint);
  hud.appendChild(root);

  let open = false;

  const build = () => {
    ring.replaceChildren();
    const apps = deps.registry().filter((m) => m.kind === "app");
    const n = apps.length;
    apps.forEach((m, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const radius = 96;
      const node = document.createElement("button");
      node.className = "spawner-node";
      node.style.setProperty("--x", `${Math.cos(angle) * radius}px`);
      node.style.setProperty("--y", `${Math.sin(angle) * radius}px`);
      node.title = m.name;
      node.innerHTML = `<span class="node-glyph">${m.glyph ?? "·"}</span><span class="node-name">${m.name}</span>`;
      node.addEventListener("click", () => {
        deps.launch(m.id);
        node.blur(); // drop focus so a held or repeated Enter can't re-fire this button
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
