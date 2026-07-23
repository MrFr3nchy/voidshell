import type { KernelContext } from "../kernel/types";

export const SLOTS_KEY = "launcher.slots";
export const COUNT_KEY = "launcher.count";
export const RADIUS_KEY = "launcher.radius";
export const ALLAPPS_KEY = "launcher.showAllApps";
export const HINT_KEY = "launcher.showHint";

/** The most nodes we'll ever fan out; past this the arc turns into soup. */
export const MAX_SLOTS = 10;

/**
 * Work out which apps should sit in the ring. Stored bindings win; anything
 * missing is back-filled from the registry so a fresh install is never an
 * empty ring, and a rebound slot never leaves a hole.
 */
export function resolveSlots(ctx: KernelContext): string[] {
  const apps = ctx.registry().filter((m) => m.kind === "app");
  const count = Math.max(1, Math.min(MAX_SLOTS, ctx.state.get<number>(COUNT_KEY, 6)));
  const saved = ctx.state.get<string[]>(SLOTS_KEY, []);
  const out: string[] = [];

  for (let i = 0; i < count; i++) {
    const want = saved[i];
    if (want && apps.some((a) => a.id === want)) out.push(want);
    else {
      const fill = apps.find((a) => !out.includes(a.id)) ?? apps[0];
      out.push(fill ? fill.id : "");
    }
  }
  return out.filter(Boolean);
}

interface Spawner {
  toggle(next?: boolean): void;
  rebuild(): void;
}

/**
 * No taskbar, no dock, no start menu. You summon a constellation of the
 * installed apps and pick one. The nodes fan out in an upward arc above the
 * core button so they never run off the bottom of the viewport, however many
 * apps are installed.
 *
 * Two things make it a launcher rather than a menu: every node is rebindable
 * (Settings > Launcher, or drop an app onto it from the drawer), and you can
 * drag a node straight off the ring and into the void to open that app exactly
 * where you let go.
 */
export function createSpawner(
  hud: HTMLElement,
  ctx: KernelContext,
  onShowAll: () => void
): Spawner {
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
    "space \u00b7 summon  \u2022  \u2318K \u00b7 command  \u2022  drag void \u00b7 look  \u2022  \u2059 \u00b7 link windows";

  root.append(ring, summon, hint);
  hud.appendChild(root);

  let open = false;

  const build = () => {
    ring.replaceChildren();
    const registry = ctx.registry();
    const slots = resolveSlots(ctx);
    const showAll = ctx.state.get<boolean>(ALLAPPS_KEY, true);
    const radius = ctx.state.get<number>(RADIUS_KEY, 118);

    interface NodeSpec {
      glyph: string;
      name: string;
      slot: number;
      moduleId?: string;
    }
    const specs: NodeSpec[] = slots.map((id, i) => {
      const m = registry.find((r) => r.id === id);
      return {
        glyph: m?.glyph ?? "\u00b7",
        name: m?.name ?? id,
        slot: i,
        moduleId: id,
      };
    });
    if (showAll) specs.push({ glyph: "\u2237", name: "all apps", slot: -1 });

    const n = specs.length;
    // Fan across an upward arc centred on straight-up (-90deg). Capped below a
    // half-turn so the outermost nodes never dip past horizontal.
    const spread = Math.min(Math.PI * 0.92, 0.5 * Math.PI + (n - 1) * 0.34);
    const start = -Math.PI / 2 - spread / 2;

    specs.forEach((spec, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const angle = start + t * spread;
      const node = document.createElement("button");
      node.className = "spawner-node";
      if (spec.slot < 0) node.classList.add("is-all");
      node.style.setProperty("--x", `${(Math.cos(angle) * radius).toFixed(1)}px`);
      node.style.setProperty("--y", `${(Math.sin(angle) * radius).toFixed(1)}px`);
      node.style.setProperty("--delay", `${(i * 22).toFixed(0)}ms`);
      node.title =
        spec.slot < 0 ? "every installed module" : `${spec.name} \u2014 drag into the void to place it`;
      if (spec.slot >= 0) node.dataset.slot = String(spec.slot);
      node.innerHTML = `<span class="node-glyph">${spec.glyph}</span><span class="node-name">${escapeHtml(
        spec.name
      )}</span>`;

      bindNode(node, spec.slot, spec.moduleId);
      ring.appendChild(node);
    });
  };

  /**
   * A node is a button when you click it and a payload when you drag it. The
   * threshold keeps a slightly shaky click from turning into a spawn.
   */
  const bindNode = (
    node: HTMLButtonElement,
    slot: number,
    moduleId: string | undefined
  ) => {
    let downX = 0;
    let downY = 0;
    let dragging = false;
    let suppressClick = false;
    let ghost: HTMLElement | null = null;

    node.addEventListener("pointerdown", (e) => {
      downX = e.clientX;
      downY = e.clientY;
      dragging = false;
      node.setPointerCapture(e.pointerId);
    });

    node.addEventListener("pointermove", (e) => {
      if (slot < 0 || !moduleId) return;
      if (!dragging && Math.hypot(e.clientX - downX, e.clientY - downY) < 10) return;
      if (!dragging) {
        dragging = true;
        ghost = makeGhost(node.querySelector(".node-glyph")?.textContent ?? "\u00b7");
        document.body.appendChild(ghost);
        root.classList.add("dragging-node");
      }
      if (ghost) {
        ghost.style.left = `${e.clientX}px`;
        ghost.style.top = `${e.clientY}px`;
      }
    });

    const finish = (e: PointerEvent) => {
      node.releasePointerCapture?.(e.pointerId);
      root.classList.remove("dragging-node");
      ghost?.remove();
      ghost = null;

      if (dragging && moduleId) {
        dragging = false;
        // pointerup on a captured element still emits click; swallow that one.
        suppressClick = true;
        ctx.launchAt(moduleId, e.clientX, e.clientY);
        toggle(false);
        return;
      }
      dragging = false;
    };

    node.addEventListener("pointerup", finish);
    node.addEventListener("pointercancel", (e) => {
      ghost?.remove();
      ghost = null;
      dragging = false;
      root.classList.remove("dragging-node");
      node.releasePointerCapture?.(e.pointerId);
    });

    node.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (slot < 0) {
        onShowAll();
      } else if (moduleId) {
        ctx.launch(moduleId);
      }
      // Drop focus so a held or repeated Enter can't re-fire this button.
      node.blur();
      toggle(false);
    });
  };

  const toggle = (next?: boolean) => {
    open = next ?? !open;
    root.classList.toggle("open", open);
    if (open) build();
  };

  summon.addEventListener("click", () => toggle());

  // Any of these settings changing should reshape the ring immediately.
  for (const key of [SLOTS_KEY, COUNT_KEY, RADIUS_KEY, ALLAPPS_KEY]) {
    ctx.state.subscribe(key, () => {
      if (open) build();
    });
  }
  const applyHint = () =>
    hint.classList.toggle("hidden", !ctx.state.get<boolean>(HINT_KEY, true));
  ctx.state.subscribe(HINT_KEY, applyHint);
  applyHint();

  return { toggle, rebuild: build };
}

function makeGhost(glyph: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "spawner-ghost";
  el.textContent = glyph;
  return el;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] ?? c
  );
}
