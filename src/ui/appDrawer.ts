import type { KernelContext, ModuleManifest } from "../kernel/types";
import { COUNT_KEY, MAX_SLOTS, SLOTS_KEY, escapeHtml, resolveSlots } from "./spawner";

interface DrawerDeps {
  /** Opening the ring mid-drag is what makes "drop onto a node" possible. */
  openRing: (open: boolean) => void;
}

export interface AppDrawer {
  toggle(next?: boolean): void;
  isOpen(): boolean;
}

/**
 * Everything installed, in one grid, with a search box.
 *
 * A tile is three affordances at once: click to launch, drag into the void to
 * launch it exactly where you drop it, or drag it onto a launcher node to
 * rebind that node to this app. No settings screen required for the common case.
 */
export function createAppDrawer(
  hud: HTMLElement,
  ctx: KernelContext,
  deps: DrawerDeps
): AppDrawer {
  const root = document.createElement("div");
  root.className = "drawer";
  root.innerHTML = `
    <div class="drawer-sheet">
      <div class="drawer-head">
        <div class="drawer-title">all apps</div>
        <input class="drawer-search" type="text" placeholder="search modules\u2026" aria-label="Search modules" />
        <button class="drawer-close" aria-label="Close">\u2715</button>
      </div>
      <div class="drawer-grid"></div>
      <div class="drawer-foot">click to launch \u00b7 drag into the void to place \u00b7 drag onto a launcher node to rebind it</div>
    </div>`;
  hud.appendChild(root);

  const sheet = root.querySelector(".drawer-sheet") as HTMLElement;
  const grid = root.querySelector(".drawer-grid") as HTMLElement;
  const search = root.querySelector(".drawer-search") as HTMLInputElement;
  const closeBtn = root.querySelector(".drawer-close") as HTMLButtonElement;

  let open = false;
  let filter = "";

  const build = () => {
    grid.replaceChildren();
    const q = filter.trim().toLowerCase();
    const mods = ctx
      .registry()
      .filter((m) => !q || `${m.name} ${m.id} ${m.blurb ?? ""}`.toLowerCase().includes(q))
      .sort(byKindThenName);

    if (!mods.length) {
      const empty = document.createElement("div");
      empty.className = "drawer-empty";
      empty.textContent = "nothing matches that";
      grid.appendChild(empty);
      return;
    }

    for (const m of mods) grid.appendChild(makeTile(m));
  };

  const makeTile = (m: ModuleManifest): HTMLElement => {
    const tile = document.createElement("button");
    tile.className = `drawer-tile kind-${m.kind}`;
    tile.innerHTML = `
      <span class="tile-glyph">${m.glyph ?? "\u00b7"}</span>
      <span class="tile-name">${escapeHtml(m.name)}</span>
      <span class="tile-blurb">${escapeHtml(m.blurb ?? m.kind)}</span>`;

    if (m.kind !== "app") {
      tile.disabled = true;
      tile.title = `${m.name} is a ${m.kind} module \u2014 it has no window of its own`;
      return tile;
    }

    let downX = 0;
    let downY = 0;
    let dragging = false;
    let suppressClick = false;
    let ghost: HTMLElement | null = null;

    tile.addEventListener("pointerdown", (e) => {
      downX = e.clientX;
      downY = e.clientY;
      dragging = false;
      tile.setPointerCapture(e.pointerId);
    });

    tile.addEventListener("pointermove", (e) => {
      if (!dragging && Math.hypot(e.clientX - downX, e.clientY - downY) < 10) return;
      if (!dragging) {
        dragging = true;
        ghost = document.createElement("div");
        ghost.className = "spawner-ghost";
        ghost.textContent = m.glyph ?? "\u00b7";
        document.body.appendChild(ghost);
        // Get the sheet out of the way so the void and the ring are droppable.
        root.classList.add("passthrough");
        deps.openRing(true);
      }
      if (ghost) {
        ghost.style.left = `${e.clientX}px`;
        ghost.style.top = `${e.clientY}px`;
      }
      const slot = slotUnder(e.clientX, e.clientY);
      root.classList.toggle("over-slot", slot !== null);
    });

    const finish = (e: PointerEvent) => {
      tile.releasePointerCapture?.(e.pointerId);
      ghost?.remove();
      ghost = null;
      root.classList.remove("passthrough", "over-slot");
      if (!dragging) return;
      dragging = false;
      // pointerup on a captured element still emits click; swallow that one.
      suppressClick = true;

      const slot = slotUnder(e.clientX, e.clientY);
      if (slot !== null) {
        bindSlot(ctx, slot, m.id);
        ctx.notify(`node ${slot + 1} \u2192 ${m.name}`, "good");
        toggle(false);
        return;
      }
      deps.openRing(false);
      ctx.launchAt(m.id, e.clientX, e.clientY);
      toggle(false);
    };

    tile.addEventListener("pointerup", finish);
    tile.addEventListener("pointercancel", () => {
      ghost?.remove();
      ghost = null;
      dragging = false;
      root.classList.remove("passthrough", "over-slot");
    });

    tile.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      ctx.launch(m.id);
      toggle(false);
    });

    return tile;
  };

  const toggle = (next?: boolean) => {
    open = next ?? !open;
    root.classList.toggle("open", open);
    if (open) {
      filter = "";
      search.value = "";
      build();
      requestAnimationFrame(() => search.focus());
    } else {
      deps.openRing(false);
    }
  };

  search.addEventListener("input", () => {
    filter = search.value;
    build();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") toggle(false);
    if (e.key === "Enter") {
      const first = grid.querySelector<HTMLButtonElement>(".drawer-tile:not(:disabled)");
      first?.click();
    }
  });
  closeBtn.addEventListener("click", () => toggle(false));
  root.addEventListener("pointerdown", (e) => {
    if (!sheet.contains(e.target as Node)) toggle(false);
  });

  return { toggle, isOpen: () => open };
}

/** Which launcher node, if any, is under this point right now? */
function slotUnder(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y);
  const node = (el as HTMLElement | null)?.closest?.(".spawner-node[data-slot]");
  if (!node) return null;
  const slot = Number((node as HTMLElement).dataset.slot);
  return Number.isFinite(slot) ? slot : null;
}

/** Persist a slot binding, growing the ring if the slot list is short. */
export function bindSlot(ctx: KernelContext, slot: number, moduleId: string): void {
  const slots = resolveSlots(ctx);
  const count = Math.max(1, Math.min(MAX_SLOTS, ctx.state.get<number>(COUNT_KEY, 6)));
  while (slots.length < count) slots.push(moduleId);
  slots[slot] = moduleId;
  ctx.state.set(SLOTS_KEY, slots.slice(0, count));
}

function byKindThenName(a: ModuleManifest, b: ModuleManifest): number {
  const rank = (m: ModuleManifest) => (m.kind === "app" ? 0 : 1);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}
