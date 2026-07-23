const SVG_NS = "http://www.w3.org/2000/svg";

/** How a thread should be drawn. Shared by every constellation on screen. */
export interface TetherStyle {
  opacity: number;
  width: number;
  glow: number;
  labels: boolean;
}

/** One constellation, already reduced to screen space by the compositor. */
export interface TetherGroup {
  id: string;
  name: string;
  color: string;
  rigid: boolean;
  points: { sx: number; sy: number }[];
}

/**
 * The light between linked windows.
 *
 * Drawn as four layers so it reads as starlight rather than as a line on a
 * chart: a wide blurred halo, a bright thin core, a star where the thread
 * meets each window, and an invisible fat stroke that is the actual click
 * target. A one-pixel line is impossible to hit; a sixteen-pixel one under it
 * is effortless, and clicking is how you harden or loosen the bond.
 *
 * This layer knows nothing about 3D. It takes screen positions and group
 * state, which is the whole reason it can live outside the compositor.
 */
export class TetherLayer {
  private svgEl: SVGSVGElement;
  private nodes = new Map<string, SVGGElement>();
  private live: SVGPolylineElement | null = null;
  private onToggle: (groupId: string) => void;

  constructor(host: HTMLElement, onToggle: (groupId: string) => void) {
    this.onToggle = onToggle;
    this.svgEl = document.createElementNS(SVG_NS, "svg");
    this.svgEl.setAttribute("class", "vs-tethers");
    host.appendChild(this.svgEl);
  }

  /* ---------------- the thread being dragged out of a link handle -------- */

  beginLive(): void {
    this.endLive();
    this.live = document.createElementNS(SVG_NS, "polyline");
    this.live.setAttribute("class", "vs-tether-line vs-tether-live");
    this.svgEl.appendChild(this.live);
  }

  updateLive(x1: number, y1: number, x2: number, y2: number): void {
    this.live?.setAttribute(
      "points",
      `${x1.toFixed(0)},${y1.toFixed(0)} ${x2.toFixed(0)},${y2.toFixed(0)}`
    );
  }

  endLive(): void {
    this.live?.remove();
    this.live = null;
  }

  /* ---------------- established constellations --------------------------- */

  draw(groups: TetherGroup[], style: TetherStyle): void {
    const seen = new Set<string>();

    for (const g of groups) {
      if (g.points.length < 2) continue;
      seen.add(g.id);
      const node = this.nodeFor(g.id);

      // Star-shape from the centroid: reads as a constellation, not a snake.
      const cx = g.points.reduce((s, p) => s + p.sx, 0) / g.points.length;
      const cy = g.points.reduce((s, p) => s + p.sy, 0) / g.points.length;
      const path = g.points
        .map(
          (p) =>
            `${cx.toFixed(0)},${cy.toFixed(0)} ${p.sx.toFixed(0)},${p.sy.toFixed(0)}`
        )
        .join(" ");

      const halo = node.querySelector(".vs-tether-halo") as SVGPolylineElement;
      const core = node.querySelector(".vs-tether-core") as SVGPolylineElement;
      const hit = node.querySelector(".vs-tether-hit") as SVGPolylineElement;
      for (const line of [halo, core, hit]) line.setAttribute("points", path);

      // Styled inline rather than by attribute: the stylesheet's class rules
      // out-rank presentation attributes, so only inline style can be tuned.
      halo.style.stroke = g.color;
      halo.style.strokeWidth = String(style.width * 5);
      halo.style.strokeOpacity = String(style.opacity * 0.28);
      halo.style.filter = style.glow ? `blur(${(style.glow * 0.5).toFixed(1)}px)` : "none";

      core.style.stroke = g.color;
      core.style.strokeWidth = String(style.width);
      core.style.strokeOpacity = String(style.opacity);
      // Dashes aren't decoration: they mean the bond is loose.
      core.style.strokeDasharray = g.rigid ? "none" : "4 7";
      core.style.filter = style.glow
        ? `drop-shadow(0 0 ${style.glow}px ${g.color})`
        : "none";

      this.paintStars(node, g, style);

      const label = node.querySelector(".vs-tether-label") as SVGTextElement;
      label.style.display = style.labels ? "" : "none";
      label.setAttribute("x", cx.toFixed(0));
      label.setAttribute("y", (cy - 12).toFixed(0));
      label.style.fill = g.color;
      const text = g.rigid ? g.name : `${g.name} \u00b7 loose`;
      if (label.textContent !== text) label.textContent = text;
    }

    for (const [id] of this.nodes) if (!seen.has(id)) this.remove(id);
  }

  private paintStars(node: SVGGElement, g: TetherGroup, style: TetherStyle): void {
    const stars = node.querySelector(".vs-tether-stars") as SVGGElement;
    while (stars.childNodes.length > g.points.length) stars.lastChild!.remove();
    while (stars.childNodes.length < g.points.length) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("class", "vs-tether-star");
      stars.appendChild(c);
    }
    g.points.forEach((p, i) => {
      const c = stars.childNodes[i] as SVGCircleElement;
      c.setAttribute("cx", p.sx.toFixed(0));
      c.setAttribute("cy", p.sy.toFixed(0));
      c.setAttribute("r", (2 + style.width * 0.9).toFixed(1));
      c.style.fill = g.color;
      c.style.filter = style.glow
        ? `drop-shadow(0 0 ${(style.glow * 0.8).toFixed(1)}px ${g.color})`
        : "none";
    });
  }

  private nodeFor(id: string): SVGGElement {
    const existing = this.nodes.get(id);
    if (existing) return existing;

    const node = document.createElementNS(SVG_NS, "g");
    node.setAttribute("class", "vs-tether");
    for (const cls of ["vs-tether-halo", "vs-tether-core", "vs-tether-hit"]) {
      const line = document.createElementNS(SVG_NS, "polyline");
      line.setAttribute("class", cls);
      node.appendChild(line);
    }
    const stars = document.createElementNS(SVG_NS, "g");
    stars.setAttribute("class", "vs-tether-stars");
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "vs-tether-label");
    node.append(stars, label);

    // The thread is the control: click it to harden or loosen the bond.
    node
      .querySelector(".vs-tether-hit")!
      .addEventListener("click", () => this.onToggle(id));

    this.svgEl.appendChild(node);
    this.nodes.set(id, node);
    return node;
  }

  remove(id: string): void {
    this.nodes.get(id)?.remove();
    this.nodes.delete(id);
  }

  clear(): void {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
  }
}
