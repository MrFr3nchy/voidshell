import type { KernelContext, SettingDef, VoidModule } from "../../kernel/types";

/** Groups we know we want first; anything else lands after, alphabetically. */
const GROUP_ORDER = ["Appearance", "Launcher", "World", "System"];

/**
 * Settings renders nothing of its own. It walks the kernel's settings registry
 * and builds a control for whatever it finds, so a new module publishing a knob
 * shows up here without a single line changing in this file. That's the whole
 * bargain: the settings screen is a *view* of the OS, not a hardcoded list of
 * everything the OS happens to support today.
 */
export const settings: VoidModule = {
  manifest: {
    id: "settings",
    name: "Settings",
    kind: "app",
    glyph: "\u2699",
    blurb: "every knob, from every module",
    version: "0.1.0",
  },

  activate() {},

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "settings",
      width: 460,
      height: 520,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("set-root");

        const search = document.createElement("input");
        search.className = "set-search";
        search.type = "text";
        search.placeholder = "search settings\u2026";
        search.setAttribute("aria-label", "Search settings");

        const tabs = document.createElement("div");
        tabs.className = "set-tabs";

        const body = document.createElement("div");
        body.className = "set-body";

        root.append(search, tabs, body);

        let active = GROUP_ORDER[0];
        const teardowns: (() => void)[] = [];

        const groupsOf = (defs: SettingDef[]) => {
          const names = [...new Set(defs.map((d) => d.group))];
          return names.sort((a, b) => {
            const ai = GROUP_ORDER.indexOf(a);
            const bi = GROUP_ORDER.indexOf(b);
            if (ai < 0 && bi < 0) return a.localeCompare(b);
            if (ai < 0) return 1;
            if (bi < 0) return -1;
            return ai - bi;
          });
        };

        const paint = () => {
          // Custom controls hand back their own cleanup; run everything the
          // previous paint registered before we throw the DOM away.
          for (const t of teardowns.splice(0)) t();

          const q = search.value.trim().toLowerCase();
          const all = ctx.settings();
          const matching = q
            ? all.filter((d) =>
                `${d.label} ${d.hint ?? ""} ${d.key} ${d.group}`.toLowerCase().includes(q)
              )
            : all;

          const groups = groupsOf(matching);
          if (!groups.includes(active)) active = groups[0] ?? "";

          tabs.replaceChildren();
          for (const g of groups) {
            const b = document.createElement("button");
            b.className = "set-tab";
            b.classList.toggle("on", g === active);
            b.textContent = g.toLowerCase();
            b.addEventListener("click", () => {
              active = g;
              paint();
            });
            tabs.appendChild(b);
          }

          body.replaceChildren();
          const defs = matching.filter((d) => d.group === active);
          if (!defs.length) {
            const empty = document.createElement("div");
            empty.className = "set-empty";
            empty.textContent = "nothing here matches";
            body.appendChild(empty);
            return;
          }
          for (const def of defs) body.appendChild(control(def, ctx, teardowns));
        };

        search.addEventListener("input", paint);
        const off = ctx.on("settings.changed", () => paint());
        paint();

        return () => {
          off();
          for (const t of teardowns.splice(0)) t();
          root.replaceChildren();
        };
      },
    });
  },
};

function control(
  def: SettingDef,
  ctx: KernelContext,
  teardowns: (() => void)[]
): HTMLElement {
  const row = document.createElement("div");
  row.className = `set-row kind-${def.kind}`;

  const head = document.createElement("div");
  head.className = "set-head";
  const label = document.createElement("div");
  label.className = "set-label";
  label.textContent = def.label;
  head.appendChild(label);
  row.appendChild(head);

  if (def.hint) {
    const hint = document.createElement("div");
    hint.className = "set-hint";
    hint.textContent = def.hint;
    row.appendChild(hint);
  }

  switch (def.kind) {
    case "toggle": {
      const btn = document.createElement("button");
      btn.className = "set-switch";
      const sync = () =>
        btn.classList.toggle("on", ctx.state.get<boolean>(def.key, Boolean(def.default)));
      btn.addEventListener("click", () => {
        ctx.state.set(def.key, !ctx.state.get<boolean>(def.key, Boolean(def.default)));
      });
      teardowns.push(ctx.state.subscribe(def.key, sync));
      sync();
      head.appendChild(btn);
      break;
    }

    case "slider": {
      const value = document.createElement("span");
      value.className = "set-value";
      const input = document.createElement("input");
      input.type = "range";
      input.className = "set-range";
      input.min = String(def.min ?? 0);
      input.max = String(def.max ?? 1);
      input.step = String(def.step ?? 0.01);
      const sync = () => {
        const v = ctx.state.get<number>(def.key, Number(def.default ?? 0));
        input.value = String(v);
        value.textContent = `${trim(v)}${def.unit ?? ""}`;
      };
      input.addEventListener("input", () => ctx.state.set(def.key, Number(input.value)));
      teardowns.push(ctx.state.subscribe(def.key, sync));
      sync();
      head.appendChild(value);
      row.appendChild(input);
      break;
    }

    case "select": {
      const sel = document.createElement("select");
      sel.className = "cos-select";
      for (const o of def.options ?? []) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      const sync = () => {
        sel.value = ctx.state.get<string>(def.key, String(def.default ?? ""));
      };
      sel.addEventListener("change", () => ctx.state.set(def.key, sel.value));
      teardowns.push(ctx.state.subscribe(def.key, sync));
      sync();
      row.appendChild(sel);
      break;
    }

    case "color": {
      const wrap = document.createElement("div");
      wrap.className = "set-colorwrap";
      const input = document.createElement("input");
      input.type = "color";
      input.className = "set-color";
      const hex = document.createElement("span");
      hex.className = "set-value";
      const sync = () => {
        const v = ctx.state.get<string>(def.key, String(def.default ?? "#000000"));
        input.value = v;
        hex.textContent = v;
      };
      input.addEventListener("input", () => ctx.state.set(def.key, input.value));
      teardowns.push(ctx.state.subscribe(def.key, sync));
      sync();
      wrap.append(input, hex);
      row.appendChild(wrap);
      break;
    }

    case "action": {
      const btn = document.createElement("button");
      btn.className = "set-btn wide";
      btn.textContent = def.label;
      btn.addEventListener("click", () => def.run?.(ctx));
      head.remove();
      row.insertBefore(btn, row.firstChild);
      break;
    }

    case "custom": {
      const host = document.createElement("div");
      host.className = "set-custom";
      const cleanup = def.render?.(host, ctx);
      if (typeof cleanup === "function") teardowns.push(cleanup);
      row.appendChild(host);
      break;
    }
  }

  return row;
}

function trim(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, "");
}
