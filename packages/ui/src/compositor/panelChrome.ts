import type { Surface } from "../kernel/types";

export const GROUP_COLORS = ["#4fe3d0", "#c05cff", "#ff8a5c", "#7ea8ff", "#5fd6a8"];

/** Every part of a mounted panel the compositor needs to wire behaviour to. */
export interface PanelChrome {
  panel: HTMLElement;
  bar: HTMLElement;
  tools: HTMLElement;
  link: HTMLElement;
  grip: HTMLElement;
  menu: HTMLElement;
  more: HTMLButtonElement;
  pin: HTMLButtonElement;
  min: HTMLButtonElement;
  close: HTMLButtonElement;
}

/**
 * Build the glass shell around a module's DOM. Purely structural — no state,
 * no listeners beyond what the markup needs — so the compositor stays about
 * space and this stays about widgets.
 */
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
  link.title = "drag onto another window to link \u00b7 onto a body to merge";
  link.setAttribute("aria-label", "Link this window");
  link.textContent = "\u2059";

  const title = document.createElement("span");
  title.className = "vs-panel-title";
  title.textContent = surface.title;

  const tools = document.createElement("div");
  tools.className = "vs-panel-tools";
  const more = tool("vs-panel-more", "\u22ef", "Window options");
  const pin = tool("vs-panel-pin", "\u25c8", "Pin to screen");
  const min = tool("vs-panel-min", "\u2013", "Collapse");
  const close = tool("vs-panel-close", "\u2715", `Dismiss ${surface.title}`);
  tools.append(more, pin, min, close);

  bar.append(link, title, tools);

  const body = document.createElement("div");
  body.className = "vs-panel-content";
  body.appendChild(surface.element);

  const grip = document.createElement("div");
  grip.className = "vs-panel-grip";
  grip.title = "drag to resize";

  const menu = document.createElement("div");
  menu.className = "vs-menu";

  panel.append(bar, body, grip, menu);
  return { panel, bar, tools, link, grip, menu, more, pin, min, close };
}

/** What the menu needs to know about the window it belongs to. */
export interface MenuModel {
  pinned: boolean;
  minimized: boolean;
  merged: boolean;
  group: { color: string; rigid: boolean } | null;
}

/** What the menu is allowed to do about it. */
export interface MenuActions {
  togglePin(): void;
  toggleMinimize(): void;
  nudge(dir: number): void;
  release(): void;
  setRigid(rigid: boolean): void;
  setColor(color: string): void;
  dissolve(): void;
  close(): void;
  /** Re-render in place, for controls that change the model as you use them. */
  refresh(): void;
  /** Dismiss after an action that isn't a live adjustment. */
  dismiss(): void;
}

/**
 * The per-window menu.
 *
 * Everything offered here is a property of *this* window, or of the
 * constellation it belongs to. That's the dividing line: things scoped to a
 * window belong on the window, and only genuinely global state should cost you
 * a trip to a settings screen.
 */
export function buildPanelMenu(
  menu: HTMLElement,
  model: MenuModel,
  actions: MenuActions
): void {
  menu.replaceChildren();

  const item = (label: string, run: () => void, cls = "") => {
    const b = document.createElement("button");
    b.className = `vs-menu-item ${cls}`;
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
      actions.dismiss();
    });
    menu.appendChild(b);
  };
  const rule = () => {
    const d = document.createElement("div");
    d.className = "vs-menu-rule";
    menu.appendChild(d);
  };

  item(model.pinned ? "unpin from screen" : "pin to screen", actions.togglePin);
  item(model.minimized ? "expand" : "collapse", actions.toggleMinimize);
  item("pull closer", () => actions.nudge(-1));
  item("push away", () => actions.nudge(1));
  if (model.merged) item("release from orbit", actions.release);

  const g = model.group;
  if (g) {
    rule();
    item(g.rigid ? "loosen the link" : "harden the link", () =>
      actions.setRigid(!g.rigid)
    );
    menu.appendChild(colorRow(g.color, actions));
    item("dissolve constellation", actions.dissolve);
  }

  rule();
  item("close window", actions.close, "danger");
}

function colorRow(current: string, actions: MenuActions): HTMLElement {
  const row = document.createElement("div");
  row.className = "vs-menu-colors";

  for (const c of GROUP_COLORS) {
    const sw = document.createElement("button");
    sw.className = "vs-swatch";
    sw.style.background = c;
    sw.classList.toggle("on", c.toLowerCase() === current.toLowerCase());
    sw.title = c;
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      actions.setColor(c);
      actions.refresh();
    });
    row.appendChild(sw);
  }

  const custom = document.createElement("input");
  custom.type = "color";
  custom.className = "vs-swatch-custom";
  custom.value = current;
  custom.title = "any colour you like";
  // Live-dragging the picker shouldn't close the menu out from under you.
  custom.addEventListener("click", (e) => e.stopPropagation());
  custom.addEventListener("input", () => actions.setColor(custom.value));
  row.appendChild(custom);

  return row;
}

function tool(cls: string, glyph: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `vs-panel-tool ${cls}`;
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}
