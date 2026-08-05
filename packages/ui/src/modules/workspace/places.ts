import type { KernelContext } from "../../kernel/types";
import { HOME, transferInto } from "../../kernel/fsutil";
import { TRASH_DIR, moveToTrash } from "../../kernel/trash";

/**
 * The sidebar: the few directories you actually go to, and every volume.
 *
 * Navigation used to be `↑`, `~`, and typing a path into a console. Everything
 * else in the tree — the Desktop you can see out of the window, /projects,
 * /proc — could only be reached by knowing it was there and walking to it.
 *
 * Volumes come from the mount table rather than a list written here, so a
 * filesystem grafted in later shows up without this file being touched. That
 * is the same bargain the settings registry makes, applied to storage.
 */

interface Place {
  label: string;
  glyph: string;
  path: string;
  /** Dropping a file here does something other than move it in. */
  drop?: "trash";
  /**
   * Clicking opens this app instead of navigating.
   *
   * Only the trash uses it, and for a real reason: the directory is the truth
   * but the manifest that says where each thing came from is not in it, so a
   * plain listing is the one view that can't put anything back.
   */
  app?: string;
}

const PLACES: Place[] = [
  { label: "Home", glyph: "⌂", path: HOME },
  { label: "Desktop", glyph: "▭", path: `${HOME}/Desktop` },
  { label: "Notes", glyph: "❡", path: `${HOME}/notes` },
  { label: "Trash", glyph: "⌫", path: TRASH_DIR, drop: "trash", app: "trash" },
];

export interface PlacesHandle {
  el: HTMLElement;
  /** Light up whichever entry contains the current directory. */
  setCwd(path: string): void;
  dispose(): void;
}

export function createPlaces(
  ctx: KernelContext,
  opts: { onGo(path: string): void }
): PlacesHandle {
  const el = document.createElement("div");
  el.className = "fm-places";

  let cwd = "";

  const section = (title: string): HTMLElement => {
    const h = document.createElement("div");
    h.className = "fm-places-head";
    h.textContent = title;
    return h;
  };

  const row = (place: Place): HTMLElement => {
    const b = document.createElement("button");
    b.className = "fm-place";
    b.title = place.path;
    b.dataset.path = place.path;

    const g = document.createElement("span");
    g.className = "fm-place-glyph";
    g.textContent = place.glyph;
    const n = document.createElement("span");
    n.className = "fm-place-name";
    n.textContent = place.label;
    b.append(g, n);

    b.addEventListener("click", () => {
      if (place.app) ctx.launch(place.app);
      else opts.onGo(place.path);
    });

    // Dropping onto a place is the shortest possible move: no navigating to
    // the destination first, no second window. Trash is the same gesture with
    // the meaning everybody already expects.
    b.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("text/voidshell-path")) return;
      e.preventDefault();
      e.stopPropagation();
      b.classList.add("drop-target");
    });
    b.addEventListener("dragleave", () => b.classList.remove("drop-target"));
    b.addEventListener("drop", (e) => {
      b.classList.remove("drop-target");
      const src = e.dataTransfer?.getData("text/voidshell-path");
      if (!src) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        if (place.drop === "trash") {
          const name = moveToTrash(ctx, src);
          ctx.notify(`moved to trash · restore ${name}`);
        } else {
          ctx.fs.mkdirp(place.path);
          transferInto(ctx, src, place.path);
        }
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "warn");
      }
    });

    return b;
  };

  const build = () => {
    el.replaceChildren();
    el.appendChild(section("places"));
    for (const p of PLACES) el.appendChild(row(p));

    // Everything grafted into the tree, minus the home mount — that is
    // "Home" above, and listing it twice under two names is just confusing.
    const volumes = ctx.fs.mounts().filter((m) => m.at !== HOME);
    if (volumes.length) {
      el.appendChild(section("volumes"));
      for (const m of volumes) {
        el.appendChild(
          row({
            label: m.at.replace(/^\//, ""),
            glyph: m.synthetic ? "◌" : m.readonly ? "◍" : "◉",
            path: m.at,
          })
        );
      }
    }
    mark();
  };

  /** The deepest place that contains the cwd is the one that is "current". */
  const mark = () => {
    let best = "";
    for (const b of el.querySelectorAll<HTMLElement>(".fm-place")) {
      const p = b.dataset.path!;
      const contains = cwd === p || cwd.startsWith(`${p}/`);
      if (contains && p.length > best.length) best = p;
    }
    for (const b of el.querySelectorAll<HTMLElement>(".fm-place")) {
      b.classList.toggle("on", b.dataset.path === best);
    }
  };

  build();
  // Mounts can arrive after boot (/projects is asynchronous), so the sidebar
  // has to be able to grow rather than being a snapshot of startup.
  const off = ctx.fs.onChange(() => {
    const known = el.querySelectorAll(".fm-place").length;
    if (known !== PLACES.length + ctx.fs.mounts().filter((m) => m.at !== HOME).length) build();
  });

  return {
    el,
    setCwd(path) {
      cwd = path;
      mark();
    },
    dispose() {
      off();
      el.replaceChildren();
    },
  };
}
