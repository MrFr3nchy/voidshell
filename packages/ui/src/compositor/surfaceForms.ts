/**
 * Windows that aren't windows.
 *
 * A lava lamp rendered inside a rectangle of frosted glass with a title bar is
 * a lava lamp *simulation*. Give it the silhouette of a lamp and it stops
 * being a picture of an object and becomes the object, which for the ambient
 * apps is the whole point of them.
 *
 * ## What lives here, and what doesn't
 *
 * This file is a catalogue and a pair of DOM verbs: the shapes themselves, and
 * how to put one on a panel or take it off. It holds no state and reads no
 * settings.
 *
 * Which window wears which shape is the compositor's business, because a shape
 * is a property of a *window* — see `ThreeCompositor.setSurfaceForm`. The first
 * two passes at this both got that wrong in the same way. The first hard-coded
 * a module-to-shape table; the second made it a setting, but still keyed on
 * module id, so one lava lamp forced every lava lamp and the only way to change
 * one was a picker in Settings. Both were the mistake app shelves exist to
 * avoid, one level too high: a silhouette is an opinion about a window.
 *
 * There was also a DOM observer in here watching the panel layer, which existed
 * only because `ThreeCompositor.mountSurface` built its panel markup inline and
 * never called `createPanelChrome`. That is fixed — the compositor calls the
 * shared chrome now — so the observer is gone with it and there is one place
 * that decides what a window looks like.
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
  /**
   * How far down the object its control row sits, as a percentage.
   *
   * Not decoration — this is the field that keeps a shape recoverable. The
   * clip-path clips hit-testing as well as painting, so a control parked
   * outside the outline is not merely hidden, it cannot be clicked. The row
   * used to sit below the panel entirely, which meant *every* shaped window
   * had no reachable controls at all: no menu, no pin, no close. An orb-shaped
   * Settings window was therefore unfixable from inside itself.
   *
   * So: pick a height where the silhouette is comfortably wider than a row of
   * buttons. The waist of the object, usually. Anything new added to FORMS owes
   * the same answer, and it is worth checking rather than guessing.
   */
  controls: number;
}

const LAMP: WindowForm = {
  id: "lamp",
  label: "lava lamp",
  aspect: 0.52,
  vessel: "#150a1e",
  // The glass is at its widest around 45-62% down; 58 sits inside it with room
  // to spare on either side.
  controls: 58,
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
  // The sphere spans 0-80% vertically. At 62 it is still ~77% of the panel
  // wide, which is the widest useful band below the middle.
  controls: 62,
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
  // Full width almost everywhere; the low bezel is where a monitor's buttons
  // would be anyway.
  controls: 86,
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
  // The niche is a straight 6-94% below the curve, so anything low is safe.
  controls: 86,
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
 * What shape a module's windows *open* as.
 *
 * A suggestion, and only that: the compositor copies it onto the panel at mount
 * and the window owns it from then on. Anything absent opens plain.
 */
const DEFAULTS: Record<string, string> = {
  lavalamp: "lamp",
};

export function defaultFormFor(moduleId: string): string {
  return DEFAULTS[moduleId] ?? PLAIN;
}

/** The shape with this id, or null for PLAIN and for anything unrecognised. */
export function formById(id: string): WindowForm | null {
  return FORMS.find((f) => f.id === id) ?? null;
}

/** Whether a string names a shape, PLAIN included. */
export function isFormId(id: string): boolean {
  return id === PLAIN || FORMS.some((f) => f.id === id);
}

/* ------------------------------------------------------------------ */
/* applying it to a live panel                                         */
/* ------------------------------------------------------------------ */

/**
 * Dress a panel in a shape.
 *
 * `width` comes from the compositor rather than being measured, because the
 * panel carries a projection scale in its transform: a measured width is the
 * on-screen size, and the height derived from it would drift as the window
 * moves in depth.
 */
export function applyForm(el: HTMLElement, form: WindowForm, width: number): void {
  el.classList.add("vs-formed");
  el.dataset.form = form.id;
  // clip-path clips hit-testing as well as painting, so the corners around the
  // silhouette stop swallowing clicks meant for the void behind it.
  el.style.clipPath = form.silhouette;
  if (form.vessel) el.style.background = form.vessel;
  // Where the controls can live without being clipped away. The CSS reads it;
  // see the note on WindowForm.controls for why this is load-bearing.
  el.style.setProperty("--vs-form-controls", `${form.controls}%`);

  const w = width || parseFloat(el.style.width) || 320;
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

/**
 * Undress it. Leaves no trace, so a window that has been shaped and unshaped is
 * indistinguishable from one that never was — except for its height, which the
 * caller has to restore because only the compositor knows what it should be.
 */
export function clearForm(el: HTMLElement): void {
  el.classList.remove("vs-formed");
  delete el.dataset.form;
  el.style.clipPath = "";
  el.style.background = "";
  el.style.removeProperty("--vs-form-controls");
  el.querySelector(":scope > .vs-panel-form")?.remove();
}
