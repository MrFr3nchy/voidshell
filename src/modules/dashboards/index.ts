import type { KernelContext, SavedDashboard, VoidModule } from "../../kernel/types";

const SAVED_KEY = "dashboards.saved";

/**
 * A dashboard is several windows that agree to be one thing: drag any member
 * and the whole constellation travels, light threads draw between them, and
 * the edge compass reports them as a single destination instead of four.
 *
 * Live constellations are the compositor's business. This app is the part that
 * makes them *durable* — a saved dashboard is just a name and a list of apps,
 * so it survives a reload and re-assembles itself on demand.
 */
export const dashboards: VoidModule = {
  manifest: {
    id: "dashboards",
    name: "Dashboards",
    kind: "app",
    glyph: "\u229e",
    blurb: "bind windows into constellations",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "dashboards.open",
      label: "dashboards",
      hint: "build a constellation",
      glyph: "\u229e",
      run: (c) => c.launch("dashboards"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "dashboards",
      width: 400,
      height: 460,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("dash-root");

        const picked = new Set<string>();

        const pickLabel = section("windows to bind");
        const picker = document.createElement("div");
        picker.className = "dash-picker";

        const nameRow = document.createElement("div");
        nameRow.className = "dash-namerow";
        const name = document.createElement("input");
        name.className = "dash-name";
        name.type = "text";
        name.placeholder = "constellation name\u2026";
        const linkBtn = document.createElement("button");
        linkBtn.className = "cos-btn";
        linkBtn.textContent = "bind";
        nameRow.append(name, linkBtn);

        const liveLabel = section("live constellations");
        const live = document.createElement("div");
        live.className = "dash-list";

        const savedLabel = section("saved");
        const saved = document.createElement("div");
        saved.className = "dash-list";

        const tip = document.createElement("div");
        tip.className = "dash-tip";
        tip.textContent =
          "shortcut: drag a window's \u2059 handle onto another window to bind them without opening this.";

        root.append(
          pickLabel,
          picker,
          nameRow,
          liveLabel,
          live,
          savedLabel,
          saved,
          tip
        );

        const readSaved = () => ctx.state.get<SavedDashboard[]>(SAVED_KEY, []);
        const writeSaved = (list: SavedDashboard[]) => ctx.state.set(SAVED_KEY, list);

        const refresh = () => {
          /* --- picker --- */
          picker.replaceChildren();
          const windows = ctx.openSurfaces().filter((s) => s.moduleId !== "dashboards");
          if (!windows.length) {
            picker.appendChild(muted("open a couple of windows first"));
          }
          for (const s of windows) {
            const chip = document.createElement("button");
            chip.className = "dash-chip";
            chip.classList.toggle("on", picked.has(s.id));
            chip.textContent = s.title;
            chip.addEventListener("click", () => {
              if (picked.has(s.id)) picked.delete(s.id);
              else picked.add(s.id);
              refresh();
            });
            picker.appendChild(chip);
          }

          /* --- live groups --- */
          live.replaceChildren();
          const groups = ctx.listGroups();
          if (!groups.length) live.appendChild(muted("nothing bound yet"));
          for (const g of groups) {
            const row = document.createElement("div");
            row.className = "dash-row";
            const title = document.createElement("span");
            title.className = "dash-rowname";
            title.textContent = `${g.name} \u00b7 ${g.members.length}`;

            const go = mini("go", () => ctx.lookAtGroup(g.id));
            const keep = mini("save", () => {
              const moduleIds = g.members
                .map((m) => ctx.openSurfaces().find((s) => s.id === m)?.moduleId)
                .filter((x): x is string => Boolean(x));
              const list = readSaved();
              list.push({ id: `dash-${Date.now()}`, name: g.name, moduleIds });
              writeSaved(list);
              ctx.notify(`saved "${g.name}"`, "good");
              refresh();
            });
            const cut = mini("dissolve", () => {
              ctx.unlinkGroup(g.id);
              refresh();
            });

            row.append(title, go, keep, cut);
            live.appendChild(row);
          }

          /* --- saved --- */
          saved.replaceChildren();
          const list = readSaved();
          if (!list.length) saved.appendChild(muted("no saved dashboards"));
          for (const d of list) {
            const row = document.createElement("div");
            row.className = "dash-row";
            const title = document.createElement("span");
            title.className = "dash-rowname";
            title.textContent = `${d.name} \u00b7 ${d.moduleIds.length}`;

            const open = mini("open", () => {
              const ids: string[] = [];
              for (const moduleId of d.moduleIds) {
                ctx.launch(moduleId);
                const surface = ctx
                  .openSurfaces()
                  .find((s) => s.moduleId === moduleId && !ids.includes(s.id));
                if (surface) ids.push(surface.id);
              }
              if (ids.length > 1) ctx.linkSurfaces(ids, d.name);
              ctx.notify(`opened "${d.name}"`, "good");
              refresh();
            });
            const drop = mini("forget", () => {
              writeSaved(readSaved().filter((x) => x.id !== d.id));
              refresh();
            });

            row.append(title, open, drop);
            saved.appendChild(row);
          }
        };

        linkBtn.addEventListener("click", () => {
          const ids = [...picked].filter((id) =>
            ctx.openSurfaces().some((s) => s.id === id)
          );
          if (ids.length < 2) {
            ctx.notify("pick at least two windows", "warn");
            return;
          }
          const id = ctx.linkSurfaces(ids, name.value);
          if (id) {
            ctx.notify(`bound ${ids.length} windows`, "good");
            picked.clear();
            name.value = "";
          }
          refresh();
        });

        const offs = [
          ctx.on("surface.opened", refresh),
          ctx.on("surface.closed", refresh),
        ];
        refresh();

        return () => {
          offs.forEach((off) => off());
          root.replaceChildren();
        };
      },
    });
  },
};

function section(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "cos-label";
  el.textContent = text;
  return el;
}

function muted(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "cos-chip";
  el.textContent = text;
  return el;
}

function mini(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "dash-mini";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
