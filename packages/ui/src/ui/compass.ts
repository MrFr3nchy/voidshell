/**
 * The compass: when a window drifts out of view, it doesn't vanish from your
 * life — a chevron pins itself to the edge of the screen in that window's
 * direction. Click it and the void rotates until you're facing it again.
 *
 * This is the piece that makes an infinite space navigable. Without it, "look
 * around" is a memory game; with it, nothing you opened is ever really lost.
 */
export interface CompassItem {
  id: string;
  kind: "surface" | "group";
  label: string;
  /** Screen-space bearing in radians, 0 = right, CCW positive. */
  angle: number;
  /** World distance from the camera, used only to size the marker. */
  dist: number;
  /** True when the target is behind you rather than merely off to one side. */
  behind: boolean;
}

const MARGIN = 58;

export class Compass {
  private host: HTMLElement;
  private nodes = new Map<string, HTMLButtonElement>();
  private onSelect: (kind: CompassItem["kind"], id: string) => void;
  private enabled = true;

  constructor(
    host: HTMLElement,
    onSelect: (kind: CompassItem["kind"], id: string) => void
  ) {
    this.host = host;
    this.onSelect = onSelect;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.sync([]);
  }

  sync(items: CompassItem[]): void {
    if (!this.enabled) items = [];

    const w = window.innerWidth;
    const h = window.innerHeight;
    const rx = Math.max(60, w / 2 - MARGIN);
    const ry = Math.max(60, h / 2 - MARGIN);
    const seen = new Set<string>();

    for (const item of items) {
      seen.add(item.id);
      let node = this.nodes.get(item.id);
      if (!node) {
        node = document.createElement("button");
        node.className = "vs-compass-pip";
        node.innerHTML =
          '<span class="pip-arrow">\u25b6</span><span class="pip-label"></span>';
        node.addEventListener("click", () => this.onSelect(item.kind, item.id));
        this.host.appendChild(node);
        this.nodes.set(item.id, node);
        // Let it fade in rather than pop.
        requestAnimationFrame(() => node!.classList.add("live"));
      }

      const label = node.querySelector(".pip-label");
      if (label && label.textContent !== item.label) label.textContent = item.label;
      node.classList.toggle("is-group", item.kind === "group");
      node.classList.toggle("is-behind", item.behind);

      // Screen y grows downward, so the bearing is negated when placing.
      const x = w / 2 + Math.cos(item.angle) * rx;
      const y = h / 2 - Math.sin(item.angle) * ry;
      const deg = (-item.angle * 180) / Math.PI;
      // Far things get a slightly smaller pip: distance you can feel.
      const scale = Math.max(0.72, Math.min(1, 1200 / Math.max(400, item.dist)));

      node.style.left = `${x.toFixed(1)}px`;
      node.style.top = `${y.toFixed(1)}px`;
      node.style.setProperty("--pip-rot", `${deg.toFixed(1)}deg`);
      node.style.setProperty("--pip-scale", scale.toFixed(3));
    }

    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue;
      this.nodes.delete(id);
      node.classList.remove("live");
      setTimeout(() => node.remove(), 200);
    }
  }

  dispose(): void {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
  }
}
