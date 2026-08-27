/**
 * The radar: a heading-up bird's-eye map of the void, pinned to a corner of
 * the HUD.
 *
 * The compass answers "which way do I turn for *that* one thing" — a single
 * bearing at the screen edge. The radar answers the other half: the whole
 * layout at once, and where you sit in it. Windows, constellations, stations,
 * celestial bodies and home all show as blips on a disc that rotates with you,
 * so "up" is always the way you are facing. A wedge shows your field of view;
 * rings give a sense of scale; a lollipop stalk on a blip means it sits above
 * or below your plane. Click a blip and it does exactly what clicking its
 * compass chevron would — face a window, fly to a station, turn to a body.
 *
 * It is a sibling of `Compass`: same constructor shape, same `(kind, id)`
 * select callback, same `setEnabled` / `sync` / `dispose` lifecycle, driven
 * once per frame by the compositor.
 */

export type RadarKind =
  | "self"
  | "surface"
  | "group"
  | "station"
  | "body"
  | "home";

export interface RadarBlip {
  id: string;
  kind: RadarKind;
  label: string;
  /** World position. */
  x: number;
  y: number;
  z: number;
  /** Station chevron glyph, drawn beside the blip. */
  glyph?: string;
  /** The station you are currently parked at — drawn filled, never clamped. */
  here?: boolean;
  /** The origin sun. Drawn as a small star rather than a dot. */
  sun?: boolean;
}

export interface RadarFrame {
  camX: number;
  camY: number;
  camZ: number;
  /** Camera yaw, matching the compositor's `atan2(-d.x, -d.z)` convention. */
  yaw: number;
  /** Vertical field of view, in degrees. */
  fov: number;
  /** True while parked in the sun's core — suppresses the home blip. */
  atOrigin: boolean;
  blips: RadarBlip[];
}

interface Hit {
  id: string;
  kind: RadarKind;
  label: string;
  x: number;
  y: number;
  r: number;
}

const SIZE = 200;
const PAD = 14;
const REDRAW_MS = 32;

export class Radar {
  private host: HTMLElement;
  private wrap: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLElement;
  private caption: HTMLElement;
  private onSelect: (kind: RadarKind, id: string) => void;

  private enabled = true;
  private frame: RadarFrame | null = null;
  private hits: Hit[] = [];
  private hover: string | null = null;
  private lastDraw = 0;
  /** Auto-zoom radius in world units, eased so it doesn't jump. */
  private span = 1200;
  private dpr = Math.min(devicePixelRatio || 1, 2);

  constructor(
    host: HTMLElement,
    onSelect: (kind: RadarKind, id: string) => void
  ) {
    this.host = host;
    this.onSelect = onSelect;

    this.wrap = document.createElement("div");
    this.wrap.className = "vs-radar";

    this.canvas = document.createElement("canvas");
    this.canvas.width = SIZE * this.dpr;
    this.canvas.height = SIZE * this.dpr;
    this.canvas.style.width = `${SIZE}px`;
    this.canvas.style.height = `${SIZE}px`;
    this.wrap.appendChild(this.canvas);

    this.tip = document.createElement("div");
    this.tip.className = "vs-radar-tip";
    this.tip.hidden = true;
    this.wrap.appendChild(this.tip);

    this.caption = document.createElement("div");
    this.caption.className = "vs-radar-caption";
    this.wrap.appendChild(this.caption);

    const c = this.canvas.getContext("2d");
    if (!c) throw new Error("radar: 2d context unavailable");
    this.ctx = c;
    this.ctx.scale(this.dpr, this.dpr);

    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerleave", this.onLeave);
    this.canvas.addEventListener("click", this.onClick);

    this.host.appendChild(this.wrap);
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.wrap.hidden = !on;
    if (!on) {
      this.frame = null;
      this.hits = [];
      this.hover = null;
      this.tip.hidden = true;
    }
  }

  sync(frame: RadarFrame): void {
    if (!this.enabled) return;
    this.frame = frame;
    const now = performance.now();
    if (now - this.lastDraw < REDRAW_MS) return;
    this.lastDraw = now;
    this.draw();
  }

  dispose(): void {
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("click", this.onClick);
    this.wrap.remove();
  }

  /* ------------------------------------------------------------------ */

  private cssColor(name: string, fallback: string): string {
    const v = getComputedStyle(this.wrap).getPropertyValue(name).trim();
    return v || fallback;
  }

  private onMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: Hit | null = null;
    let bestD = 13;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - mx, h.y - my);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    const id = best ? best.id : null;
    if (id !== this.hover) {
      this.hover = id;
      this.draw();
    }
    if (best) {
      this.tip.textContent = best.label;
      this.tip.hidden = false;
      this.canvas.style.cursor = "pointer";
    } else {
      this.tip.hidden = true;
      this.canvas.style.cursor = "default";
    }
  };

  private onLeave = () => {
    this.tip.hidden = true;
    this.canvas.style.cursor = "default";
    if (this.hover !== null) {
      this.hover = null;
      this.draw();
    }
  };

  private onClick = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: Hit | null = null;
    let bestD = 14;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - mx, h.y - my);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    if (best && best.kind !== "self") this.onSelect(best.kind, best.id);
  };

  /* ------------------------------------------------------------------ */

  private draw(): void {
    const f = this.frame;
    const g = this.ctx;
    g.clearRect(0, 0, SIZE, SIZE);
    this.hits = [];
    if (!f) return;

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const R = SIZE / 2 - PAD;

    const cyan = this.cssColor("--cyan", "#4fe3d0");
    const dim = this.cssColor("--text-dim", "#8a93b8");
    const gold = "#ffd98a";
    const green = "#8affc0";

    // Forward direction on the ground plane, in world (x, z). The camera looks
    // down -z at yaw 0, so this matches the compositor's own `forward()`.
    const fwdX = -Math.sin(f.yaw);
    const fwdZ = -Math.cos(f.yaw);
    // Screen "right" is forward rotated -90°: (fz, -fx).
    const rightX = fwdZ;
    const rightZ = -fwdX;

    // Auto-zoom: keep the farthest interesting blip just inside the rim, eased
    // so a station popping in doesn't snap the whole map smaller.
    let maxD = 600;
    for (const b of f.blips) {
      if (b.kind === "self" || b.kind === "body") continue;
      const d = Math.hypot(b.x - f.camX, b.z - f.camZ);
      if (d > maxD) maxD = d;
    }
    const target = Math.max(600, Math.min(6000, maxD * 1.15));
    this.span += (target - this.span) * 0.08;
    const span = this.span;

    // Backing disc.
    g.save();
    g.beginPath();
    g.arc(cx, cy, R + 6, 0, Math.PI * 2);
    g.fillStyle = "rgba(8, 12, 24, 0.72)";
    g.fill();
    g.clip();

    // View-cone wedge, pointing up.
    const half = (Math.min(120, Math.max(30, f.fov)) * Math.PI) / 180 / 2;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, this.rgba(cyan, 0.22));
    grad.addColorStop(1, this.rgba(cyan, 0));
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, R, -Math.PI / 2 - half, -Math.PI / 2 + half);
    g.closePath();
    g.fillStyle = grad;
    g.fill();

    // Distance rings.
    g.strokeStyle = this.rgba(dim, 0.28);
    g.lineWidth = 1;
    for (const frac of [0.34, 0.67, 1]) {
      g.beginPath();
      g.arc(cx, cy, R * frac, 0, Math.PI * 2);
      g.stroke();
    }
    // Cross hairs.
    g.strokeStyle = this.rgba(dim, 0.16);
    g.beginPath();
    g.moveTo(cx - R, cy);
    g.lineTo(cx + R, cy);
    g.moveTo(cx, cy - R);
    g.lineTo(cx, cy + R);
    g.stroke();

    g.restore();

    // Blips.
    const project = (b: RadarBlip) => {
      const dx = b.x - f.camX;
      const dz = b.z - f.camZ;
      const dy = b.y - f.camY;
      const along = dx * fwdX + dz * fwdZ;
      const side = dx * rightX + dz * rightZ;
      const d = Math.hypot(dx, dz);
      let rr = Math.pow(Math.min(1, d / span), 0.62);
      let clamped = false;
      if (rr >= 0.999) {
        rr = 1;
        clamped = true;
      }
      const ux = d < 1e-3 ? 0 : side / d;
      const uy = d < 1e-3 ? -1 : -along / d;
      return {
        sx: cx + ux * R * rr,
        sy: cy + uy * R * rr,
        dy,
        d,
        clamped,
      };
    };

    // Draw order: bodies first (faint, behind), then home, then windows and
    // stations on top so they win the hit test.
    const order: RadarKind[] = ["body", "home", "group", "surface", "station"];
    const sorted = [...f.blips].sort(
      (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)
    );

    // Windows opened in the same breath land on the same pixel. Nudge any blip
    // that collides with one already placed outward along its own bearing until
    // it clears, so a stack of four is four things you can see and click.
    const placed: { x: number; y: number }[] = [];
    const declutter = (sx: number, sy: number) => {
      let x = sx;
      let y = sy;
      const dirX = x - cx || 0.01;
      const dirY = y - cy || 0.01;
      const len = Math.hypot(dirX, dirY) || 1;
      const ndx = dirX / len;
      const ndy = dirY / len;
      // Outward along the bearing, with a widening left/right wobble so a
      // stack fans into a little cluster instead of a single bead-string.
      for (let step = 1; step <= 9; step++) {
        const clash = placed.some((q) => Math.hypot(q.x - x, q.y - y) < 9);
        if (!clash) break;
        const wob = (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 5;
        x = sx + ndx * step * 6 - ndy * wob;
        y = sy + ndy * step * 6 + ndx * wob;
      }
      placed.push({ x, y });
      return { x, y };
    };

    for (const b of sorted) {
      if (b.kind === "self") continue;
      if (b.kind === "home" && f.atOrigin) continue;
      const p = project(b);
      if (b.kind === "body" && p.d < 40) continue;
      if (!p.clamped && b.kind !== "body") {
        const nudged = declutter(p.sx, p.sy);
        p.sx = nudged.x;
        p.sy = nudged.y;
      }
      const isHover = this.hover === b.id;

      let color = cyan;
      let radius = 3.4;
      if (b.kind === "body") {
        color = b.sun ? gold : dim;
        radius = b.sun ? 3 : 2.4;
      } else if (b.kind === "station") {
        color = gold;
        radius = 3.8;
      } else if (b.kind === "home") {
        color = green;
        radius = 3.4;
      } else if (b.kind === "group") {
        color = cyan;
        radius = 3.8;
      }
      if (isHover) radius += 1.6;

      // Elevation stalk: a blip well off your plane grows a stem toward the
      // sign of its offset, with a tick at the end.
      if (Math.abs(p.dy) > 60 && b.kind !== "body") {
        const len = Math.min(15, (Math.abs(p.dy) / span) * R * 1.8 + 4);
        const sign = p.dy > 0 ? -1 : 1; // screen up = above you
        g.strokeStyle = this.rgba(color, 0.5);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(p.sx, p.sy);
        g.lineTo(p.sx, p.sy + sign * len);
        g.moveTo(p.sx - 2, p.sy + sign * len);
        g.lineTo(p.sx + 2, p.sy + sign * len);
        g.stroke();
      }

      if (p.clamped) {
        // A caret on the rim for anything past the edge of the map.
        const ang = Math.atan2(p.sy - cy, p.sx - cx);
        g.save();
        g.translate(p.sx, p.sy);
        g.rotate(ang);
        g.fillStyle = this.rgba(color, isHover ? 0.95 : 0.6);
        g.beginPath();
        g.moveTo(3, 0);
        g.lineTo(-2.5, 3);
        g.lineTo(-2.5, -3);
        g.closePath();
        g.fill();
        g.restore();
      } else {
        g.beginPath();
        g.arc(p.sx, p.sy, radius, 0, Math.PI * 2);
        g.fillStyle = color;
        g.globalAlpha = b.kind === "body" && !b.sun ? 0.55 : 1;
        g.fill();
        g.globalAlpha = 1;

        if (b.kind === "group") {
          g.beginPath();
          g.arc(p.sx, p.sy, radius + 3, 0, Math.PI * 2);
          g.strokeStyle = this.rgba(color, 0.8);
          g.lineWidth = 1;
          g.stroke();
        }
        if (b.kind === "station" && b.here) {
          g.beginPath();
          g.arc(p.sx, p.sy, radius + 3.5, 0, Math.PI * 2);
          g.strokeStyle = this.rgba(gold, 0.9);
          g.lineWidth = 1.5;
          g.stroke();
        }
        if (b.sun) {
          g.strokeStyle = this.rgba(gold, 0.7);
          g.lineWidth = 1;
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI;
            g.beginPath();
            g.moveTo(p.sx + Math.cos(a) * 6, p.sy + Math.sin(a) * 6);
            g.lineTo(p.sx - Math.cos(a) * 6, p.sy - Math.sin(a) * 6);
            g.stroke();
          }
        }
      }

      if ((b.kind === "station" && b.glyph) || (isHover && b.kind !== "body")) {
        g.fillStyle = this.rgba(b.kind === "station" ? gold : color, 0.95);
        g.font = "10px ui-monospace, monospace";
        g.textBaseline = "middle";
        const txt = b.kind === "station" && b.glyph ? b.glyph : "";
        if (txt) g.fillText(txt, p.sx + radius + 3, p.sy);
      }

      this.hits.push({
        id: b.id,
        kind: b.kind,
        label: this.hitLabel(b, p.d),
        x: p.sx,
        y: p.sy,
        r: radius,
      });
    }

    // You, at the centre: a chevron pointing up.
    g.fillStyle = cyan;
    g.beginPath();
    g.moveTo(cx, cy - 5);
    g.lineTo(cx + 4, cy + 4);
    g.lineTo(cx, cy + 1.5);
    g.lineTo(cx - 4, cy + 4);
    g.closePath();
    g.fill();

    // Rim.
    g.strokeStyle = this.rgba(cyan, 0.4);
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, R + 6, 0, Math.PI * 2);
    g.stroke();

    // Caption: what's out there, or a note that it's empty.
    const windows = f.blips.filter(
      (b) => b.kind === "surface" || b.kind === "group"
    ).length;
    const stations = f.blips.filter((b) => b.kind === "station").length;
    if (!windows && !stations) {
      this.caption.textContent = "clear skies";
    } else {
      const parts: string[] = [];
      if (windows) parts.push(`${windows} window${windows === 1 ? "" : "s"}`);
      if (stations) parts.push(`${stations} station${stations === 1 ? "" : "s"}`);
      this.caption.textContent = `${parts.join(" · ")}  ·  ~${Math.round(span)}u`;
    }
  }

  private hitLabel(b: RadarBlip, d: number): string {
    if (b.kind === "self") return "you";
    const u =
      d > this.span * 0.98 ? `${Math.round(d)}u out` : `${Math.round(d)}u`;
    if (b.kind === "home") return "home";
    if (b.kind === "body") return b.sun ? "the sun" : b.label;
    return `${b.label}  ·  ${u}`;
  }

  /** Accepts `#rrggbb`, `#rgb` or an `rgb()/rgba()` string and re-alphas it. */
  private rgba(color: string, alpha: number): string {
    const c = color.trim();
    if (c.startsWith("#")) {
      let hex = c.slice(1);
      if (hex.length === 3)
        hex = hex
          .split("")
          .map((x) => x + x)
          .join("");
      const n = parseInt(hex, 16);
      const r = (n >> 16) & 255;
      const gg = (n >> 8) & 255;
      const bb = n & 255;
      return `rgba(${r}, ${gg}, ${bb}, ${alpha})`;
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const [r, gg, bb] = m[1].split(",").map((s) => parseFloat(s));
      return `rgba(${r}, ${gg}, ${bb}, ${alpha})`;
    }
    return c;
  }
}
