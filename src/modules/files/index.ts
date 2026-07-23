import type { FsEntry, KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";
import { basename, dirname } from "../../kernel/vfs";
import { promptInline, showContextMenu } from "../../ui/contextMenu";
import { clipboard } from "../../ui/clipboard";
import { copyRecursive } from "../desktop";

/**
 * The file manager: a browser pane on the left, a viewer on the right.
 *
 * It knows nothing about where files come from — /home and /projects are the
 * same API to it. Project directories carry a `meta` badge (language, blurb,
 * repo link) which this renders as a header when you open one.
 */

const TEXT_HINT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  rs: "rust", py: "python", gd: "gdscript", qml: "qml", md: "markdown",
  json: "json", css: "css", html: "html", toml: "toml", yml: "yaml",
  yaml: "yaml", sh: "shell", sql: "sql",
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const files: VoidModule = {
  manifest: {
    id: "files",
    name: "Files",
    kind: "app",
    glyph: "▤",
    version: "0.1.0",
  },

  // Directories route here from `openPath`.
  handles: ["dir"],

  activate() {},

  launch(ctx: KernelContext, args?: LaunchArgs) {
    ctx.openSurface({
      title: "files",
      width: 720,
      height: 460,
      render: (root) => {
        root.innerHTML = "";
        root.className = "fm-root";

        const bar = document.createElement("div");
        bar.className = "fm-bar";
        const up = document.createElement("button");
        up.className = "fm-btn";
        up.textContent = "↑";
        up.title = "Parent directory";
        const home = document.createElement("button");
        home.className = "fm-btn";
        home.textContent = "~";
        home.title = "Home";
        const pathEl = document.createElement("span");
        pathEl.className = "fm-path";
        const newDirBtn = document.createElement("button");
        newDirBtn.className = "fm-btn";
        newDirBtn.textContent = "+ folder";
        const newFileBtn = document.createElement("button");
        newFileBtn.className = "fm-btn";
        newFileBtn.textContent = "+ file";
        bar.append(up, home, pathEl, newDirBtn, newFileBtn);

        const body = document.createElement("div");
        body.className = "fm-body";
        const listEl = document.createElement("div");
        listEl.className = "fm-list";
        const viewEl = document.createElement("div");
        viewEl.className = "fm-view";
        body.append(listEl, viewEl);

        root.append(bar, body);

        // Open where we were told to, falling back to home.
        let cwd = args?.path && ctx.fs.exists(args.path)
          ? (ctx.fs.isDir(args.path) ? args.path : dirname(args.path))
          : "/home/void";
        let selected: string | null = null;

        const notify = (msg: string) => {
          const el = document.createElement("div");
          el.className = "fm-note warn";
          el.textContent = msg;
          viewEl.replaceChildren(el);
        };
        const guard = (fn: () => void) => {
          try {
            fn();
          } catch (err) {
            notify(err instanceof Error ? err.message : String(err));
          }
        };

        const uniqueName = (dir: string, base: string): string => {
          if (!ctx.fs.exists(`${dir}/${base}`)) return base;
          const dot = base.lastIndexOf(".");
          const stem = dot > 0 ? base.slice(0, dot) : base;
          const ext = dot > 0 ? base.slice(dot) : "";
          for (let i = 2; i < 500; i++) {
            if (!ctx.fs.exists(`${dir}/${stem} ${i}${ext}`)) return `${stem} ${i}${ext}`;
          }
          return `${stem}-${Date.now()}${ext}`;
        };

        const openFile = (entry: FsEntry) => {
          selected = entry.path;
          viewEl.replaceChildren();

          const head = document.createElement("div");
          head.className = "fm-view-head";
          head.textContent = entry.name;
          const sub = document.createElement("div");
          sub.className = "fm-view-sub";
          sub.textContent = `${fmtSize(entry.size)}${entry.readonly ? " · read-only" : ""}`;
          viewEl.append(head, sub);

          if (entry.omitted) {
            const note = document.createElement("div");
            note.className = "fm-note";
            note.textContent =
              entry.omitted === "binary"
                ? "Binary file — indexed but not embedded in this build."
                : "File exceeds the embed size cap; contents not included.";
            viewEl.appendChild(note);
            return;
          }

          let text: string;
          try {
            text = ctx.fs.read(entry.path);
          } catch (err) {
            const note = document.createElement("div");
            note.className = "fm-note warn";
            note.textContent = err instanceof Error ? err.message : String(err);
            viewEl.appendChild(note);
            return;
          }

          const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
          if (TEXT_HINT[ext]) {
            const lang = document.createElement("div");
            lang.className = "fm-lang";
            lang.textContent = TEXT_HINT[ext];
            viewEl.appendChild(lang);
          }

          // Writable files get an editor; read-only ones a plain <pre>.
          if (entry.readonly) {
            const pre = document.createElement("pre");
            const prose = ext === "md" || ext === "txt" || !ext;
            pre.className = `fm-pre${prose ? " wrap" : ""}`;
            pre.textContent = text;
            viewEl.appendChild(pre);
          } else {
            const ta = document.createElement("textarea");
            ta.className = "fm-edit";
            ta.value = text;
            ta.spellcheck = false;
            const save = document.createElement("button");
            save.className = "fm-btn fm-save";
            save.textContent = "save";
            save.addEventListener("click", () => {
              ctx.fs.write(entry.path, ta.value);
              save.textContent = "saved";
              setTimeout(() => (save.textContent = "save"), 1200);
            });
            viewEl.append(ta, save);
          }
        };

        const showDirMeta = (entry: FsEntry) => {
          if (!entry.meta) return;
          viewEl.replaceChildren();
          const head = document.createElement("div");
          head.className = "fm-view-head";
          head.textContent = entry.name;
          viewEl.appendChild(head);

          if (entry.meta.language) {
            const lang = document.createElement("div");
            lang.className = "fm-lang";
            lang.textContent = entry.meta.language;
            viewEl.appendChild(lang);
          }
          if (entry.meta.description) {
            const d = document.createElement("div");
            d.className = "fm-note";
            d.textContent = entry.meta.description;
            viewEl.appendChild(d);
          }
          if (entry.meta.remote) {
            const a = document.createElement("a");
            a.className = "fm-link";
            a.href = entry.meta.remote;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = entry.meta.remote.replace("https://github.com/", "github ▸ ");
            viewEl.appendChild(a);
          }
        };

        const render = () => {
          pathEl.textContent = cwd;
          listEl.replaceChildren();

          let items: FsEntry[];
          try {
            items = ctx.fs.ls(cwd);
          } catch (err) {
            const e = document.createElement("div");
            e.className = "fm-note warn";
            e.textContent = err instanceof Error ? err.message : String(err);
            listEl.appendChild(e);
            return;
          }

          if (!items.length) {
            const e = document.createElement("div");
            e.className = "fm-note";
            e.textContent = "empty directory";
            listEl.appendChild(e);
          }

          for (const entry of items) {
            const row = document.createElement("button");
            row.className = `fm-row ${entry.kind}${selected === entry.path ? " sel" : ""}`;

            const glyph = document.createElement("span");
            glyph.className = "fm-glyph";
            glyph.textContent = entry.kind === "dir" ? "▸" : entry.omitted ? "◌" : "·";

            const name = document.createElement("span");
            name.className = "fm-name";
            name.textContent = entry.name;

            const size = document.createElement("span");
            size.className = "fm-size";
            size.textContent = entry.kind === "dir" ? "" : fmtSize(entry.size);

            row.append(glyph, name, size);

            row.addEventListener("click", () => {
              if (entry.kind === "dir") {
                cwd = entry.path;
                selected = null;
                render();
                showDirMeta(entry);
              } else {
                openFile(entry);
                render();
              }
            });

            // Double-click opens in the associated app, as in any file manager.
            row.addEventListener("dblclick", (e) => {
              e.preventDefault();
              ctx.openPath(entry.path);
            });

            // Drag a row out onto the void to put it on the desktop. HTML5 DnD
            // rather than pointer events, because the drop lands on a different
            // element tree (the void) than the drag started in (this panel).
            row.draggable = true;
            row.addEventListener("dragstart", (e) => {
              e.dataTransfer?.setData("text/voidshell-path", entry.path);
              e.dataTransfer?.setData("text/plain", entry.path);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
              row.classList.add("dragging");
            });
            row.addEventListener("dragend", () => row.classList.remove("dragging"));

            row.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              e.stopPropagation();
              const clip = clipboard.get();
              const runnable = /\.(py|js|mjs|cjs)$/i.test(entry.name);
              showContextMenu(e.clientX, e.clientY, [
                { label: "Open", action: () => ctx.openPath(entry.path) },
                ...(runnable
                  ? [{ label: "Run", action: () => ctx.launch("runner", { path: entry.path }) }]
                  : []),
                ...(entry.kind === "file"
                  ? [{ label: "Edit", action: () => ctx.launch("editor", { path: entry.path }) }]
                  : []),
                {
                  label: "Copy",
                  separated: true,
                  action: () => clipboard.set(entry.path, "copy"),
                },
                {
                  label: "Cut",
                  action: entry.readonly ? undefined : () => clipboard.set(entry.path, "cut"),
                },
                {
                  label: clip ? `Paste "${basename(clip.path)}"` : "Paste",
                  action:
                    clip && !ctx.fs.stat(cwd).readonly
                      ? () =>
                          guard(() => {
                            const dest = `${cwd}/${uniqueName(cwd, basename(clip.path))}`;
                            if (clip.mode === "cut") {
                              ctx.fs.mv(clip.path, dest);
                              clipboard.clear();
                            } else copyRecursive(ctx, clip.path, dest);
                          })
                      : undefined,
                },
                {
                  label: "Rename…",
                  separated: true,
                  action: entry.readonly
                    ? undefined
                    : () =>
                        promptInline(e.clientX, e.clientY, entry.name, "new name", (n) =>
                          guard(() => ctx.fs.mv(entry.path, `${dirname(entry.path)}/${n}`))
                        ),
                },
                {
                  label: "Delete",
                  danger: true,
                  action: entry.readonly
                    ? undefined
                    : () => guard(() => ctx.fs.rm(entry.path, entry.kind === "dir")),
                },
              ]);
            });

            listEl.appendChild(row);
          }
        };

        up.addEventListener("click", () => {
          if (cwd === "/") return;
          cwd = dirname(cwd);
          selected = null;
          render();
        });

        home.addEventListener("click", () => {
          cwd = "/home/void";
          selected = null;
          render();
        });

        newDirBtn.addEventListener("click", (e) => {
          promptInline(e.clientX, e.clientY, "New Folder", "folder name", (n) =>
            guard(() => ctx.fs.mkdir(`${cwd}/${uniqueName(cwd, n)}`))
          );
        });

        newFileBtn.addEventListener("click", (e) => {
          promptInline(e.clientX, e.clientY, "untitled.md", "file name", (n) =>
            guard(() => ctx.fs.write(`${cwd}/${uniqueName(cwd, n)}`, ""))
          );
        });

        // Dropping onto the list moves the item into the current directory —
        // the inverse of dragging a file out to the desktop.
        listEl.addEventListener("dragover", (e) => {
          if (!e.dataTransfer?.types.includes("text/voidshell-path")) return;
          e.preventDefault();
          e.stopPropagation();
          listEl.classList.add("drop-target");
        });
        listEl.addEventListener("dragleave", () => listEl.classList.remove("drop-target"));
        listEl.addEventListener("drop", (e) => {
          listEl.classList.remove("drop-target");
          const src = e.dataTransfer?.getData("text/voidshell-path");
          if (!src) return;
          e.preventDefault();
          e.stopPropagation();
          if (dirname(src) === cwd) return; // already here
          guard(() => {
            const dest = `${cwd}/${uniqueName(cwd, basename(src))}`;
            if (ctx.fs.stat(src).readonly) copyRecursive(ctx, src, dest);
            else ctx.fs.mv(src, dest);
          });
        });

        render();
        const off = ctx.fs.onChange(render);
        return () => {
          off();
          root.replaceChildren();
        };
      },
    });
  },
};
