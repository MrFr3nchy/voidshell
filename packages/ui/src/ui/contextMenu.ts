/**
 * Right-click menus, shared by the desktop and the file manager.
 *
 * One menu exists at a time and lives directly on <body>, above every panel,
 * so it is never clipped by the surface that opened it.
 */

export interface MenuItem {
  label: string;
  /** Omit to render a disabled entry — used for "Paste" with nothing copied. */
  action?: () => void;
  /** Draws a divider above this item. */
  separated?: boolean;
  danger?: boolean;
  accel?: string;
  /**
   * A row of colour swatches under the label, plus a free picker.
   *
   * The one control a list of verbs can't express. It exists because the window
   * menu needs to set a constellation's colour, and the alternative was a
   * second menu implementation living next to this one — which is exactly what
   * used to be in `panelChrome.ts`. Picking a colour deliberately leaves the
   * menu open: it is a live adjustment, and closing on the first swatch would
   * make comparing two of them a chore.
   */
  swatches?: {
    colors: string[];
    current: string;
    onPick: (color: string) => void;
  };
  /**
   * A nested menu.
   *
   * Added for "Open With…" and "New…", both of which are one verb with a list
   * of objects. Flattening either into the parent buries the four things you
   * use daily under twelve you use once, and a modal picker for "which app"
   * is a dialog where a menu will do.
   */
  submenu?: MenuItem[];
}

/**
 * Every menu level currently on screen, root first.
 *
 * A stack rather than one element because submenus are separate absolutely
 * positioned nodes: dismissal has to treat a click in a child as a click
 * "inside the menu", and Escape has to close one level at a time.
 */
let layers: HTMLElement[] = [];

export function closeContextMenu(): void {
  // Clear the list *before* detaching: removing a focused input fires blur
  // synchronously, and that handler calls back in here. If the stack were
  // still populated it would try to remove the same node twice and throw,
  // aborting whatever committed the menu in the first place.
  const els = layers;
  layers = [];
  for (const el of els) el.remove();
}

/** Drop every level deeper than `depth`, for moving between parent rows. */
function closeBelow(depth: number): void {
  while (layers.length > depth + 1) layers.pop()?.remove();
}

/** Place a menu at a point, flipping it in when it would run off the screen. */
function placeAt(menu: HTMLElement, x: number, y: number, flipFrom?: number): void {
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const overflows = x + r.width > window.innerWidth - 8;
  const left = overflows && flipFrom !== undefined ? flipFrom - r.width : Math.min(x, window.innerWidth - r.width - 8);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 8))}px`;
  menu.style.visibility = "";
}

/** Build one level. Rows with a submenu open the next level on hover. */
function buildMenu(items: MenuItem[], depth: number): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "vs-menu";

  for (const item of items) {
    if (item.separated) {
      const hr = document.createElement("div");
      hr.className = "vs-menu-sep";
      menu.appendChild(hr);
    }
    if (item.swatches) {
      menu.appendChild(swatchRow(item));
      continue;
    }

    const btn = document.createElement("button");
    const nested = item.submenu?.length ? item.submenu : null;
    btn.className = `vs-menu-item${item.danger ? " danger" : ""}${nested ? " has-sub" : ""}`;
    btn.disabled = !item.action && !nested;

    const label = document.createElement("span");
    label.textContent = item.label;
    btn.appendChild(label);

    if (item.accel) {
      const accel = document.createElement("span");
      accel.className = "vs-menu-accel";
      accel.textContent = item.accel;
      btn.appendChild(accel);
    }
    if (nested) {
      const arrow = document.createElement("span");
      arrow.className = "vs-menu-arrow";
      arrow.textContent = "›";
      btn.appendChild(arrow);
    }

    if (nested) {
      const openSub = () => {
        // Moving between parent rows must replace the flyout, not stack them.
        closeBelow(depth);
        for (const sib of menu.querySelectorAll(".vs-menu-item.on")) {
          sib.classList.remove("on");
        }
        btn.classList.add("on");
        const r = btn.getBoundingClientRect();
        const sub = buildMenu(nested, depth + 1);
        placeAt(sub, r.right - 2, r.top - 4, r.left + 2);
        layers.push(sub);
      };
      btn.addEventListener("pointerenter", openSub);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openSub();
      });
    } else {
      btn.addEventListener("pointerenter", () => closeBelow(depth));
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeContextMenu();
        item.action?.();
      });
    }
    menu.appendChild(btn);
  }

  return menu;
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();

  const menu = buildMenu(items, 0);
  placeAt(menu, x, y);
  layers = [menu];
  armDismiss();
}

/**
 * Show arbitrary DOM with a menu's manners: placed at a point, clamped into
 * the viewport, gone on the next click anywhere else.
 *
 * The properties panel needs exactly this and nothing else a dialog would
 * bring — no backdrop, no close button, no focus trap. Something you glance at
 * should leave the same way a menu does.
 */
export function showMenuPanel(x: number, y: number, panel: HTMLElement): void {
  closeContextMenu();
  panel.classList.add("vs-menu");
  placeAt(panel, x, y);
  layers = [panel];
  armDismiss();
}

/** Close on the next interaction anywhere outside the open levels. */
function armDismiss(): void {
  setTimeout(() => {
    const inside = (node: Node) => layers.some((l) => l.contains(node));
    const dismiss = (ev: Event) => {
      if (layers.length && !inside(ev.target as Node)) {
        closeContextMenu();
        cleanup();
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // Escape backs out one level. Closing the whole tree from three levels
      // deep is the behaviour of a dialog, not a menu.
      if (layers.length > 1) {
        ev.stopPropagation();
        closeBelow(layers.length - 2);
        return;
      }
      closeContextMenu();
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", dismiss, true);
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", dismiss, true);
  }, 0);
}

function swatchRow(item: MenuItem): HTMLElement {
  const { colors, current, onPick } = item.swatches!;

  const wrap = document.createElement("div");
  wrap.className = "vs-menu-swatches";

  const label = document.createElement("span");
  label.className = "vs-menu-swatch-label";
  label.textContent = item.label;
  wrap.appendChild(label);

  const row = document.createElement("div");
  row.className = "vs-menu-colors";

  const marks: { el: HTMLElement; color: string }[] = [];
  const mark = (color: string) => {
    for (const m of marks) m.el.classList.toggle("on", m.color === color.toLowerCase());
  };

  for (const c of colors) {
    const sw = document.createElement("button");
    sw.className = "vs-swatch";
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener("click", (e) => {
      // Live adjustment: change the colour, keep the menu up.
      e.stopPropagation();
      onPick(c);
      mark(c);
    });
    marks.push({ el: sw, color: c.toLowerCase() });
    row.appendChild(sw);
  }
  mark(current);

  const custom = document.createElement("input");
  custom.type = "color";
  custom.className = "vs-swatch-custom";
  custom.value = current;
  custom.title = "any colour you like";
  // Dragging the picker must not close the menu out from under it.
  custom.addEventListener("click", (e) => e.stopPropagation());
  custom.addEventListener("input", () => {
    onPick(custom.value);
    mark(custom.value);
  });
  row.appendChild(custom);

  wrap.appendChild(row);
  return wrap;
}

/**
 * A small inline prompt for names — used by "New Folder", "Rename", and
 * anything else that needs one string without a modal dialog.
 */
export function promptInline(
  x: number,
  y: number,
  initial: string,
  placeholder: string,
  onCommit: (value: string) => void
): void {
  closeContextMenu();

  const wrap = document.createElement("div");
  wrap.className = "vs-menu vs-prompt";
  const input = document.createElement("input");
  input.className = "vs-prompt-input";
  input.value = initial;
  input.placeholder = placeholder;
  wrap.appendChild(input);

  wrap.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
  wrap.style.top = `${Math.min(y, window.innerHeight - 60)}px`;
  document.body.appendChild(wrap);
  layers = [wrap];

  input.focus();
  // Preselect the basename so typing replaces the name but keeps the extension.
  const dot = initial.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : initial.length);

  const commit = () => {
    const v = input.value.trim();
    closeContextMenu();
    if (v) onCommit(v);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") closeContextMenu();
  });
  input.addEventListener("blur", () => closeContextMenu());
}
