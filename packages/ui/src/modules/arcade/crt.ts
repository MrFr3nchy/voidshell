/**
 * A cathode ray tube, as a component.
 *
 * Games draw into this at their own native resolution and it composites the
 * result onto the panel. Every cabinet gets it for free and no game knows it
 * exists, which is the same division of labour as the rest of the arcade: the
 * machine owns the screen, the game owns the pixels.
 *
 * What a CRT actually does to an image, in the order it matters:
 *
 * 1. **Scanlines.** The gap between drawn rows. This is the effect everyone
 *    reaches for first and it is the one most often done wrong — the lines
 *    belong to the *source* rows, not to the display, so they must land one
 *    per game pixel row rather than every two device pixels. Get that wrong
 *    and the spacing crawls as the panel resizes.
 * 2. **The aperture grille.** Colour came from triads of phosphor stripes, so
 *    vertical banding in R/G/B is what makes it read as a tube rather than as
 *    a photo with lines on it. Cheap, and it does more work than the
 *    scanlines do.
 * 3. **Bloom.** Phosphor glows past its own pixel, so bright things bleed.
 *    This is what stops the picture looking like a screenshot with a texture
 *    over it — the light has to leak.
 * 4. **Geometry.** The tube is a section of a sphere, so the image is barrelled
 *    and the corners are pulled in.
 * 5. **Vignette.** The edges of the glass are darker.
 *
 * All of it is optional and independently weighted, because "classic arcade"
 * covers everything from a crisp late-80s monitor to a knackered cocktail
 * cabinet, and because a full-strength tube on a 300px panel is unreadable.
 *
 * Deliberately no WebGL. A shader would be the obvious way to do this and it
 * would mean a second GL context inside a shell that already spends one on the
 * compositor — browsers cap those, and the failure when you run out is the
 * whole void going black. 2D canvas is enough for every effect here.
 */

export interface CrtOptions {
  /** Darkness of the gap between source rows, 0..1. */
  scanlines: number;
  /** Strength of the R/G/B phosphor striping, 0..1. */
  grille: number;
  /** How far bright pixels bleed into their neighbours, 0..1. */
  bloom: number;
  /** Corner darkening, 0..1. */
  vignette: number;
  /** Barrel distortion, 0..1. 0 is a flat panel. */
  curvature: number;
}

export const CRT_PRESETS: Record<string, CrtOptions> = {
  off: { scanlines: 0, grille: 0, bloom: 0, vignette: 0, curvature: 0 },
  /** Just enough to lose the flatness. Safe at any panel size. */
  subtle: { scanlines: 0.25, grille: 0.1, bloom: 0.25, vignette: 0.3, curvature: 0 },
  /** The default. A monitor in good repair. */
  classic: { scanlines: 0.45, grille: 0.22, bloom: 0.45, vignette: 0.55, curvature: 0.5 },
  /** A cabinet that has been in the arcade since the arcade opened. */
  worn: { scanlines: 0.62, grille: 0.34, bloom: 0.7, vignette: 0.85, curvature: 1 },
};

/**
 * Source rows per geometry slice when curvature is on.
 *
 * Barrelling in 2D canvas means redrawing the image in horizontal bands, each
 * squeezed by a different amount. One band per source row would be exact and
 * costs 240 `drawImage` calls a frame; four rows per band costs 60 and the
 * seams land inside the scanline gaps, where they are invisible. Exactness
 * here buys nothing you can see.
 */
const SLICE = 4;

export class CrtScreen {
  /** Draw the game here, in game pixels. Null if 2D canvas is unavailable. */
  readonly ctx: CanvasRenderingContext2D | null;

  private readonly canvas: HTMLCanvasElement | null;
  private w: number;
  private h: number;

  /** Half-resolution copy used for the glow. Built lazily, only if bloom is on. */
  private glow: HTMLCanvasElement | null = null;
  private glowCtx: CanvasRenderingContext2D | null = null;

  /** Cached because rebuilding these every frame is most of the cost. */
  private grillePattern: CanvasPattern | null = null;
  private grilleFor = -1;
  private vignetteFor = "";
  private vignetteFill: CanvasGradient | null = null;
  private scanPattern: CanvasPattern | null = null;
  private scanFor = "";

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    // Guarded rather than assumed: jsdom has no canvas backend, and the smoke
    // harness constructs games headlessly. A null context here degrades to
    // drawing the game straight to the panel, which is exactly what the
    // no-CRT path does anyway.
    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      ctx = canvas.getContext("2d");
    } catch {
      canvas = null;
      ctx = null;
    }
    this.canvas = ctx ? canvas : null;
    this.ctx = ctx;
  }

  /** True when the tube is usable. False means draw the game directly. */
  get ready(): boolean {
    return this.canvas !== null && this.ctx !== null;
  }

  /** Clear to black. A tube with nothing on it is not transparent. */
  begin(): void {
    if (!this.ctx) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.fillStyle = "#000000";
    this.ctx.fillRect(0, 0, this.w, this.h);
  }

  /**
   * Composite the tube onto `g` inside the rect (x, y, vw, vh).
   *
   * `scale` is the whole-number magnification, used to place scanlines on
   * source rows rather than on device pixels.
   */
  present(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    vw: number,
    vh: number,
    scale: number,
    o: CrtOptions
  ): void {
    if (!this.canvas || !this.ctx) return;

    g.save();
    g.imageSmoothingEnabled = false;

    if (o.curvature > 0 && vh >= 120) this.drawCurved(g, x, y, vw, vh, o.curvature);
    else g.drawImage(this.canvas, x, y, vw, vh);

    if (o.bloom > 0) this.drawBloom(g, x, y, vw, vh, o.bloom, o.curvature);
    if (o.scanlines > 0 && scale >= 2) this.drawScanlines(g, x, y, vw, vh, scale, o.scanlines);
    if (o.grille > 0) this.drawGrille(g, x, y, vw, vh, o.grille);
    if (o.vignette > 0) this.drawVignette(g, x, y, vw, vh, o.vignette);

    g.restore();
  }

  /* ------------------------------------------------------------------ */

  /**
   * Barrel the image by redrawing it as horizontal bands.
   *
   * Each band is inset horizontally by how far it sits from the vertical
   * centre, which pulls the top and bottom edges in and leaves the middle at
   * full width — the shape of light leaving a spherical tube. The bands also
   * shift outward vertically so the corners round off rather than shearing.
   */
  private drawCurved(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    vw: number,
    vh: number,
    amount: number
  ): void {
    if (!this.canvas) return;
    const bulge = 0.045 * amount;
    for (let sy = 0; sy < this.h; sy += SLICE) {
      const sh = Math.min(SLICE, this.h - sy);
      // -1 at the top, 0 at the middle, +1 at the bottom.
      const t = (sy + sh / 2) / this.h * 2 - 1;
      const inset = vw * bulge * t * t;
      const lift = vh * bulge * 0.35 * t * t * Math.sign(t);
      g.drawImage(
        this.canvas,
        0, sy, this.w, sh,
        x + inset, y + (sy / this.h) * vh + lift, vw - inset * 2, (sh / this.h) * vh + 1
      );
    }
  }

  /**
   * Phosphor glow.
   *
   * A half-resolution copy blurred and added back with `lighter`, so bright
   * areas bleed and dark ones are untouched. Half resolution is both cheaper
   * and *better looking* than blurring at full size — the downscale is itself
   * a blur, and the result spreads further for the same filter radius.
   *
   * `ctx.filter` is not universally available; without it the downscale alone
   * still gives a soft bleed, which is a perfectly acceptable weaker glow
   * rather than a broken one.
   */
  private drawBloom(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    vw: number,
    vh: number,
    amount: number,
    curvature: number
  ): void {
    if (!this.canvas) return;
    const gw = Math.max(1, this.w >> 1);
    const gh = Math.max(1, this.h >> 1);
    if (!this.glow || this.glow.width !== gw || this.glow.height !== gh) {
      try {
        this.glow = document.createElement("canvas");
        this.glow.width = gw;
        this.glow.height = gh;
        this.glowCtx = this.glow.getContext("2d");
      } catch {
        this.glow = null;
        this.glowCtx = null;
      }
    }
    if (!this.glow || !this.glowCtx) return;

    this.glowCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.glowCtx.clearRect(0, 0, gw, gh);
    this.glowCtx.imageSmoothingEnabled = true;
    this.glowCtx.drawImage(this.canvas, 0, 0, gw, gh);

    g.save();
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = 0.5 * amount;
    g.imageSmoothingEnabled = true;
    try {
      g.filter = `blur(${(1.5 + 2.5 * amount).toFixed(2)}px)`;
    } catch {
      /* no filter support: the downscale alone still softens */
    }
    // Slightly oversized so the glow spills past the edge of the picture the
    // way light does, rather than stopping dead at the bezel.
    const over = 2 + 4 * amount + curvature * 2;
    g.drawImage(this.glow, x - over, y - over, vw + over * 2, vh + over * 2);
    g.restore();
  }

  /**
   * One dark line per *source* row.
   *
   * Anchored to `scale` rather than to a fixed pixel step, so the lines stay
   * locked to the game's own rows however large the panel gets. A fixed step
   * looks right at exactly one size and crawls at every other.
   */
  private drawScanlines(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    vw: number,
    vh: number,
    scale: number,
    amount: number
  ): void {
    // One tile, one fill. A loop over rows was 240 `fillRect` calls a frame at
    // a typical size — 14,000 a second to draw a repeating pattern, which is
    // what patterns are for. Keyed on scale as well as strength, because the
    // tile height *is* the row spacing.
    const key = `${scale}:${amount}`;
    if (this.scanFor !== key || !this.scanPattern) {
      try {
        const tile = document.createElement("canvas");
        tile.width = 1;
        tile.height = scale;
        const t = tile.getContext("2d");
        if (!t) return;
        const thickness = Math.max(1, Math.floor(scale / 3));
        t.fillStyle = `rgba(0, 0, 0, ${(0.55 * amount).toFixed(3)})`;
        t.fillRect(0, scale - thickness, 1, thickness);
        this.scanPattern = g.createPattern(tile, "repeat");
        this.scanFor = key;
      } catch {
        this.scanPattern = null;
        return;
      }
    }
    if (!this.scanPattern) return;

    g.save();
    g.globalCompositeOperation = "multiply";
    // The pattern is anchored to the canvas origin, not to the rect, so it
    // must be translated or the lines drift against the picture whenever the
    // panel moves — which is the exact crawl this is meant to avoid.
    g.translate(x, y);
    g.fillStyle = this.scanPattern;
    g.fillRect(0, 0, vw, vh);
    g.restore();
  }

  /**
   * The aperture grille: repeating red, green and blue stripes.
   *
   * Built once into a 3x1 pattern and cached against its strength. Doing this
   * per pixel would be the single most expensive thing in the frame; as a
   * pattern it is one fill.
   */
  private drawGrille(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    vw: number,
    vh: number,
    amount: number
  ): void {
    if (this.grilleFor !== amount || !this.grillePattern) {
      try {
        const tile = document.createElement("canvas");
        tile.width = 3;
        tile.height = 1;
        const t = tile.getContext("2d");
        if (!t) return;
        const lo = Math.round(255 * (1 - 0.55 * amount));
        const cols = [
          `rgb(255, ${lo}, ${lo})`,
          `rgb(${lo}, 255, ${lo})`,
          `rgb(${lo}, ${lo}, 255)`,
        ];
        for (let i = 0; i < 3; i++) {
          t.fillStyle = cols[i];
          t.fillRect(i, 0, 1, 1);
        }
        this.grillePattern = g.createPattern(tile, "repeat");
        this.grilleFor = amount;
      } catch {
        this.grillePattern = null;
        return;
      }
    }
    if (!this.grillePattern) return;
    g.save();
    g.globalCompositeOperation = "multiply";
    g.translate(x, y);
    g.fillStyle = this.grillePattern;
    g.fillRect(0, 0, vw, vh);
    g.restore();
  }

  /** Darker toward the glass. Cached against its own geometry. */
  private drawVignette(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    vw: number,
    vh: number,
    amount: number
  ): void {
    const key = `${x}:${y}:${vw}:${vh}:${amount}`;
    if (this.vignetteFor !== key || !this.vignetteFill) {
      const cx = x + vw / 2;
      const cy = y + vh / 2;
      const r = Math.hypot(vw, vh) / 2;
      const grad = g.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
      grad.addColorStop(0, "rgba(0, 0, 0, 0)");
      grad.addColorStop(1, `rgba(0, 0, 0, ${(0.72 * amount).toFixed(3)})`);
      this.vignetteFill = grad;
      this.vignetteFor = key;
    }
    g.fillStyle = this.vignetteFill;
    g.fillRect(x, y, vw, vh);
  }

  /** Drop the cached surfaces. Safe to call more than once. */
  dispose(): void {
    this.glow = null;
    this.glowCtx = null;
    this.grillePattern = null;
    this.vignetteFill = null;
    this.scanPattern = null;
    this.grilleFor = -1;
    this.vignetteFor = "";
    this.scanFor = "";
  }
}
