import type { KernelContext } from "../kernel/types";

/**
 * Windows that aren't windows.
 *
 * A lava lamp rendered inside a rectangle of frosted glass with a title bar is
 * a lava lamp *simulation*. Give it the silhouette of a lamp and it stops
 * being a picture of an object and becomes the object, which for the ambient
 * apps is the whole point of them.
 *
 * Which app wears which shape is a **setting**, not a constant. The first pass
 * at this hard-coded the mapping, which was the same mistake app shelves exist
 * to avoid: a silhouette is an opinion about your own desktop, so the table
 * here is only a starting point and every entry is reassignable in Settings.
 *
 * ## Why this watches the DOM instead of living in the compositor
 *
 * `ThreeCompositor.mountSurface` builds its panel markup inline and never
 * calls `createPanelChrome` — that module is currently dead code, which is why
 * the first attempt at this appeared to do nothing at all. The honest
 * long-term fix is to unify the two and let the compositor own window shape.
 *
 * Until then forms attach by observing the panel layer, which has one real
 * advantage over patching `ThreeCompositor`: it works for *any* compositor,
 * including the flat DOM one the architecture keeps promising. The kernel
 * registers a surface before asking the compositor to mount it, so by the time
 * a node lands in the DOM its module id is already resolvable — which is what
 * lets this work without the compositor cooperating at all.
 */
export interface WindowForm {
  id: string;
  label: string;
  /** A `clip-path` value in percentage units. Clips painting *and* hit-testing. */
  silhouette: string;
  /**
   * SVG painted over the content: the parts of the object that aren't screen.
   * viewBox is 0 0 100 100, `preserveAspectRatio="none"`, so its coordinates
   * are the same percentages the silhouette uses.
   */
  furniture: string;
  /** Width over height. Enforced on mount; formed panels don't free-resize. */
  aspect: number;
  /** Backdrop behind the content, seen through any glass. */
  vessel?: string;
}

const LAMP: WindowForm = {
  id: "lamp",
  label: "lava lamp",
  aspect: 0.52,
  vessel: "#150a1e",
  silhouette:
    "polygon(38% 0%, 62% 0%, 64% 5%, 72% 20%, 78% 45%, 80% 62%, 72% 70%," +
    " 88% 78%, 96% 96%, 100% 100%, 0% 100%, 4% 96%, 12% 78%, 28% 70%," +
    " 20% 62%, 22% 45%, 28% 20%, 36% 5%)",
  furniture: `
    <defs>
      <linearGradient id="vs-metal" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#2b2f3d"/>
        <stop offset="0.28" stop-color="#8e97ad"/>
        <stop offset="0.52" stop-color="#c9d2e4"/>
        <stop offset="0.74" stop-color="#6b7488"/>
        <stop offset="1" stop-color="#242836"/>
      </linearGradient>
      <linearGradient id="vs-glass" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.20"/>
        <stop offset="0.22" stop-color="#ffffff" stop-opacity="0.04"/>
        <stop offset="0.75" stop-color="#000000" stop-opacity="0.10"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.28"/>
      </linearGradient>
    </defs>
    <polygon points="28,70 72,70 88,78 96,96 100,100 0,100 4,96 12,78" fill="url(#vs-metal)"/>
    <polygon points="28,70 72,70 70,73 30,73" fill="#0f1118" opacity="0.55"/>
    <rect x="6" y="95" width="88" height="5" fill="#0d0f16" opacity="0.7"/>
    <polygon points="38,0 62,0 64,5 36,5" fill="url(#vs-metal)"/>
    <rect x="34" y="5" width="32" height="2.4" fill="#0f1118" opacity="0.5"/>
    <polygon points="36,5 64,5 72,20 78,45 80,62 72,70 28,70 20,62 22,45 28,20" fill="url(#vs-glass)"/>
    <path d="M34 9 C30 24, 27 42, 28 64" stroke="#ffffff" stroke-opacity="0.22"
          stroke-width="2.2" fill="none" stroke-linecap="round"/>
  `,
};

/** A snow-globe: everything inside is a world, and the world is round. */
const ORB: WindowForm = {
  id: "orb",
  label: "orb",
  aspect: 0.86,
  vessel: "#06080f",
  silhouette: "ellipse(46% 40% at 50% 40%)",
  furniture: `
    <defs>
      <radialGradient id="vs-orb-glass" cx="0.34" cy="0.26" r="0.72">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.24"/>
        <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.02"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.34"/>
      </radialGradient>
      <linearGradient id="vs-orb-base" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#2b2f3d"/>
        <stop offset="0.5" stop-color="#a8b2c6"/>
        <stop offset="1" stop-color="#242836"/>
      </linearGradient>
    </defs>
    <ellipse cx="50" cy="40" rx="46" ry="40" fill="url(#vs-orb-glass)"/>
    <path d="M22 70 L78 70 L88 88 L92 100 L8 100 L12 88 Z" fill="url(#vs-orb-base)"/>
    <rect x="8" y="96" width="84" height="4" fill="#0d0f16" opacity="0.7"/>
    <ellipse cx="36" cy="24" rx="9" ry="6" fill="#ffffff" opacity="0.18"
             transform="rotate(-24 36 24)"/>
  `,
};

/** A cathode monitor: a rounded tube in a heavy bezel. */
const TUBE: WindowForm = {
  id: "tube",
  label: "cathode tube",
  aspect: 1.28,
  vessel: "#04060a",
  silhouette: "inset(0% 0% 0% 0% round 12% / 15%)",
  furniture: `
    <defs>
      <radialGradient id="vs-tube-glare" cx="0.3" cy="0.22" r="0.6">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.13"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect x="0" y="0" width="100" height="100" fill="url(#vs-tube-glare)"/>
    <rect x="0" y="0" width="100" height="100" fill="none"
          stroke="#0a0c14" stroke-width="7" rx="12" ry="15"/>
    <rect x="0" y="0" width="100" height="100" fill="none"
          stroke="#4a5162" stroke-width="1.4" rx="12" ry="15" opacity="0.7"/>
  `,
};

/** An arched niche, for things that want to look built into a wall. */
const ARCH: WindowForm = {
  id: "arch",
  label: "arch",
  aspect: 0.72,
  vessel: "#080a12",
  silhouette:
    "polygon(50% 0%, 68% 4%, 82% 15%, 91% 31%, 94% 50%, 94% 100%, 6% 100%," +
    " 6% 50%, 9% 31%, 18% 15%, 32% 4%)",
  furniture: `
    <path d="M50 2 C69 2, 89 16, 93 46 L93 100 L86 100 L86 48
             C82 22, 67 8, 50 8 C33 8, 18 22, 14 48 L14 100 L7 100 L7 46
             C11 16, 31 2, 50 2 Z" fill="#57608a" opacity="0.55"/>
  `,
};

export const FORMS: WindowForm[] = [LAMP, ORB, TUBE, ARCH];

/** Sentinel for "an ordinary glass panel". Not a shape — the absence of one. */
export const PLAIN = "plain";

/**
 * Where each module starts. A default, not a ruling: anything absent is plain,
 * and every one of these is overridable per module in Settings.
 */
const DEFAULTS: Record<string, string> = {
  lavalamp: "lamp",
};

const formKey = (moduleId: string) => `window.form.${moduleId}`;

export function formIdFor(ctx: KernelContext, moduleId: string): string {
  const chosen = ctx.state.get<string>(formKey(moduleId), "");
  if (chosen) return chosen;
  return DEFAULTS[moduleId] ?? PLAIN;
}

export function formFor(ctx: KernelContext, moduleId: string): WindowForm | null {
  const id = formIdFor(ctx, moduleId);
  return FORMS.find((f) => f.id === id) ?? null;
}

export function setForm(ctx: KernelContext, moduleId: string, formId: string): void {
  const valid = formId === PLAIN || FORMS.some((f) => f.id === formId);
  ctx.state.set(formKey(moduleId), valid ? formId : PLAIN);
}

/* ------------------------------------------------------------------ */
/* applying it to a live panel                                         */
/* ------------------------------------------------------------------ */

export function applyForm(el: HTMLElement, form: WindowForm): void {
  el.classList.add("vs-formed");
  el.dataset.form = form.id;
  // clip-path clips hit-testing as well as painting, so the corners around the
  // silhouette stop swallowing clicks meant for the void behind it.
  el.style.clipPath = form.silhouette;
  if (form.vessel) el.style.background = form.vessel;

  // Read the width the compositor set inline rather than measuring: the panel
  // carries a projection scale in its transform, so a measured width is the
  // on-screen size and the shape would drift as the window moves in depth.
  const w = parseFloat(el.style.width) || 320;
  el.style.height = `${Math.round(w / form.aspect)}px`;

  let art = el.querySelector<HTMLElement>(":scope > .vs-panel-form");
  if (!art) {
    art = document.createElement("div");
    art.className = "vs-panel-form";
    el.appendChild(art);
  }
  art.innerHTML =
    `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${form.furniture}</svg>`;
}

export function clearForm(el: HTMLElement): void {
  el.classList.remove("vs-formed");
  delete el.dataset.form;
  el.style.clipPath = "";
  el.style.background = "";
  el.querySelector(":scope > .vs-panel-form")?.remove();
}

function panelLayer(): HTMLElement | null {
  return document.getElementById("panel-layer");
}

/** Give one panel whatever shape its module currently wears. */
function dress(ctx: KernelContext, el: HTMLElement): void {
  const sid = el.dataset.surface;
  if (!sid) return;
  const surface = ctx.openSurfaces().find((s) => s.id === sid);
  if (!surface) return;
  // Recorded so a later reassignment can find every panel of a given module
  // without going back through the surface table.
  el.dataset.module = surface.moduleId;
  const form = formFor(ctx, surface.moduleId);
  if (form) applyForm(el, form);
  else clearForm(el);
}

/** Re-dress everything on screen. Called when an assignment changes. */
export function refreshForms(ctx: KernelContext): void {
  const layer = panelLayer();
  if (!layer) return;
  for (const el of layer.querySelectorAll<HTMLElement>(".vs-panel[data-surface]")) {
    dress(ctx, el);
  }
}

/** Watch the panel layer and shape every window as it appears. */
export function initWindowForms(ctx: KernelContext): () => void {
  const layer = panelLayer();
  if (!layer) return () => {};

  const obs = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.classList.contains("vs-panel")) dress(ctx, node);
      }
    }
  });
  obs.observe(layer, { childList: true });
  refreshForms(ctx);

  defineFormSettings(ctx);
  return () => obs.disconnect();
}

/** The picker: every app, and the shape its windows take. */
function defineFormSettings(ctx: KernelContext): void {
  ctx.defineSetting({
    key: "window.forms",
    label: "window shapes",
    kind: "custom",
    group: "Appearance",
    hint: "give an app the silhouette of the thing it is",
    order: 60,
    render: (root, c) => {
      const wrap = document.createElement("div");
      wrap.className = "form-picker";

      for (const m of c.registry().filter((x) => x.kind === "app")) {
        const row = document.createElement("div");
        row.className = "form-picker-row";

        const name = document.createElement("span");
        name.className = "form-picker-name";
        name.textContent = `${m.glyph ?? "\u00b7"}  ${m.name}`;

        const pick = document.createElement("select");
        pick.className = "form-picker-pick";
        const options = [
          { value: PLAIN, label: "glass panel" },
          ...FORMS.map((f) => ({ value: f.id, label: f.label })),
        ];
        for (const o of options) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === formIdFor(c, m.id)) opt.selected = true;
          pick.appendChild(opt);
        }
        pick.addEventListener("change", () => {
          setForm(c, m.id, pick.value);
          // Live, so choosing a shape shows you the shape rather than
          // promising it for next time.
          refreshForms(c);
        });

        row.append(name, pick);
        wrap.appendChild(row);
      }

      root.appendChild(wrap);
      return () => wrap.remove();
    },
  });
}
