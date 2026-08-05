import type { KernelContext, VoidModule } from "../../kernel/types";
import { fileTypeFor } from "../../kernel/filetypes";
import { formatSize, tildify, timeAgo } from "../../kernel/fsutil";
import {
  TRASH_DIR,
  emptyTrash,
  listTrash,
  restoreFromTrash,
  type TrashItem,
} from "../../kernel/trash";

/**
 * The trash, with a window.
 *
 * Everything here already existed — trashing is a move to ~/.Trash and the
 * manifest that remembers where each thing came from has been in the store
 * since it was written. What was missing is the only part a person actually
 * uses: seeing what's in there, and putting one thing back. Until now that
 * meant opening the console and typing `restore` with a name you had to have
 * memorised from a toast that vanished after two seconds.
 *
 * It reads the same manifest the console does, so the two can't drift.
 */
export const trash: VoidModule = {
  manifest: {
    id: "trash",
    name: "Trash",
    kind: "app",
    glyph: "⌫",
    blurb: "what you deleted, and how to get it back",
    version: "0.1.0",
  },

  // Deliberately claims no file type. ~/.Trash is an ordinary directory and
  // browsing it in the file manager is a reasonable thing to want; what this
  // app adds is the manifest — where each thing came from — which no listing
  // of that directory can show.

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "trash.open",
      label: "Open the trash",
      hint: "restore or empty deleted files",
      glyph: "⌫",
      run: (c) => c.launch("trash"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "trash",
      width: 520,
      height: 400,
      render: (root) => {
        root.innerHTML = "";
        root.className = "tr-root";

        const bar = document.createElement("div");
        bar.className = "tr-bar";
        const count = document.createElement("span");
        count.className = "tr-count";
        const emptyBtn = document.createElement("button");
        emptyBtn.className = "fm-btn danger";
        emptyBtn.textContent = "empty trash";
        bar.append(count, emptyBtn);

        const list = document.createElement("div");
        list.className = "tr-list";

        root.append(bar, list);

        const guard = (fn: () => void) => {
          try {
            fn();
          } catch (err) {
            ctx.notify(err instanceof Error ? err.message : String(err), "warn");
          }
        };

        const sizeOf = (item: TrashItem): string => {
          try {
            const st = ctx.fs.stat(`${TRASH_DIR}/${item.name}`);
            return st.kind === "dir" ? `${ctx.fs.ls(st.path).length} items` : formatSize(st.size);
          } catch {
            return "";
          }
        };

        const render = () => {
          const items = [...listTrash(ctx)].sort((a, b) => b.at - a.at);
          list.replaceChildren();
          count.textContent = items.length
            ? `${items.length} item${items.length === 1 ? "" : "s"}`
            : "the trash is empty";
          emptyBtn.disabled = !items.length;

          for (const item of items) {
            const row = document.createElement("div");
            row.className = "tr-row";

            const type = fileTypeFor(item.from, item.kind);
            const glyph = document.createElement("span");
            glyph.className = `tr-glyph fam-${type.family}`;
            glyph.textContent = type.glyph;

            const meta = document.createElement("div");
            meta.className = "tr-meta";
            const name = document.createElement("div");
            name.className = "tr-name";
            name.textContent = item.name;
            // Where it came from is the fact that makes a restore make sense,
            // and it is the one thing a plain listing of ~/.Trash cannot show.
            const from = document.createElement("div");
            from.className = "tr-from";
            from.textContent = `${tildify(item.from)} · deleted ${timeAgo(item.at)} · ${sizeOf(item)}`;
            meta.append(name, from);

            const put = document.createElement("button");
            put.className = "fm-btn";
            put.textContent = "put back";
            put.addEventListener("click", () =>
              guard(() => {
                const back = restoreFromTrash(ctx, item.name);
                ctx.notify(`restored ${tildify(back)}`, {
                  kind: "good",
                  action: { label: "show it", run: (c) => c.openPath(back) },
                });
              })
            );

            const gone = document.createElement("button");
            gone.className = "fm-btn danger";
            gone.textContent = "delete";
            gone.title = "Delete this permanently";
            gone.addEventListener("click", () =>
              guard(() => {
                ctx.fs.rm(`${TRASH_DIR}/${item.name}`, true);
                ctx.notify(`${item.name} is gone for good`);
              })
            );

            row.append(glyph, meta, put, gone);
            list.appendChild(row);
          }
        };

        // Two clicks to empty. The first is a request, the second is consent —
        // and this is the one action in the shell with nothing behind it.
        let armed = false;
        let armTimer = 0;
        emptyBtn.addEventListener("click", () => {
          if (!armed) {
            armed = true;
            emptyBtn.textContent = "click again to confirm";
            emptyBtn.classList.add("armed");
            armTimer = window.setTimeout(() => {
              armed = false;
              emptyBtn.textContent = "empty trash";
              emptyBtn.classList.remove("armed");
            }, 4000);
            return;
          }
          window.clearTimeout(armTimer);
          armed = false;
          emptyBtn.textContent = "empty trash";
          emptyBtn.classList.remove("armed");
          guard(() => {
            const n = emptyTrash(ctx);
            ctx.notify(n ? `deleted ${n} item${n === 1 ? "" : "s"} for good` : "already empty");
          });
        });

        render();
        const off = ctx.fs.onChange(render);

        return () => {
          off();
          window.clearTimeout(armTimer);
          root.replaceChildren();
        };
      },
    });
  },
};
