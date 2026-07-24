import type { KernelContext, LaunchArgs, LogEntry, VoidModule } from "../../kernel/types";
import { ProcTable } from "../../kernel/procs";

/**
 * The system monitor.
 *
 * Three views of one machine: what is running, what has happened, and what is
 * mounted. None of it is privileged — `ps`, the journal and the mount table are
 * all on the ordinary syscall surface, and every number here can equally be got
 * with `cat /proc/…` from the console. That's the test this app exists to pass:
 * if the monitor can see something the shell can't, the shell was missing a
 * syscall.
 *
 * Kill is the one *action* here, and it's the reason a process table beats a
 * window list. Closing a window is a request to an app; killing a pid isn't.
 */

type Tab = "processes" | "journal" | "system";

export const monitor: VoidModule = {
  manifest: {
    id: "monitor",
    name: "Monitor",
    kind: "app",
    glyph: "⌘",
    blurb: "processes, the journal, and what's mounted",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "monitor.open",
      label: "system monitor",
      hint: "processes, journal, mounts",
      glyph: "⌘",
      run: (c) => c.launch("monitor"),
    });
  },

  launch(ctx: KernelContext, args?: LaunchArgs) {
    const initial = (args?.tab as Tab) ?? "processes";

    ctx.openSurface({
      title: "monitor",
      width: 520,
      height: 380,
      render: (root) => {
        root.classList.add("mon-root");

        let tab: Tab = initial;

        const tabs = document.createElement("div");
        tabs.className = "mon-tabs";
        const body = document.createElement("div");
        body.className = "mon-body";
        root.append(tabs, body);

        const tabButtons = new Map<Tab, HTMLButtonElement>();
        for (const name of ["processes", "journal", "system"] as Tab[]) {
          const b = document.createElement("button");
          b.className = "mon-tab";
          b.type = "button";
          b.textContent = name;
          b.addEventListener("click", () => {
            tab = name;
            for (const [k, el] of tabButtons) el.classList.toggle("on", k === tab);
            paint();
          });
          tabs.appendChild(b);
          tabButtons.set(name, b);
        }
        tabButtons.get(tab)?.classList.add("on");

        /* ---------------- processes ---------------- */

        const paintProcesses = () => {
          const table = document.createElement("div");
          table.className = "mon-table";

          const head = document.createElement("div");
          head.className = "mon-row is-head";
          for (const [label, cls] of [
            ["pid", "c-pid"],
            ["name", "c-name"],
            ["module", "c-mod"],
            ["state", "c-state"],
            ["elapsed", "c-time"],
            ["", "c-act"],
          ] as const) {
            const c = document.createElement("span");
            c.className = `mon-cell ${cls}`;
            c.textContent = label;
            head.appendChild(c);
          }
          table.appendChild(head);

          for (const p of ctx.ps()) {
            const row = document.createElement("div");
            row.className = `mon-row is-${p.state}`;

            const cell = (text: string, cls: string) => {
              const c = document.createElement("span");
              c.className = `mon-cell ${cls}`;
              c.textContent = text;
              row.appendChild(c);
              return c;
            };

            cell(String(p.pid), "c-pid");
            cell(p.name, "c-name");
            cell(p.moduleId, "c-mod");
            cell(p.state, "c-state");
            cell(ProcTable.elapsed(p), "c-time");

            const act = document.createElement("span");
            act.className = "mon-cell c-act";
            if (p.state === "running") {
              const kill = document.createElement("button");
              kill.className = "mon-kill";
              kill.type = "button";
              kill.textContent = "kill";
              kill.title = `terminate ${p.name} (pid ${p.pid})`;
              kill.addEventListener("click", () => {
                ctx.kill(p.pid);
                paint();
              });
              act.appendChild(kill);
            } else {
              // Daemons can't be killed, and a disabled button that looks
              // clickable is worse than no button.
              act.textContent = "—";
              act.title = "daemons keep the world running";
            }
            row.appendChild(act);
            table.appendChild(row);
          }

          const note = document.createElement("div");
          note.className = "mon-note";
          const procs = ctx.ps();
          note.textContent =
            `${procs.filter((p) => p.state === "running").length} running · ` +
            `${procs.filter((p) => p.state === "daemon").length} daemons · ` +
            `also at /proc`;

          body.replaceChildren(table, note);
        };

        /* ---------------- journal ---------------- */

        let minLevel = "debug";

        const paintJournal = () => {
          const bar = document.createElement("div");
          bar.className = "mon-filter";
          for (const level of ["debug", "info", "warn", "error"]) {
            const b = document.createElement("button");
            b.className = `mon-lvl${minLevel === level ? " on" : ""}`;
            b.type = "button";
            b.textContent = level;
            b.addEventListener("click", () => {
              minLevel = level;
              paint();
            });
            bar.appendChild(b);
          }

          const order = ["debug", "info", "warn", "error"];
          const entries = ctx
            .journal()
            .filter((e: LogEntry) => order.indexOf(e.level) >= order.indexOf(minLevel));

          const list = document.createElement("div");
          list.className = "mon-log";
          for (const e of entries) {
            const row = document.createElement("div");
            row.className = `mon-logrow is-${e.level}`;
            const t = document.createElement("span");
            t.className = "mon-logt";
            t.textContent = (e.t / 1000).toFixed(3).padStart(9);
            const tag = document.createElement("span");
            tag.className = "mon-logtag";
            tag.textContent = e.tag;
            const msg = document.createElement("span");
            msg.className = "mon-logmsg";
            msg.textContent = e.msg;
            row.append(t, tag, msg);
            list.appendChild(row);
          }
          if (!entries.length) {
            const empty = document.createElement("div");
            empty.className = "mon-note";
            empty.textContent = "nothing at that level";
            list.appendChild(empty);
          }

          const note = document.createElement("div");
          note.className = "mon-note";
          note.textContent = `${entries.length} entries · also at /var/log/system.log`;

          body.replaceChildren(bar, list, note);
          // A log you have to scroll to the bottom of is a log you don't read.
          list.scrollTop = list.scrollHeight;
        };

        /* ---------------- system ---------------- */

        const paintSystem = () => {
          const wrap = document.createElement("div");
          wrap.className = "mon-sys";

          const section = (title: string, text: string) => {
            const h = document.createElement("div");
            h.className = "mon-syshead";
            h.textContent = title;
            const pre = document.createElement("pre");
            pre.className = "mon-syspre";
            pre.textContent = text;
            wrap.append(h, pre);
          };

          const mounts = ctx.fs
            .mounts()
            .map(
              (m) =>
                `${m.at.padEnd(14)} ${m.backing.padEnd(14)} ${m.readonly ? "ro" : "rw"}`
            )
            .join("\n");
          section("mounts", mounts);

          // Read the generated files rather than recomputing: if /proc is
          // wrong, this app should be wrong in exactly the same way.
          for (const [title, path] of [
            ["memory", "/proc/meminfo"],
            ["renderer", "/proc/cpuinfo"],
            ["version", "/proc/version"],
          ] as const) {
            try {
              section(title, ctx.fs.read(path).trimEnd());
            } catch {
              section(title, "(unavailable)");
            }
          }

          body.replaceChildren(wrap);
        };

        /* ---------------- driver ---------------- */

        const paint = () => {
          if (tab === "processes") paintProcesses();
          else if (tab === "journal") paintJournal();
          else paintSystem();
        };

        paint();
        // One second is enough to feel live without repainting the DOM into a
        // performance problem; the process list is short by construction.
        const timer = window.setInterval(paint, 1000);
        return () => window.clearInterval(timer);
      },
    });
  },
};
