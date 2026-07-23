import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";
import { basename } from "../../kernel/vfs";

/**
 * A text editor.
 *
 * It exists mostly to prove the association machinery: it declares the
 * extensions it handles, the kernel routes double-clicks here, and it receives
 * the path through `launch(ctx, args)` like a program receiving argv.
 *
 * Read-only files (anything under /projects) open as a viewer instead — same
 * window, no save button, rather than a save that would fail with EROFS.
 */
export const editor: VoidModule = {
  manifest: {
    id: "editor",
    name: "Editor",
    kind: "app",
    glyph: "✎",
    version: "0.1.0",
  },

  // "*" makes this the fallback opener for any text file with no better match.
  handles: ["md", "txt", "json", "ts", "tsx", "js", "jsx", "css", "html", "py",
            "rs", "sh", "toml", "yml", "yaml", "gd", "qml", "*"],

  activate() {},

  launch(ctx: KernelContext, args?: LaunchArgs) {
    const path = args?.path;

    ctx.openSurface({
      title: path ? basename(path) : "editor",
      width: 520,
      height: 380,
      render: (root) => {
        root.innerHTML = "";
        root.className = "ed-root";

        if (!path) {
          const empty = document.createElement("div");
          empty.className = "ed-empty";
          empty.textContent =
            "No file. Open one from the desktop or Files, or use `open editor` with a path.";
          root.appendChild(empty);
          return () => root.replaceChildren();
        }

        let text = "";
        let readonly = true;
        let error = "";
        try {
          text = ctx.fs.read(path);
          readonly = ctx.fs.stat(path).readonly;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        const head = document.createElement("div");
        head.className = "ed-head";
        head.textContent = path;
        root.appendChild(head);

        if (error) {
          const e = document.createElement("div");
          e.className = "ed-empty warn";
          e.textContent = error;
          root.append(e);
          return () => root.replaceChildren();
        }

        if (readonly) {
          const pre = document.createElement("pre");
          const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
          const prose = ext === "md" || ext === "txt";
          pre.className = `ed-pre${prose ? " wrap" : ""}`;
          pre.textContent = text;
          const badge = document.createElement("span");
          badge.className = "ed-badge";
          badge.textContent = "read-only";
          head.appendChild(badge);
          root.appendChild(pre);
          return () => root.replaceChildren();
        }

        const ta = document.createElement("textarea");
        ta.className = "ed-area";
        ta.value = text;
        ta.spellcheck = false;

        const bar = document.createElement("div");
        bar.className = "ed-bar";
        const status = document.createElement("span");
        status.className = "ed-status";
        const save = document.createElement("button");
        save.className = "fm-btn";
        save.textContent = "save";

        const doSave = () => {
          try {
            ctx.fs.write(path, ta.value);
            status.textContent = "saved";
            setTimeout(() => (status.textContent = ""), 1400);
          } catch (err) {
            status.textContent = err instanceof Error ? err.message : String(err);
          }
        };

        save.addEventListener("click", doSave);
        ta.addEventListener("input", () => (status.textContent = "modified"));
        ta.addEventListener("keydown", (e) => {
          // Ctrl/Cmd+S saves, as everywhere else.
          if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            doSave();
          }
          e.stopPropagation();
        });

        bar.append(status, save);
        root.append(ta, bar);
        return () => root.replaceChildren();
      },
    });
  },
};
