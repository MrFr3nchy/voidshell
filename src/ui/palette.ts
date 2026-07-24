import type { KernelContext } from "../kernel/types";
import { escapeHtml } from "./spawner";

interface Row {
  glyph: string;
  label: string;
  hint: string;
  run: () => void;
}

export interface Palette {
  toggle(next?: boolean): void;
  isOpen(): boolean;
}

/**
 * One keystroke to everything. The palette merges three sources — installed
 * apps, registered commands, and every window currently open — so "where is
 * that thing" and "how do I do that thing" are the same question.
 */
export function createPalette(hud: HTMLElement, ctx: KernelContext): Palette {
  const root = document.createElement("div");
  root.className = "palette";
  root.innerHTML = `
    <div class="palette-sheet">
      <input class="palette-input" type="text" placeholder="do something\u2026" aria-label="Command palette" />
      <div class="palette-list" role="listbox"></div>
    </div>`;
  hud.appendChild(root);

  const sheet = root.querySelector(".palette-sheet") as HTMLElement;
  const input = root.querySelector(".palette-input") as HTMLInputElement;
  const list = root.querySelector(".palette-list") as HTMLElement;

  let open = false;
  let rows: Row[] = [];
  let cursor = 0;

  const sources = (): Row[] => {
    const out: Row[] = [];
    for (const m of ctx.registry()) {
      if (m.kind !== "app") continue;
      out.push({
        glyph: m.glyph ?? "\u00b7",
        label: m.name,
        hint: m.blurb ?? "launch",
        run: () => ctx.launch(m.id),
      });
    }
    for (const c of ctx.commands()) {
      out.push({
        glyph: c.glyph ?? "\u203a",
        label: c.label,
        hint: c.hint ?? "command",
        run: () => c.run(ctx),
      });
    }
    for (const s of ctx.openSurfaces()) {
      out.push({
        glyph: "\u25c9",
        label: `go to ${s.title}`,
        hint: "open window",
        run: () => {
          ctx.focusSurface(s.id);
          ctx.lookAt(s.id);
        },
      });
    }
    for (const g of ctx.listGroups()) {
      out.push({
        glyph: "\u2059",
        label: `go to ${g.name}`,
        hint: `constellation \u00b7 ${g.members.length} windows`,
        run: () => ctx.lookAtGroup(g.id),
      });
    }
    return out;
  };

  const build = () => {
    const q = input.value.trim().toLowerCase();
    rows = sources()
      .map((r) => ({ r, score: score(`${r.label} ${r.hint}`.toLowerCase(), q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 12)
      .map((x) => x.r);

    cursor = 0;
    list.replaceChildren();
    rows.forEach((r, i) => {
      const el = document.createElement("button");
      el.className = "palette-row";
      el.setAttribute("role", "option");
      el.innerHTML = `<span class="row-glyph">${r.glyph}</span><span class="row-label">${escapeHtml(
        r.label
      )}</span><span class="row-hint">${escapeHtml(r.hint)}</span>`;
      el.addEventListener("click", () => {
        r.run();
        toggle(false);
      });
      el.addEventListener("pointerenter", () => {
        cursor = i;
        paint();
      });
      list.appendChild(el);
    });
    paint();
  };

  const paint = () => {
    const kids = [...list.children] as HTMLElement[];
    kids.forEach((k, i) => k.classList.toggle("cursor", i === cursor));
    kids[cursor]?.scrollIntoView({ block: "nearest" });
  };

  const toggle = (next?: boolean) => {
    open = next ?? !open;
    root.classList.toggle("open", open);
    if (open) {
      input.value = "";
      build();
      requestAnimationFrame(() => input.focus());
    } else {
      input.blur();
    }
  };

  input.addEventListener("input", build);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return toggle(false);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = Math.min(rows.length - 1, cursor + 1);
      paint();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = Math.max(0, cursor - 1);
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[cursor]?.run();
      toggle(false);
    }
  });
  root.addEventListener("pointerdown", (e) => {
    if (!sheet.contains(e.target as Node)) toggle(false);
  });

  return { toggle, isOpen: () => open };
}

/**
 * Subsequence match: "arng" finds "arrange windows". Returns a rough cost so
 * tighter, earlier matches float up, or -1 when the query doesn't fit at all.
 */
function score(haystack: string, needle: string): number {
  if (!needle) return 0;
  let i = 0;
  let cost = 0;
  let last = -1;
  for (const ch of needle) {
    const at = haystack.indexOf(ch, i);
    if (at < 0) return -1;
    cost += at - (last + 1);
    last = at;
    i = at + 1;
  }
  return cost + haystack.length * 0.01;
}
