import type { FsEntry, KernelContext } from "../../kernel/types";
import { HOME, timeAgo, tildify, uniqueName } from "../../kernel/fsutil";
import { TEMPLATES, fileTypeFor } from "../../kernel/filetypes";
import { promptInline } from "../../ui/contextMenu";

/**
 * What the editor shows when it has no file.
 *
 * The old answer was one sentence: "No file. Open one from the desktop or the
 * Workspace." An app whose response to being launched is to name two other
 * apps has no reason to be in the launcher, which is exactly the complaint
 * this pane exists to answer.
 *
 * Three things, in the order you want them: what you had open recently, what
 * is in your home directory, and a new file.
 */

const RECENT_KEY = "editor.recent";
const RECENT_MAX = 12;

/** Note that a file was opened. Kept newest-first, deduped, bounded. */
export function rememberRecent(ctx: KernelContext, path: string): void {
  const list = ctx.state.get<string[]>(RECENT_KEY, []).filter((p) => p !== path);
  list.unshift(path);
  ctx.state.set(RECENT_KEY, list.slice(0, RECENT_MAX));
}

/** The recent list, minus anything that has since been deleted or renamed. */
export function recentFiles(ctx: KernelContext): string[] {
  return ctx.state.get<string[]>(RECENT_KEY, []).filter((p) => {
    try {
      return ctx.fs.exists(p) && !ctx.fs.isDir(p);
    } catch {
      return false;
    }
  });
}

export interface StartOpts {
  open(path: string): void;
  /** Launched via "New file": go straight to the name prompt. */
  newFile?: boolean;
}

export function openStartPane(
  root: HTMLElement,
  ctx: KernelContext,
  opts: StartOpts
): () => void {
  root.className = "ed-root ed-start";

  const search = document.createElement("input");
  search.className = "ed-start-search";
  search.type = "text";
  search.placeholder = "find a file to edit…";
  search.setAttribute("aria-label", "Find a file");

  const body = document.createElement("div");
  body.className = "ed-start-body";

  const foot = document.createElement("div");
  foot.className = "ed-start-foot";
  const newBtn = document.createElement("button");
  newBtn.className = "fm-btn";
  newBtn.textContent = "+ new file";
  const filesBtn = document.createElement("button");
  filesBtn.className = "fm-btn";
  filesBtn.textContent = "browse files";
  filesBtn.addEventListener("click", () => ctx.launch("workspace"));
  foot.append(newBtn, filesBtn);

  root.append(search, body, foot);

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "warn");
    }
  };

  /**
   * Create a file and open it.
   *
   * Templates come from the same table the file manager's New menu uses, so
   * "new Python file" means the same thing in both places.
   */
  const createNew = (x: number, y: number) => {
    promptInline(x, y, "untitled.md", "file name", (name) =>
      guard(() => {
        const dir = HOME;
        const target = `${dir}/${uniqueName(ctx, dir, name)}`;
        const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        const template = TEMPLATES.find((t) => t.name.endsWith(`.${ext}`));
        ctx.fs.write(target, template?.body ?? "");
        opts.open(target);
      })
    );
  };

  newBtn.addEventListener("click", (e) => createNew(e.clientX, e.clientY));

  /** Text files under a directory, one level deep, newest first. */
  const documents = (dir: string): FsEntry[] => {
    try {
      return ctx.fs
        .ls(dir)
        .filter((e) => e.kind === "file" && !e.name.startsWith("."))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 8);
    } catch {
      return [];
    }
  };

  /** Anything matching a query, from home downwards. Bounded like the browser's. */
  const search_ = (q: string): FsEntry[] => {
    const needle = q.toLowerCase();
    const out: FsEntry[] = [];
    const queue = [HOME];
    let seen = 0;
    while (queue.length && seen < 3000 && out.length < 40) {
      const dir = queue.shift()!;
      let kids: FsEntry[];
      try {
        kids = ctx.fs.ls(dir);
      } catch {
        continue;
      }
      for (const k of kids) {
        seen++;
        if (k.name.startsWith(".")) continue;
        if (k.kind === "dir") queue.push(k.path);
        else if (k.name.toLowerCase().includes(needle)) out.push(k);
      }
    }
    return out;
  };

  const rowFor = (entry: { path: string; name: string; mtime?: number }): HTMLElement => {
    const type = fileTypeFor(entry.path);
    const b = document.createElement("button");
    b.className = "ed-start-row";
    const g = document.createElement("span");
    g.className = `ed-start-glyph fam-${type.family}`;
    g.textContent = type.glyph;
    const n = document.createElement("span");
    n.className = "ed-start-name";
    n.textContent = entry.name;
    const w = document.createElement("span");
    w.className = "ed-start-where";
    w.textContent = entry.mtime ? `${tildify(entry.path)} · ${timeAgo(entry.mtime)}` : tildify(entry.path);
    b.append(g, n, w);
    b.addEventListener("click", () => opts.open(entry.path));
    return b;
  };

  const section = (title: string, rows: HTMLElement[]): void => {
    if (!rows.length) return;
    const h = document.createElement("div");
    h.className = "ed-start-head";
    h.textContent = title;
    body.append(h, ...rows);
  };

  const render = () => {
    body.replaceChildren();
    const q = search.value.trim();

    if (q) {
      const hits = search_(q);
      if (!hits.length) {
        const none = document.createElement("div");
        none.className = "ed-start-empty";
        none.textContent = `nothing under ~ matches "${q}"`;
        body.appendChild(none);
        return;
      }
      section(`${hits.length} match${hits.length === 1 ? "" : "es"}`, hits.map(rowFor));
      return;
    }

    const recent = recentFiles(ctx);
    section(
      "recent",
      recent.map((p) => rowFor({ path: p, name: p.slice(p.lastIndexOf("/") + 1) }))
    );

    const home = documents(HOME).filter((e) => !recent.includes(e.path));
    section("home", home.map(rowFor));

    const notes = documents(`${HOME}/notes`);
    section("notes", notes.map(rowFor));

    if (!body.childElementCount) {
      const none = document.createElement("div");
      none.className = "ed-start-empty";
      none.textContent = "nothing here yet — make something";
      body.appendChild(none);
    }
  };

  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      body.querySelector<HTMLButtonElement>(".ed-start-row")?.click();
    }
  });

  render();
  const off = ctx.fs.onChange(render);
  requestAnimationFrame(() => {
    if (opts.newFile) {
      const r = newBtn.getBoundingClientRect();
      createNew(r.left, r.top - 8);
    } else search.focus();
  });

  return () => {
    off();
    root.replaceChildren();
  };
}
