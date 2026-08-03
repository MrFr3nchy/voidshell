/**
 * Windows that aren't windows.
 *
 * A lava lamp rendered inside a rectangle of frosted glass with a title bar is
 * a lava lamp *simulation*. Give it the silhouette of a lamp and it stops being
 * a picture of an object and starts being the object, which for the ambient
 * apps is the entire point of them.
 *
 * Keyed by module id rather than declared by the module, for the same reason
 * app shelves are: a silhouette is presentation, and putting it in
 * `ModuleManifest` would push a decision about chrome into thirty modules that
 * should not care. It also means the compositor stays the only thing that
 * knows what a window looks like, which is the line the whole design is drawn
 * on. Anything without an entry gets the ordinary glass panel, so this file is
 * purely additive and deleting it restores the status quo exactly.
 */
export interface SurfaceForm {
  /** A `clip-path` value in percentage units. Clips painting *and* hit-testing. */
  silhouette: string;
  /**
   * SVG painted over the content: the parts of the object that aren't screen.
   * viewBox is 0 0 100 100 with `preserveAspectRatio="none"`, so it stretches
   * with the panel and the coordinates match the silhouette's percentages.
   */
  furniture: string;
  /**
   * Width divided by height. Enforced on mount, and the resize grip is removed
   * — a lava lamp stretched to 3:1 is not a lava lamp, and there is no sensible
   * way to let someone resize a fixed silhouette freely.
   */
  aspect: number;
  /** Fallback background behind the content, seen through any glass. */
  vessel?: string;
}

/**
 * The lamp.
 *
 * Read the silhouette top to bottom: a narrow cap, a vessel that widens as it
 * descends, a waist, then a flared conical base. The base and cap are painted
 * over by `furniture` — the content is only visible through the glass, which
 * is what makes the wax look like it is *inside* something rather than like a
 * texture on a wall.
 */
const LAVA_LAMP: SurfaceForm = {
  aspect: 0.52,
  vessel: "#150a1e",
  silhouette: [
    "polygon(",
    "38% 0%, 62% 0%,",
    "64% 5%, 72% 20%, 78% 45%, 80% 62%,",
    "72% 70%,",
    "88% 78%, 96% 96%, 100% 100%,",
    "0% 100%, 4% 96%, 12% 78%, 28% 70%,",
    "20% 62%, 22% 45%, 28% 20%, 36% 5%",
    ")",
  ].join(" "),
  furniture: `
    <defs>
      <linearGradient id="vs-lamp-metal" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#2b2f3d"/>
        <stop offset="0.28" stop-color="#8e97ad"/>
        <stop offset="0.52" stop-color="#c9d2e4"/>
        <stop offset="0.74" stop-color="#6b7488"/>
        <stop offset="1" stop-color="#242836"/>
      </linearGradient>
      <linearGradient id="vs-lamp-glass" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.20"/>
        <stop offset="0.22" stop-color="#ffffff" stop-opacity="0.04"/>
        <stop offset="0.75" stop-color="#000000" stop-opacity="0.10"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.28"/>
      </linearGradient>
    </defs>

    <!-- the base: everything below the waist is metal, not screen -->
    <polygon points="28,70 72,70 88,78 96,96 100,100 0,100 4,96 12,78"
             fill="url(#vs-lamp-metal)"/>
    <polygon points="28,70 72,70 70,73 30,73" fill="#0f1118" opacity="0.55"/>
    <rect x="6" y="95" width="88" height="5" fill="#0d0f16" opacity="0.7"/>

    <!-- the cap -->
    <polygon points="38,0 62,0 64,5 36,5" fill="url(#vs-lamp-metal)"/>
    <rect x="34" y="5" width="32" height="2.4" fill="#0f1118" opacity="0.5"/>

    <!-- the glass itself: a specular streak down the left, shadow on the right -->
    <polygon points="36,5 64,5 72,20 78,45 80,62 72,70 28,70 20,62 22,45 28,20"
             fill="url(#vs-lamp-glass)"/>
    <path d="M34 9 C30 24, 27 42, 28 64" stroke="#ffffff" stroke-opacity="0.22"
          stroke-width="2.2" fill="none" stroke-linecap="round"/>
  `,
};

const FORMS: Record<string, SurfaceForm> = {
  lavalamp: LAVA_LAMP,
};

/** The form for a module, or undefined for an ordinary glass panel. */
export function formFor(moduleId: string): SurfaceForm | undefined {
  return FORMS[moduleId];
}
