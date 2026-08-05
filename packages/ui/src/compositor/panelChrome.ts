import type { Surface } from "../kernel/types";
import type { MenuItem } from "../ui/contextMenu";
import { FORMS, PLAIN } from "./surfaceForms";

export const GROUP_COLORS = ["#4fe3d0", "#c05cff", "#ff8a5c", "#7ea8ff", "#5fd6a8"];

/**
 * The glass shell around a module's DOM.
 *
 * This used to be dead code. `ThreeCompositor.mountSurface` built its own panel
 * markup inline — similar to this, but not identical — and nothing called this
 * file at all, which is why window *shapes* were briefly implemented here and
 * did nothing whatsoever. Two functions that both look like they build the
 * panel, only one of which does, is a trap; the compositor calls this one now
 * and there is one place where a window's parts are decided.
 *
 * It stays purely structural — no state, no listeners beyond what the markup
 * needs — so the compositor stays about space and this stays about widgets.
 */

/** Which edges a panel can be dragged by. */
export type ResizeAxis = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const RESIZE_AXES: ResizeAxis[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const RESIZE_TITLES: Record<ResizeAxis, string> = {
  n: "drag to resize height",
  s: "drag to resize height",
  e: "drag to resize width",
  w: "drag to resize width",
  ne: "drag to resize",
  nw: "drag to resize",
  se: "drag to resize",
  sw: "drag to resize",
};

/** Every part of a mounted panel the compositor needs to wire behaviour to. */
export interface PanelChrome {
  panel: HTMLElement;
  bar: HTMLElement;
  /** Kept so the compositor can rename a live window without a DOM query. */
  title: HTMLElement;
  tools: HTMLElement;
  link: HTMLElement;
  grips: Record<ResizeAxis, HTMLElement>;
  more: HTMLButtonElement;
  pin: HTMLButtonElement;
  min: HTMLButtonElement;
  max: HTMLButtonElement;
  close: HTMLButtonElement;
}

export function createPanelChrome(surface: Surface): PanelChrome {
  const panel = document.createElement("div");
  panel.className = "vs-panel materializing";
  panel.style.width = `${surface.width}px`;
  panel.style.height = `${surface.height}px`;
  panel.dataset.surface = surface.id;

  const bar = document.createElement("div");
  bar.className = "vs-panel-bar";

  const link = document.createElement("button");
  link.className = "vs-panel-link";
  link.title = "drag onto another window to link · onto a body to merge";
  link.setAttribute("aria-label", "Link this window");
  link.textContent = "⁙";

  const title = document.createElement("span");
  title.className = "vs-panel-title";
  title.textContent = surface.title;

  const tools = document.createElement("div");
  tools.className = "vs-panel-tools";
  const more = tool("vs-panel-more", "⋯", "Window options");
  const pin = tool("vs-panel-pin", "◈", "Pin to screen");
  const min = tool("vs-panel-min", "–", "Collapse");
  const max = tool("vs-panel-max", "□", "Fill the screen");
  const close = tool("vs-panel-close", "✕", `Dismiss ${surface.title}`);
  tools.append(more, pin, min, max, close);

  bar.append(link, title, tools);

  const body = document.createElement("div");
  body.className = "vs-panel-content";
  body.appendChild(surface.element);

  // One grip per resize axis. Appended after the content so they stack above it
  // and stay grabbable no matter what the module rendered.
  const grips = {} as Record<ResizeAxis, HTMLElement>;
  for (const axis of RESIZE_AXES) {
    const g = document.createElement("div");
    g.className = `vs-panel-grip vs-grip-${axis}`;
    g.title = RESIZE_TITLES[axis];
    grips[axis] = g;
  }

  panel.append(bar, body, ...RESIZE_AXES.map((a) => grips[a]));
  return { panel, bar, title, tools, link, grips, more, pin, min, max, close };
}

/** What the menu needs to know about the window it belongs to. */
export interface MenuModel {
  pinned: boolean;
  minimized: boolean;
  snapped: boolean;
  merged: boolean;
  /** The silhouette it currently wears, or PLAIN for a glass panel. */
  form: string;
  group: { color: string; rigid: boolean } | null;
}

/** What the menu is allowed to do about it. */
export interface MenuActions {
  togglePin(): void;
  toggleMinimize(): void;
  toggleSnap(): void;
  snapLeft(): void;
  snapRight(): void;
  nudge(dir: number): void;
  release(): void;
  setForm(formId: string): void;
  setRigid(rigid: boolean): void;
  setColor(color: string): void;
  dissolve(): void;
  close(): void;
}

/**
 * The per-window menu, as items for the shared context menu.
 *
 * Everything offered here is a property of *this* window, or of the
 * constellation it belongs to. That's the dividing line: things scoped to a
 * window belong on the window, and only genuinely global state should cost you
 * a trip to a settings screen. Window shape used to be on the wrong side of it,
 * in Settings, assigned per module — so shaping one lava lamp shaped all of
 * them, and the way back was a screen a shape could hide.
 *
 * It builds `MenuItem[]` rather than its own DOM so that right-clicking a title
 * bar and right-clicking a desktop icon go through one menu implementation —
 * the previous version of this file grew a second one.
 */
export function panelMenuItems(model: MenuModel, actions: MenuActions): MenuItem[] {
  const shaped = model.form !== PLAIN;

  // First, and always present. It is the one entry that can undo a state which
  // hides every other way of undoing it, so it does not get to be conditional
  // and it does not get to be buried.
  const items: MenuItem[] = [
    { label: "window shape", submenu: shapeItems(model.form, actions.setForm) },
  ];

  // A shaped window is an object rather than a rectangle: there is no honest
  // way for a lava lamp to fill the left half of the screen, and nothing to
  // collapse to once the silhouette is drawn over the title bar. The compositor
  // refuses both; offering them here would be entries that quietly do nothing.
  if (!shaped) {
    items.push(
      {
        label: model.snapped ? "back into the void" : "fill the screen",
        action: actions.toggleSnap,
        separated: true,
      },
      { label: "fill the left half", action: actions.snapLeft },
      { label: "fill the right half", action: actions.snapRight }
    );
  }

  items.push({
    label: model.pinned ? "unpin from screen" : "pin to screen",
    action: actions.togglePin,
    separated: true,
  });

  if (!shaped) {
    items.push({
      label: model.minimized ? "expand" : "collapse",
      action: actions.toggleMinimize,
    });
  }

  // Depth is meaningless for a window that has left the world, so the two
  // controls that only move it through space drop out rather than sit there
  // doing nothing.
  if (!model.snapped && !model.pinned) {
    items.push(
      { label: "pull closer", action: () => actions.nudge(-1) },
      { label: "push away", action: () => actions.nudge(1) }
    );
  }
  if (model.merged) items.push({ label: "release from orbit", action: actions.release });

  const g = model.group;
  if (g) {
    items.push(
      {
        label: g.rigid ? "loosen the link" : "harden the link",
        action: () => actions.setRigid(!g.rigid),
        separated: true,
      },
      {
        label: "constellation colour",
        swatches: {
          colors: GROUP_COLORS,
          current: g.color,
          onPick: actions.setColor,
        },
      },
      { label: "dissolve constellation", action: actions.dissolve }
    );
  }

  items.push({ label: "close window", action: actions.close, danger: true, separated: true });
  return items;
}

/**
 * Every shape, with a tick against the one in force.
 *
 * "glass panel" leads rather than trailing the list: it is the way out, and the
 * person reaching for it is the person who just made a window they can't read.
 */
function shapeItems(current: string, setForm: (formId: string) => void): MenuItem[] {
  const mark = (id: string, label: string) =>
    `${current === id ? "\u2713 " : "\u2002 "}${label}`;
  return [
    { label: mark(PLAIN, "glass panel"), action: () => setForm(PLAIN) },
    ...FORMS.map((f) => ({
      label: mark(f.id, f.label),
      action: () => setForm(f.id),
    })),
  ];
}

function tool(cls: string, glyph: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `vs-panel-tool ${cls}`;
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}
