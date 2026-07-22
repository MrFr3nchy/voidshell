import type { KernelContext, VoidModule } from "../../kernel/types";

/**
 * Aurora Forge is the proof that "theme" is not a setting — it's a program.
 * This module reaches into the compositor through the same public syscall
 * (`patchWorld`) any module has, and repaints the entire environment. Swap it
 * for a different module and the sky obeys a different author. That's the
 * infinite-customization payoff made literal.
 */
const PRESETS: Record<string, { cool: number; warm: number; voidColor: number; intensity: number }> = {
  spectral: { cool: 0x4fe3d0, warm: 0xc05cff, voidColor: 0x05060c, intensity: 1.0 },
  ember: { cool: 0xff8a5c, warm: 0xffd166, voidColor: 0x0c0605, intensity: 1.1 },
  abyss: { cool: 0x2b4cff, warm: 0x00e0ff, voidColor: 0x02030a, intensity: 0.85 },
  bloom: { cool: 0xff5c9c, warm: 0x9d7bff, voidColor: 0x0a0410, intensity: 1.2 },
};

export const auroraForge: VoidModule = {
  manifest: {
    id: "aurora-forge",
    name: "Aurora Forge",
    kind: "app",
    glyph: "❋",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    const saved = ctx.state.get<string>("aurora.preset", "spectral");
    if (PRESETS[saved]) ctx.patchWorld(PRESETS[saved]);
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "aurora forge",
      width: 320,
      height: 240,
      render: (root) => {
        root.innerHTML = "";
        const label = document.createElement("div");
        label.className = "forge-label";
        label.textContent = "repaint the void";
        const grid = document.createElement("div");
        grid.className = "forge-grid";

        for (const [name, preset] of Object.entries(PRESETS)) {
          const swatch = document.createElement("button");
          swatch.className = "forge-swatch";
          swatch.textContent = name;
          swatch.style.background = `linear-gradient(135deg, #${preset.cool
            .toString(16)
            .padStart(6, "0")}, #${preset.warm.toString(16).padStart(6, "0")})`;
          swatch.addEventListener("click", () => {
            ctx.patchWorld(preset);
            ctx.state.set("aurora.preset", name);
            ctx.emit("aurora.changed", { preset: name });
          });
          grid.appendChild(swatch);
        }

        const intenseWrap = document.createElement("label");
        intenseWrap.className = "forge-intensity";
        intenseWrap.textContent = "intensity";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "1.5";
        slider.step = "0.01";
        slider.value = "1";
        slider.addEventListener("input", () =>
          ctx.patchWorld({ intensity: Number(slider.value) })
        );
        intenseWrap.appendChild(slider);

        root.append(label, grid, intenseWrap);
        return () => root.replaceChildren();
      },
    });
  },
};
