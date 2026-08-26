import type { KernelContext, ModuleManifest } from "../kernel/types";

/**
 * Shelves: what kind of thing an app *is*.
 *
 * Thirty modules in one flat grid is a list, not an organisation. The drawer
 * already sorts and searches, which answers "where is the thing I named" but
 * not "what have I got" — and those are different questions. Something you
 * leave running to look at and something you file your tax return in should not
 * sit next to each other just because their names are adjacent.
 *
 * Deliberately *not* a field on `ModuleManifest`. Adding one would mean
 * touching all thirty modules for a purely presentational concern, and worse,
 * it would make the taxonomy the author's decision rather than the user's. A
 * shelf is an opinion about your own desktop. Whoever installed the thing gets
 * to disagree, so the defaults live here and the overrides live in the ordinary
 * settings store, which means they follow the account like everything else.
 */
export interface Shelf {
  id: string;
  label: string;
  hint: string;
}

/**
 * The order here is the order they appear. Roughly: things you work in, things
 * that tell you something, things that are just nice, then the plumbing.
 */
export const SHELVES: Shelf[] = [
  { id: "tools", label: "tools", hint: "things you work in" },
  { id: "instruments", label: "instruments", hint: "things that tell you something" },
  { id: "toys", label: "toys", hint: "things to leave running and look at" },
  { id: "games", label: "games", hint: "things you play" },
  { id: "system", label: "system", hint: "no window of their own" },
];

export const SHELF_IDS = SHELVES.map((s) => s.id);

/** Fallback shelf for anything unrecognised. */
const OTHER = "tools";

/**
 * Where each module starts out.
 *
 * A starting point, not a ruling. Anything missing falls back on `kind`, so a
 * module added later lands somewhere sensible without this file being touched —
 * which matters, because a lookup table that must be edited in lockstep with
 * the module list is a lookup table that will silently rot.
 */
const DEFAULTS: Record<string, string> = {
  workspace: "tools",
  editor: "tools",
  portal: "tools",
  notes: "tools",
  settings: "tools",
  desktop: "tools",
  webapp: "tools",
  dashboards: "tools",
  trash: "tools",
  calculator: "tools",
  calendar: "tools",

  timer: "instruments",
  monitor: "instruments",
  vitals: "instruments",
  chronos: "instruments",
  cosmos: "instruments",
  lunaria: "instruments",
  orrery: "instruments",
  sunclock: "instruments",
  bell: "instruments",

  cradle: "toys",
  constellation: "toys",
  driftfield: "toys",
  sandbox: "toys",
  harmonograph: "toys",
  bubblewrap: "toys",
  ripple: "toys",
  flock: "toys",
  lavalamp: "toys",
  turmite: "toys",
  mycelia: "toys",
  chaos: "toys",

  arcade: "games",
  pawnageddon: "games",
  snakesfoxes: "games",

  aurora: "system",
  horizon: "system",
  shell: "system",
};

/** Whether the drawer groups at all. Off gives you the old flat grid back. */
export const GROUP_KEY = "apps.group";

const shelfKey = (id: string) => `apps.shelf.${id}`;

/** Which shelf a module sits on: the user's choice, else a default, else kind. */
export function shelfOf(ctx: KernelContext, m: ModuleManifest): string {
  const chosen = ctx.state.get<string>(shelfKey(m.id), "");
  if (chosen && SHELF_IDS.includes(chosen)) return chosen;
  const fallback = m.kind === "app" ? OTHER : "system";
  return DEFAULTS[m.id] ?? fallback;
}

export function setShelf(ctx: KernelContext, moduleId: string, shelf: string): void {
  ctx.state.set(shelfKey(moduleId), SHELF_IDS.includes(shelf) ? shelf : "");
}

export interface ShelfGroup {
  shelf: Shelf;
  mods: ModuleManifest[];
}

/**
 * Bucket modules into shelves, in shelf order, dropping the empty ones.
 *
 * Empty shelves are dropped rather than shown greyed out: a heading with
 * nothing under it is noise, and while searching most shelves are empty most
 * of the time.
 */
export function groupModules(ctx: KernelContext, mods: ModuleManifest[]): ShelfGroup[] {
  const buckets = new Map<string, ModuleManifest[]>();
  for (const m of mods) {
    const id = shelfOf(ctx, m);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(m);
    else buckets.set(id, [m]);
  }
  const out: ShelfGroup[] = [];
  for (const shelf of SHELVES) {
    const group = buckets.get(shelf.id);
    if (group && group.length) out.push({ shelf, mods: group });
  }
  return out;
}

/**
 * Publish the controls: one toggle, and a panel for reassigning apps.
 *
 * Registered from the drawer rather than from a module because the shelves are
 * a property of the drawer, not of any app — and because a module that owned
 * this would have to know about every other module, which is the coupling this
 * whole file exists to avoid.
 */
export function defineShelfSettings(ctx: KernelContext): void {
  ctx.defineSetting({
    key: GROUP_KEY,
    label: "group apps by shelf",
    kind: "toggle",
    group: "Launcher",
    hint: "off gives you one flat grid",
    default: true,
    order: 40,
  });

  ctx.defineSetting({
    key: "apps.shelves",
    label: "shelves",
    kind: "custom",
    group: "Launcher",
    hint: "where each app files itself",
    order: 41,
    render: (root, c) => renderShelfEditor(root, c),
  });
}

/** The reassignment panel: every app, and the shelf it sits on. */
function renderShelfEditor(root: HTMLElement, ctx: KernelContext): () => void {
  const wrap = document.createElement("div");
  wrap.className = "shelf-editor";

  const rebuild = () => {
    wrap.replaceChildren();
    for (const group of groupModules(ctx, [...ctx.registry()].sort(byName))) {
      const head = document.createElement("div");
      head.className = "shelf-editor-head";
      head.textContent = `${group.shelf.label} \u00b7 ${group.shelf.hint}`;
      wrap.appendChild(head);

      for (const m of group.mods) {
        const row = document.createElement("div");
        row.className = "shelf-editor-row";

        const name = document.createElement("span");
        name.className = "shelf-editor-name";
        name.textContent = `${m.glyph ?? "\u00b7"}  ${m.name}`;

        const pick = document.createElement("select");
        pick.className = "shelf-editor-pick";
        for (const s of SHELVES) {
          const opt = document.createElement("option");
          opt.value = s.id;
          opt.textContent = s.label;
          if (s.id === shelfOf(ctx, m)) opt.selected = true;
          pick.appendChild(opt);
        }
        pick.addEventListener("change", () => {
          setShelf(ctx, m.id, pick.value);
          // Rebuilt rather than reordered in place: the row has to move to the
          // shelf it was just assigned to, or the panel disagrees with itself.
          rebuild();
        });

        row.append(name, pick);
        wrap.appendChild(row);
      }
    }
  };

  rebuild();
  root.appendChild(wrap);
  return () => wrap.remove();
}

function byName(a: ModuleManifest, b: ModuleManifest): number {
  return a.name.localeCompare(b.name);
}
