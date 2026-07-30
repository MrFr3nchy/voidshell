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
}

let open: HTMLElement | null = null;

export function closeContextMenu(): void {
  // Clear the reference *before* detaching: removing a focused input fires
  // blur synchronously, and that handler calls back in here. If `open` were
  // still set it would try to remove the same node twice and throw, aborting
  // whatever committed the menu in the first place.
  const el = open;
  open = null;
  el?.remove();
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "vs-menu";

  for (const item of items) {
    if (item.separated) {
      const hr = document.createElement("div");
      hr.className = "vs-menu-sep";
      menu.appendChild(hr);
    }
    const btn = document.createElement("button");
    btn.className = `vs-menu-item${item.danger ? " danger" : ""}`;
    btn.disabled = !item.action;

    const label = document.createElement("span");
    label.textContent = item.label;
    btn.appendChild(label);

    if (item.accel) {
      const accel = document.createElement("span");
      accel.className = "vs-menu-accel";
      accel.textContent = item.accel;
      btn.appendChild(accel);
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      item.action?.();
    });
    menu.appendChild(btn);
  }

  // Offscreen first so we can measure, then clamp into the viewport.
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  menu.style.visibility = "";

  open = menu;

  // Dismiss on the next interaction anywhere else.
  setTimeout(() => {
    const dismiss = (ev: Event) => {
      if (open && !open.contains(ev.target as Node)) {
        closeContextMenu();
        cleanup();
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        closeContextMenu();
        cleanup();
      }
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
  open = wrap;

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
