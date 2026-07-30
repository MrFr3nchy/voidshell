/**
 * A canvas that behaves itself inside a panel.
 *
 * Every ambient app in the void wants the same four things: a canvas that
 * fills its panel, survives the resize grip, draws at device resolution, and
 * runs a frame loop that stops dead when the window closes. That's this. It is
 * deliberately not a framework — you get a context and a delta, you draw.
 */

export interface Stage {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  /** Logical size in CSS pixels. The context is pre-scaled, so draw in these. */
  w: number;
  h: number;
  dpr: number;
}

export interface StageOptions {
  className?: string;
  /** Called on mount and after every resize, before the next frame. */
  layout?: (stage: Stage) => void;
  /** Called once per animation frame with the seconds elapsed, clamped. */
  frame?: (stage: Stage, dt: number) => void;
}

/** Mount a live canvas into `host`. Returns a disposer that kills the loop. */
export function mountStage(host: HTMLElement, opts: StageOptions): () => void {
  const canvas = document.createElement("canvas");
  canvas.className = opts.className ?? "stage-canvas";
  host.appendChild(canvas);

  const g = canvas.getContext("2d");
  if (!g) return () => canvas.remove();

  // Zeroed on purpose: the first resize must always be a change, so `layout`
  // is guaranteed to have run before any frame draws.
  const stage: Stage = { canvas, g, w: 0, h: 0, dpr: 0 };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight));
    if (w === stage.w && h === stage.h && dpr === stage.dpr) return;
    stage.w = w;
    stage.h = h;
    stage.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    opts.layout?.(stage);
  };

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  let raf = 0;
  let last = performance.now();
  if (opts.frame) {
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // Clamp so a backgrounded tab doesn't return and integrate a 30s step.
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;
      opts.frame?.(stage, dt);
    };
    raf = requestAnimationFrame(loop);
  }

  return () => {
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    canvas.remove();
  };
}

/** The live theme, straight from Aurora's CSS variables. Never hardcode these. */
export function palette(): {
  cyan: string;
  magenta: string;
  ember: string;
  text: string;
  dim: string;
} {
  const s = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    s.getPropertyValue(name).trim() || fallback;
  return {
    cyan: read("--cyan", "#4fe3d0"),
    magenta: read("--magenta", "#c05cff"),
    ember: read("--ember", "#ff8a5c"),
    text: read("--text", "#e8edff"),
    dim: read("--text-dim", "#8a93b8"),
  };
}

/**
 * Tint a theme colour. Aurora can hand us hex, `rgb()` or `oklch()`, so this
 * fast-paths hex and falls back to `color-mix` for anything exotic.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((ch) => ch + ch)
            .join("")
        : hex.slice(0, 6);
    const n = parseInt(full, 16);
    if (!Number.isNaN(n)) {
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    }
  }
  return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;
}

/**
 * A theme colour as raw channel numbers, for apps that write pixels directly
 * into an ImageData buffer and can't hand the canvas a CSS string. Falls back
 * to a mid grey rather than throwing, so an exotic Aurora colour space costs
 * you accuracy and nothing else.
 */
export function rgbOf(color: string): [number, number, number] {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((ch) => ch + ch)
            .join("")
        : hex.slice(0, 6);
    const n = parseInt(full, 16);
    if (!Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = color.match(/-?\d+(\.\d+)?/g);
  if (m && m.length >= 3) {
    return [Number(m[0]) | 0, Number(m[1]) | 0, Number(m[2]) | 0];
  }
  return [128, 128, 128];
}

/** A small row of pill buttons — the common chrome under an ambient canvas. */
export function toolbar(host: HTMLElement): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "stage-bar";
  host.appendChild(bar);
  return bar;
}

export function toolButton(
  bar: HTMLElement,
  label: string,
  onClick: (btn: HTMLButtonElement) => void
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "stage-btn";
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", () => {
    onClick(b);
    b.blur(); // held Enter must not re-fire the button
  });
  bar.appendChild(b);
  return b;
}
