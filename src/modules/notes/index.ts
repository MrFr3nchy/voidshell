import type { KernelContext, VoidModule } from "../../kernel/types";

const INDEX_KEY = "notes.index";
const DOC_KEY = (id: string) => `notes.doc.${id}`;

interface NoteMeta {
  id: string;
  title: string;
}

/**
 * Notes exists to prove the store is a real filesystem-shaped thing: text
 * typed here survives a reload, a wipe of the window, and the heat death of
 * the tab, without this module knowing anything about persistence. It writes
 * to shared memory; the kernel mirrors shared memory to disk. That's the whole
 * contract, and every future app gets it for free.
 */
export const notes: VoidModule = {
  manifest: {
    id: "notes",
    name: "Notes",
    kind: "app",
    glyph: "\u270e",
    blurb: "text that outlives the tab",
    version: "0.1.0",
  },

  activate() {},

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "notes",
      width: 480,
      height: 340,
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
        bodyEl.placeholder = "write into the void\u2026";
        const delBtn = document.createElement("button");
        delBtn.className = "notes-del";
        delBtn.textContent = "delete this note";
        pane.append(titleEl, bodyEl, delBtn);

        root.append(side, pane);

        const read = (): NoteMeta[] => ctx.state.get<NoteMeta[]>(INDEX_KEY, []);
        const write = (list: NoteMeta[]) => ctx.state.set(INDEX_KEY, list);

        let currentId = "";

        const paintList = () => {
          const list = read();
          listEl.replaceChildren();
          for (const n of list) {
            const b = document.createElement("button");
            b.className = "notes-item";
            b.classList.toggle("on", n.id === currentId);
            b.textContent = n.title || "untitled";
            b.addEventListener("click", () => select(n.id));
            listEl.appendChild(b);
          }
          if (!list.length) {
            const empty = document.createElement("div");
            empty.className = "notes-empty";
            empty.textContent = "no notes";
            listEl.appendChild(empty);
          }
        };

        const select = (id: string) => {
          currentId = id;
          const meta = read().find((n) => n.id === id);
          titleEl.value = meta?.title ?? "";
          bodyEl.value = ctx.state.get<string>(DOC_KEY(id), "");
          const has = Boolean(meta);
          titleEl.disabled = !has;
          bodyEl.disabled = !has;
          delBtn.style.visibility = has ? "visible" : "hidden";
          paintList();
        };

        const create = () => {
          const id = `n${Date.now().toString(36)}`;
          const list = read();
          list.unshift({ id, title: "" });
          write(list);
          ctx.state.set(DOC_KEY(id), "");
          select(id);
          requestAnimationFrame(() => titleEl.focus());
        };

        addBtn.addEventListener("click", create);

        titleEl.addEventListener("input", () => {
          const list = read();
          const meta = list.find((n) => n.id === currentId);
          if (!meta) return;
          meta.title = titleEl.value;
          write(list);
          paintList();
        });

        bodyEl.addEventListener("input", () => {
          if (currentId) ctx.state.set(DOC_KEY(currentId), bodyEl.value);
        });

        delBtn.addEventListener("click", () => {
          if (!currentId) return;
          write(read().filter((n) => n.id !== currentId));
          ctx.state.set(DOC_KEY(currentId), "");
          const next = read()[0];
          select(next ? next.id : "");
        });

        const first = read()[0];
        if (first) select(first.id);
        else create();

        return () => root.replaceChildren();
      },
    });
  },
};
