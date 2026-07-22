import type { KernelContext, VoidModule } from "../../kernel/types";

/**
 * A clock. The smallest possible real app — proof that a module can be trivial
 * and still be a first-class citizen with its own surface and lifecycle.
 */
export const chronos: VoidModule = {
  manifest: {
    id: "chronos",
    name: "Chronos",
    kind: "app",
    glyph: "◷",
    version: "0.1.0",
  },

  activate() {},

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "chronos",
      width: 300,
      height: 150,
      render: (root) => {
        root.innerHTML = "";
        const time = document.createElement("div");
        time.className = "chronos-time";
        const date = document.createElement("div");
        date.className = "chronos-date";
        root.append(time, date);

        const tick = () => {
          const now = new Date();
          time.textContent = now.toLocaleTimeString([], { hour12: false });
          date.textContent = now.toLocaleDateString([], {
            weekday: "long",
            month: "short",
            day: "numeric",
          });
        };
        tick();
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
      },
    });
  },
};
