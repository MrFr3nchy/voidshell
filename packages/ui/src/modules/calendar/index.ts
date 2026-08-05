import type { KernelContext, VoidModule } from "../../kernel/types";
import { HOME } from "../../kernel/fsutil";

/**
 * A month at a time, and what you wrote on those days.
 *
 * The other half is why this isn't just a grid: a day's note is a Markdown
 * file at `~/notes/journal/YYYY-MM-DD.md`. Nothing about it is special — the
 * editor opens it, `grep` finds it, the trash catches it — so the calendar is
 * a *view* of the filesystem rather than a second private store, which is the
 * mistake Notes used to make.
 */

const JOURNAL_DIR = `${HOME}/notes/journal`;
const DAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];

/** `2026-08-04`. Local, not UTC — a journal entry belongs to your day. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Monday-first weekday index, which is what the header row is written for. */
function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export const calendar: VoidModule = {
  manifest: {
    id: "calendar",
    name: "Calendar",
    kind: "app",
    glyph: "▦",
    blurb: "a month, and the day's note",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "calendar.today",
      label: "Today's note",
      hint: "open the journal entry for today",
      glyph: "▦",
      run: (c) => {
        c.fs.mkdirp(JOURNAL_DIR);
        const path = `${JOURNAL_DIR}/${dayKey(new Date())}.md`;
        if (!c.fs.exists(path)) {
          c.fs.write(path, `# ${new Date().toDateString()}\n\n`);
        }
        c.openPath(path);
      },
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "calendar",
      width: 420,
      height: 400,
      render: (root) => {
        root.innerHTML = "";
        root.className = "cal-root";

        const bar = document.createElement("div");
        bar.className = "cal-bar";
        const prev = document.createElement("button");
        prev.className = "fm-btn";
        prev.textContent = "‹";
        const label = document.createElement("span");
        label.className = "cal-month";
        const next = document.createElement("button");
        next.className = "fm-btn";
        next.textContent = "›";
        const todayBtn = document.createElement("button");
        todayBtn.className = "fm-btn";
        todayBtn.textContent = "today";
        bar.append(prev, label, next, todayBtn);

        const head = document.createElement("div");
        head.className = "cal-head";
        for (const d of DAYS) {
          const c = document.createElement("span");
          c.textContent = d;
          head.appendChild(c);
        }

        const grid = document.createElement("div");
        grid.className = "cal-grid";

        const foot = document.createElement("div");
        foot.className = "cal-foot";

        root.append(bar, head, grid, foot);

        const today = new Date();
        let cursor = new Date(today.getFullYear(), today.getMonth(), 1);

        /** Which days of the shown month already have a journal entry. */
        const written = (): Set<string> => {
          const out = new Set<string>();
          try {
            for (const e of ctx.fs.ls(JOURNAL_DIR)) {
              if (e.kind === "file") out.add(e.name.replace(/\.md$/, ""));
            }
          } catch {
            /* no journal yet — every day is simply blank */
          }
          return out;
        };

        const openDay = (date: Date) => {
          const key = dayKey(date);
          const path = `${JOURNAL_DIR}/${key}.md`;
          try {
            ctx.fs.mkdirp(JOURNAL_DIR);
            if (!ctx.fs.exists(path)) {
              ctx.fs.write(
                path,
                `# ${date.toLocaleDateString([], {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}\n\n`
              );
            }
            ctx.openPath(path);
          } catch (err) {
            ctx.notify(err instanceof Error ? err.message : String(err), "warn");
          }
        };

        const paint = () => {
          label.textContent = cursor.toLocaleDateString([], { month: "long", year: "numeric" });
          const entries = written();

          const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
          const lead = weekdayIndex(first);
          const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

          grid.replaceChildren();
          // Trailing days of the previous month keep the grid rectangular, so
          // the weekday columns line up whatever month you're looking at.
          for (let i = 0; i < lead; i++) {
            const pad = document.createElement("span");
            pad.className = "cal-day pad";
            grid.appendChild(pad);
          }

          for (let d = 1; d <= days; d++) {
            const date = new Date(cursor.getFullYear(), cursor.getMonth(), d);
            const key = dayKey(date);
            const cell = document.createElement("button");
            cell.className = "cal-day";
            cell.classList.toggle("today", key === dayKey(today));
            cell.classList.toggle("has-note", entries.has(key));
            cell.classList.toggle("weekend", weekdayIndex(date) >= 5);
            cell.textContent = String(d);
            cell.title = entries.has(key) ? `${key} — has a note` : key;
            cell.addEventListener("click", () => openDay(date));
            grid.appendChild(cell);
          }

          const mine = [...entries].filter((k) => k.startsWith(monthKey())).length;
          foot.textContent = mine
            ? `${mine} note${mine === 1 ? "" : "s"} this month · click a day to open its note`
            : "click a day to start its note";
        };

        const monthKey = () =>
          `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;

        const shift = (months: number) => {
          cursor = new Date(cursor.getFullYear(), cursor.getMonth() + months, 1);
          paint();
        };

        prev.addEventListener("click", () => shift(-1));
        next.addEventListener("click", () => shift(1));
        todayBtn.addEventListener("click", () => {
          cursor = new Date(today.getFullYear(), today.getMonth(), 1);
          paint();
        });

        paint();
        // A note written from the editor has to show up as a dot here.
        const off = ctx.fs.onChange(paint);

        return () => {
          off();
          root.replaceChildren();
        };
      },
    });
  },
};
