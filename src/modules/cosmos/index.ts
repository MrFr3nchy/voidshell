import type { BodyKind, KernelContext, VoidModule } from "../../kernel/types";

/**
 * Cosmos spawns celestial bodies into the void and lets you merge open windows
 * onto them. A merged window anchors to the body's position and rides along as
 * the body drifts — the "windows on a planet" idea made literal, using the same
 * projected-anchor mechanism every panel already uses.
 */
export const cosmos: VoidModule = {
  manifest: {
    id: "cosmos",
    name: "Cosmos",
    kind: "app",
    glyph: "\u2609",
    version: "0.1.0",
  },

  activate() {},

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "cosmos",
      width: 340,
      height: 340,
      render: (root) => {
        root.innerHTML = "";

        const spawnLabel = document.createElement("div");
        spawnLabel.className = "cos-label";
        spawnLabel.textContent = "spawn a body";

        const spawnRow = document.createElement("div");
        spawnRow.className = "cos-row";
        (["sun", "moon", "planet"] as BodyKind[]).forEach((kind) => {
          const b = document.createElement("button");
          b.className = "cos-btn";
          b.textContent = kind;
          b.addEventListener("click", () => {
            ctx.spawnBody(kind);
            refresh();
          });
          spawnRow.appendChild(b);
        });

        const chips = document.createElement("div");
        chips.className = "cos-chips";

        const divider = document.createElement("div");
        divider.className = "cos-divider";

        const mergeLabel = document.createElement("div");
        mergeLabel.className = "cos-label";
        mergeLabel.textContent = "merge a window onto a body";

        const winSel = document.createElement("select");
        winSel.className = "cos-select";
        const bodySel = document.createElement("select");
        bodySel.className = "cos-select";

        const actions = document.createElement("div");
        actions.className = "cos-actions";
        const mergeBtn = document.createElement("button");
        mergeBtn.className = "cos-btn";
        mergeBtn.textContent = "merge";
        const detachBtn = document.createElement("button");
        detachBtn.className = "cos-btn";
        detachBtn.textContent = "release";
        actions.append(mergeBtn, detachBtn);

        mergeBtn.addEventListener("click", () => {
          if (winSel.value && bodySel.value) ctx.attachSurface(winSel.value, bodySel.value);
        });
        detachBtn.addEventListener("click", () => {
          if (winSel.value) ctx.attachSurface(winSel.value, null);
        });

        const refreshBtn = document.createElement("button");
        refreshBtn.className = "cos-btn";
        refreshBtn.textContent = "refresh list";
        refreshBtn.style.marginTop = "8px";
        refreshBtn.style.width = "100%";
        refreshBtn.addEventListener("click", () => refresh());

        function refresh() {
          const bodies = ctx.listBodies();
          chips.replaceChildren();
          if (bodies.length === 0) {
            const empty = document.createElement("span");
            empty.className = "cos-chip";
            empty.textContent = "no bodies yet";
            chips.appendChild(empty);
          }
          for (const b of bodies) {
            const chip = document.createElement("span");
            chip.className = "cos-chip";
            chip.textContent = `${b.kind} ${b.id.replace("body-", "#")}`;
            chips.appendChild(chip);
          }

          bodySel.replaceChildren();
          for (const b of bodies) {
            const o = document.createElement("option");
            o.value = b.id;
            o.textContent = `${b.kind} ${b.id.replace("body-", "#")}`;
            bodySel.appendChild(o);
          }

          winSel.replaceChildren();
          for (const s of ctx.openSurfaces()) {
            if (s.title === "cosmos") continue;
            const o = document.createElement("option");
            o.value = s.id;
            o.textContent = s.title;
            winSel.appendChild(o);
          }
        }

        root.append(
          spawnLabel,
          spawnRow,
          chips,
          divider,
          mergeLabel,
          winSel,
          bodySel,
          actions,
          refreshBtn
        );
        refresh();

        return () => root.replaceChildren();
      },
    });
  },
};
