import type { FsEntry, KernelContext, VoidModule } from "../../kernel/types";
import { HOME, timeAgo, uniqueName } from "../../kernel/fsutil";
import { trashWithUndo } from "../../ui/fileMenu";

const NOTES_DIR = `${HOME}/notes`;
/** The old store-backed index, read once to migrate and then abandoned. */
const LEGACY_INDEX = "notes.index";
const LEGACY_DOC = (id: string) => `notes.doc.${id}`;
const MIGRATED_KEY = "notes.migrated";

/**
 * Notes, on the filesystem.
 *
 * They used to live in the settings store under `notes.doc.<id>` keys — which
 * worked, and proved the store persists, but meant the one app whose entire
 * job is holding your text was the one place in the shell whose contents you
 * could not `cat`, `grep`, back up, edit in the editor, or see in the file
 * manager. The VFS has created an empty `~/notes` since the day it was written
 * and nothing has ever put anything in it.
 *
 * Now a note is a Markdown file in `~/notes`. Everything else follows for
 * free: the desktop can hold one, the editor opens one, `grep` finds one, and
 * the trash catches one you delete by accident.
 */
export const notes: VoidModule = {
  manifest: {
    id: "notes",
    name: "Notes",
    kind: "app",
    glyph: "✎",
    blurb: "markdown files in ~/notes",
    version: "0.2.0",
  },

  activate(ctx: KernelContext) {
    ctx.fs.mkdirp(NOTES_DIR);
    migrate(ctx);
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "notes",
      width: 560,
      height: 380,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("notes-root");

        const side = document.createElement("div");
        side.className = "notes-side";
        const listEl = document.createElement("div");
        listEl.className = "notes-list";
        const addBtn = document.createElement("button");
        addBtn.className = "cos-btn";
        addBtn.textContent = "+ note";
        side.append(listEl, addBtn);

        const pane = document.createElement("div");
        pane.className = "notes-pane";
        const titleEl = document.createElement("input");
        titleEl.className = "notes-title";
        titleEl.type = "text";
        titleEl.placeholder = "untitled";
        const bodyEl = document.createElement("textarea");
        bodyEl.className = "notes-body";
        bodyEl.placeholder = "write into the void…";
        const foot = document.createElement("div");
        foot.className = "notes-foot";
        const whereEl = document.createElement("span");
        whereEl.className = "notes-where";
        const editBtn = document.createElement("button");
        editBtn.className = "notes-open";
        editBtn.textContent = "open in editor";
        const delBtn = document.createElement("button");
        delBtn.className = "notes-del";
        delBtn.textContent = "delete";
        foot.append(whereEl, editBtn, delBtn);
        pane.append(titleEl, bodyEl, foot);

        root.append(side, pane);

        /** Which file is being edited. Empty when there are none at all. */
        let current = "";
        /** Set while this app is the one writing, so its own change is ignored. */
        let writing = false;

        const list = (): FsEntry[] => {
          try {
            return ctx.fs
              .ls(NOTES_DIR)
              .filter((e) => e.kind === "file" && !e.name.startsWith("."))
              .sort((a, b) => b.mtime - a.mtime);
          } catch {
            return [];
          }
        };

        /** A note's display title: its first heading, else its filename. */
        const titleOf = (entry: FsEntry): string => {
          try {
            const first = ctx.fs.read(entry.path).split("\n")[0]?.trim() ?? "";
            const heading = /^#{1,6}\s+(.*)$/.exec(first);
            if (heading) return heading[1];
            if (first) return first.slice(0, 60);
          } catch {
            /* fall through to the name */
          }
          return entry.name.replace(/\.md$/, "");
        };

        const paintList = () => {
          const items = list();
          listEl.replaceChildren();
          for (const n of items) {
            const b = document.createElement("button");
            b.className = "notes-item";
            b.classList.toggle("on", n.path === current);
            const t = document.createElement("span");
            t.className = "notes-item-title";
            t.textContent = titleOf(n) || "untitled";
            const w = document.createElement("span");
            w.className = "notes-item-when";
            w.textContent = timeAgo(n.mtime);
            b.append(t, w);
            b.addEventListener("click", () => select(n.path));
            listEl.appendChild(b);
          }
          if (!items.length) {
            const empty = document.createElement("div");
            empty.className = "notes-empty";
            empty.textContent = "no notes";
            listEl.appendChild(empty);
          }
        };

        const select = (path: string) => {
          current = path;
          const has = Boolean(path) && ctx.fs.exists(path);
          titleEl.value = has ? path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "") : "";
          bodyEl.value = has ? safeRead(path) : "";
          titleEl.disabled = !has;
          bodyEl.disabled = !has;
          editBtn.style.visibility = has ? "visible" : "hidden";
          delBtn.style.visibility = has ? "visible" : "hidden";
          whereEl.textContent = has ? `~/notes/${path.slice(path.lastIndexOf("/") + 1)}` : "";
          paintList();
        };

        const safeRead = (path: string): string => {
          try {
            return ctx.fs.read(path);
          } catch {
            return "";
          }
        };

        const guard = (fn: () => void) => {
          try {
            writing = true;
            fn();
          } catch (err) {
            ctx.notify(err instanceof Error ? err.message : String(err), "warn");
          } finally {
            writing = false;
          }
        };

        const create = () => {
          guard(() => {
            const name = uniqueName(ctx, NOTES_DIR, "untitled.md");
            const path = `${NOTES_DIR}/${name}`;
            ctx.fs.write(path, "");
            select(path);
          });
          requestAnimationFrame(() => bodyEl.focus());
        };

        addBtn.addEventListener("click", create);

        // Renaming the file *is* renaming the note. Committed on blur or Enter
        // rather than per keystroke: one `mv` per character would fill the
        // directory with half-typed names.
        const commitName = () => {
          if (!current) return;
          const stem = titleEl.value.trim().replace(/[/\\]/g, "-");
          if (!stem) return;
          const dest = `${NOTES_DIR}/${stem.endsWith(".md") ? stem : `${stem}.md`}`;
          if (dest === current) return;
          guard(() => {
            ctx.fs.mv(current, dest);
            current = dest;
            select(dest);
          });
        };
        titleEl.addEventListener("blur", commitName);
        titleEl.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            commitName();
            bodyEl.focus();
          }
        });

        // Typing writes straight through to the file, debounced. The store is
        // mirrored to the server on a debounce of its own, so this is not a
        // second persistence path — it is the same one every other file uses.
        let saveTimer = 0;
        bodyEl.addEventListener("keydown", (e) => e.stopPropagation());
        bodyEl.addEventListener("input", () => {
          if (!current) return;
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            guard(() => ctx.fs.write(current, bodyEl.value));
          }, 400);
        });

        editBtn.addEventListener("click", () => {
          if (current) ctx.openPath(current);
        });

        delBtn.addEventListener("click", () => {
          if (!current) return;
          const path = current;
          // Notes go to the trash like everything else, so a mis-click is one
          // undo rather than a lost afternoon.
          guard(() => trashWithUndo(ctx, ctx.fs.stat(path)));
          const next = list().find((n) => n.path !== path);
          select(next ? next.path : "");
        });

        const first = list()[0];
        if (first) select(first.path);
        else create();

        // Another app editing a note — the editor, the console, a `mv` — has
        // to show up here. The guard keeps this app's own writes from
        // clobbering the cursor position mid-sentence.
        const off = ctx.fs.onChange(() => {
          if (writing) return;
          if (current && !ctx.fs.exists(current)) {
            const next = list()[0];
            select(next ? next.path : "");
            return;
          }
          if (current && document.activeElement !== bodyEl) {
            bodyEl.value = safeRead(current);
          }
          paintList();
        });

        return () => {
          off();
          window.clearTimeout(saveTimer);
          root.replaceChildren();
        };
      },
    });
  },
};

/**
 * Move store-backed notes into ~/notes, once.
 *
 * Silently losing what somebody wrote is not an acceptable cost of tidying up
 * the storage model, so the old keys are read, written out as files, and left
 * alone — a wipe of the store is a separate decision from a migration.
 */
function migrate(ctx: KernelContext): void {
  if (ctx.state.get<boolean>(MIGRATED_KEY, false)) return;
  const index = ctx.state.get<{ id: string; title: string }[]>(LEGACY_INDEX, []);
  if (!Array.isArray(index) || !index.length) {
    ctx.state.set(MIGRATED_KEY, true);
    return;
  }

  let moved = 0;
  for (const meta of index) {
    const body = ctx.state.get<string>(LEGACY_DOC(meta.id), "");
    if (!body && !meta.title) continue;
    const stem = (meta.title || "untitled").trim().replace(/[/\\]/g, "-").slice(0, 60);
    const name = uniqueName(ctx, NOTES_DIR, `${stem || "untitled"}.md`);
    try {
      ctx.fs.write(`${NOTES_DIR}/${name}`, body);
      moved++;
    } catch (err) {
      console.warn("[notes] could not migrate a note:", err);
    }
  }

  ctx.state.set(MIGRATED_KEY, true);
  if (moved) {
    ctx.log(`migrated ${moved} note(s) into ${NOTES_DIR}`);
    ctx.notify(`${moved} note${moved === 1 ? "" : "s"} moved into ~/notes`, {
      action: { label: "show them", run: (c) => c.openPath(NOTES_DIR) },
    });
  }
}
