import type { BodyKind, KernelContext, VoidModule } from "../../kernel/types";

const KINDS: { kind: BodyKind; glyph: string; blurb: string }[] = [
  { kind: "sun", glyph: "\u2609", blurb: "a burning anchor" },
  { kind: "moon", glyph: "\u263d", blurb: "quiet and pale" },
  { kind: "planet", glyph: "\u2295", blurb: "ringed, indifferent" },
  { kind: "singularity", glyph: "\u2b24", blurb: "eats what you feed it" },
];

/**
 * Cosmos spawns celestial bodies into the void and lets windows ride them.
 *
 * Merging is a drag now, not a form: pull a window's \u2059 handle onto a body and
 * the window anchors to it and rides its orbit. Pull one onto a singularity
 * and it's gone — which makes the black hole the most honest wastebasket any
 * OS has ever shipped.
 */
export const cosmos: VoidModule = {
  manifest: {
    id: "cosmos",
    name: "Cosmos",
    kind: "app",
    glyph: "\u2609",
    blurb: "put things in the sky",
    version: "0.2.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "cosmos.singularity",
      label: "spawn a singularity",
      hint: "a wastebasket with gravity",
      glyph: "\u2b24",
      run: (c) => {
        c.spawnBody("singularity");
        c.notify("singularity forming \u2014 feed it with the \u2059 handle", "good");
      },
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "cosmos",
      width: 340,
      height: 360,
      render: (root) => {
        root.innerHTML = "";

        const spawnLabel = label("spawn a body");
        const spawnRow = document.createElement("div");
        spawnRow.className = "cos-kinds";

        for (const k of KINDS) {
          const b = document.createElement("button");
          b.className = "cos-kind";
          b.title = k.blurb;
          b.innerHTML = `<span class="cos-kind-glyph">${k.glyph}</span><span class="cos-kind-name">${k.kind}</span>`;
          b.addEventListener("click", () => {
            ctx.spawnBody(k.kind);
            refresh();
          });
          spawnRow.appendChild(b);
        }

        const skyLabel = label("in orbit");
        const chips = document.createElement("div");
        chips.className = "cos-chips";

        const divider = document.createElement("div");
        divider.className = "cos-divider";

        const how = document.createElement("div");
        how.className = "cos-how";
        how.innerHTML =
          "drag a window's <b>\u2059</b> handle onto a body to merge it \u2014 the window rides that orbit.<br>drop it on a <b>singularity</b> and it's eaten.";

        const actions = document.createElement("div");
        actions.className = "cos-actions";
        const releaseBtn = document.createElement("button");
        releaseBtn.className = "cos-btn";
        releaseBtn.textContent = "release all";
        releaseBtn.addEventListener("click", () => {
          for (const s of ctx.openSurfaces()) ctx.attachSurface(s.id, null);
          ctx.notify("every window released", "good");
        });
        const clearBtn = document.createElement("button");
        clearBtn.className = "cos-btn";
        clearBtn.textContent = "empty the sky";
        clearBtn.addEventListener("click", () => {
          for (const b of ctx.listBodies()) ctx.destroyBody(b.id);
          refresh();
        });
        actions.append(releaseBtn, clearBtn);

        root.append(spawnLabel, spawnRow, skyLabel, chips, divider, how, actions);

        function refresh() {
          const bodies = ctx.listBodies();
          chips.replaceChildren();
          if (!bodies.length) {
            const empty = document.createElement("span");
            empty.className = "cos-chip";
            empty.textContent = "the sky is empty";
            chips.appendChild(empty);
            return;
          }
          for (const b of bodies) {
            const chip = document.createElement("span");
            chip.className = "cos-chip has-kill";
            chip.textContent = `${b.kind} ${b.id.replace("body-", "#")}`;
            const kill = document.createElement("button");
            kill.className = "cos-kill";
            kill.textContent = "\u2715";
            kill.title = "remove this body";
            kill.addEventListener("click", () => {
              ctx.destroyBody(b.id);
              refresh();
            });
            chip.appendChild(kill);
            chips.appendChild(chip);
          }
        }

        refresh();
        return () => root.replaceChildren();
      },
    });
  },
};

function label(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "cos-label";
  el.textContent = text;
  return el;
}
