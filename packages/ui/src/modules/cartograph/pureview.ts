/**
 * Pure view: the map without the window.
 *
 * A voidshell panel is a rectangle projected from a point in 3D space, which
 * is a lovely thing for a text editor and an actively hostile one for a
 * viewport. It is scaled by its depth, so the render is resampled; it carries
 * a titlebar, a border and a 14px backdrop-filter, so a third of the glass is
 * chrome; and the whole assembly drifts as you look around. None of that is
 * wrong — it is the point of the shell — but a map you are flying through
 * wants to be a *window onto somewhere*, not an object in a room.
 *
 * So pure view lifts the live canvas out of the panel and puts it straight on
 * the glass. Two shapes, one mechanism:
 *
 *   - **widget** — a chromeless rectangle you place and size once. It sits
 *     above the pinned band, so nothing in the void can occlude it, and it is
 *     rendered at true device resolution because nothing is scaling it.
 *   - **fullscreen** — the same thing at the size of the viewport.
 *
 * The window it came from stays open and holds a placeholder. That is
 * deliberate: the surface is what owns the document, the save timer and the
 * marker list, and tearing it down to show a canvas somewhere else would mean
 * rebuilding all of it on the way back.
 */

/** Above `Z_PINNED + Z_FOCUS_BUMP` in the compositor, so no panel covers it. */
const Z_WIDGET = 1_200_000;
const Z_FULLSCREEN = 1_300_000;

const MIN_SIZE = 240;

export interface PureViewOptions {
  title: string;
  /** Called after every move or resize, so the size can be remembered. */
  onChange?: (rect: PureViewRect) => void;
  /** Called when the user sends the map back to its window. */
  onRestore: () => void;
  /** Starting geometry. Defaults to a sensible box in the lower right. */
  rect?: PureViewRect;
  startFullscreen?: boolean;
}

export interface PureViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PureView {
  /** Where the canvas should be mounted. */
  stage: HTMLElement;
  isFullscreen(): boolean;
  setFullscreen(on: boolean): void;
  rect(): PureViewRect;
  /** Tear down and put everything back. Does not call `onRestore`. */
  close(): void;
}

function clampRect(r: PureViewRect): PureViewRect {
  const maxW = Math.max(MIN_SIZE, window.innerWidth);
  const maxH = Math.max(MIN_SIZE, window.innerHeight);
  const width = Math.min(maxW, Math.max(MIN_SIZE, r.width));
  const height = Math.min(maxH, Math.max(MIN_SIZE, r.height));
  return {
    width,
    height,
    // Kept fully on screen. A widget with no titlebar that has been dragged
    // half off the edge is a widget with no way to drag it back.
    x: Math.min(maxW - width, Math.max(0, r.x)),
    y: Math.min(maxH - height, Math.max(0, r.y)),
  };
}

function defaultRect(): PureViewRect {
  const width = Math.min(920, Math.round(window.innerWidth * 0.52));
  const height = Math.min(620, Math.round(window.innerHeight * 0.56));
  return {
    width,
    height,
    x: Math.round(window.innerWidth - width - 32),
    y: Math.round(window.innerHeight - height - 64),
  };
}

export function openPureView(opts: PureViewOptions): PureView {
  const root = document.createElement("div");
  root.className = "cg-pure";
  root.style.zIndex = String(Z_WIDGET);

  const stage = document.createElement("div");
  stage.className = "cg-pure-stage";

  /*
   * The chrome that is not chrome.
   *
   * A completely bare rectangle cannot be moved, resized or dismissed, so
   * there has to be *something* — but it fades out whenever the pointer is
   * elsewhere, which means the resting state really is just the map. The bar
   * is also the drag handle, because dragging the body is how you look
   * around and the two cannot be the same gesture.
   */
  const bar = document.createElement("div");
  bar.className = "cg-pure-bar";

  const title = document.createElement("span");
  title.className = "cg-pure-title";
  title.textContent = opts.title;

  const spacer = document.createElement("span");
  spacer.className = "cg-pure-spacer";

  const makeButton = (label: string, hint: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cg-pure-btn";
    b.textContent = label;
    b.title = hint;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    // Or the pointerdown starts a window drag before the click ever lands.
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    return b;
  };

  let fullscreen = false;
  let rect = clampRect(opts.rect ?? defaultRect());

  const fullBtn = makeButton("⛶", "fullscreen", () => setFullscreen(!fullscreen));
  const backBtn = makeButton("✕", "back to the window", () => opts.onRestore());

  bar.append(title, spacer, fullBtn, backBtn);

  const grip = document.createElement("div");
  grip.className = "cg-pure-grip";
  grip.title = "resize";

  root.append(stage, bar, grip);
  document.body.appendChild(root);

  function apply(): void {
    if (fullscreen) {
      root.style.zIndex = String(Z_FULLSCREEN);
      root.style.left = "0px";
      root.style.top = "0px";
      root.style.width = "100%";
      root.style.height = "100%";
      root.classList.add("is-full");
      return;
    }
    root.style.zIndex = String(Z_WIDGET);
    root.classList.remove("is-full");
    root.style.left = `${rect.x}px`;
    root.style.top = `${rect.y}px`;
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
  }

  function setFullscreen(on: boolean): void {
    if (on === fullscreen) return;
    fullscreen = on;
    fullBtn.textContent = on ? "⛶" : "⛶";
    fullBtn.title = on ? "leave fullscreen" : "fullscreen";
    apply();
    opts.onChange?.(rect);
  }

  /* ---------------- dragging ---------------- */

  let drag: { dx: number; dy: number; pointer: number } | null = null;

  const onBarDown = (e: PointerEvent) => {
    if (fullscreen) return;
    drag = { dx: e.clientX - rect.x, dy: e.clientY - rect.y, pointer: e.pointerId };
    bar.setPointerCapture(e.pointerId);
    root.classList.add("is-moving");
  };

  const onBarMove = (e: PointerEvent) => {
    if (!drag) return;
    rect = clampRect({ ...rect, x: e.clientX - drag.dx, y: e.clientY - drag.dy });
    apply();
  };

  const onBarUp = (e: PointerEvent) => {
    if (!drag) return;
    if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
    drag = null;
    root.classList.remove("is-moving");
    opts.onChange?.(rect);
  };

  bar.addEventListener("pointerdown", onBarDown);
  bar.addEventListener("pointermove", onBarMove);
  bar.addEventListener("pointerup", onBarUp);
  bar.addEventListener("pointercancel", onBarUp);

  /* ---------------- resizing ---------------- */

  let resizing: { x: number; y: number; w: number; h: number } | null = null;

  const onGripDown = (e: PointerEvent) => {
    if (fullscreen) return;
    e.stopPropagation();
    resizing = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    grip.setPointerCapture(e.pointerId);
    root.classList.add("is-moving");
  };

  const onGripMove = (e: PointerEvent) => {
    if (!resizing) return;
    rect = clampRect({
      ...rect,
      width: resizing.w + (e.clientX - resizing.x),
      height: resizing.h + (e.clientY - resizing.y),
    });
    apply();
  };

  const onGripUp = (e: PointerEvent) => {
    if (!resizing) return;
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    resizing = null;
    root.classList.remove("is-moving");
    opts.onChange?.(rect);
  };

  grip.addEventListener("pointerdown", onGripDown);
  grip.addEventListener("pointermove", onGripMove);
  grip.addEventListener("pointerup", onGripUp);
  grip.addEventListener("pointercancel", onGripUp);

  /* ---------------- keys ---------------- */

  /**
   * Escape steps out one level at a time — fullscreen back to widget, widget
   * back to the window. Capture phase, because the shell also binds escape to
   * "close whatever is open" and a single press must not do both.
   */
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (fullscreen) {
      setFullscreen(false);
    } else {
      opts.onRestore();
    }
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("keydown", onKey, true);

  const onResize = () => {
    if (!fullscreen) rect = clampRect(rect);
    apply();
  };
  window.addEventListener("resize", onResize);

  if (opts.startFullscreen) fullscreen = true;
  apply();

  return {
    stage,
    isFullscreen: () => fullscreen,
    setFullscreen,
    rect: () => rect,
    close() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      root.remove();
    },
  };
}
