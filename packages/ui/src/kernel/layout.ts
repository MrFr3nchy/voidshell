import type { SurfacePlacement, Vec3 } from "./types";

/**
 * Where a set of windows sat, relative to one another.
 *
 * A saved dashboard has always remembered *which* apps and nothing else, so
 * reopening one gave you the right four windows in four arbitrary places and
 * left you to rebuild the arrangement that was the point of saving it.
 *
 * ## Why this is relative, and why it names a backend
 *
 * The obvious implementation — store each window's `SurfacePlacement` and put
 * it back — is wrong twice. Absolute positions restore a dashboard behind you
 * if the camera has turned since, and they are meaningless across render
 * backends: `anchor` is a point in a 3D world under `three-projected` and a
 * point on a plane under `dom-flat`, in units that do not correspond.
 *
 * So a layout is offsets from the group's own centre, applied at wherever you
 * are looking now — which is stable under a camera that has moved — and it
 * records which compositor produced it. A layout from another world is
 * **refused rather than approximated**. There is no honest conversion between
 * a sphere and a plane, and a dashboard that reopens scattered across the void
 * is worse than one that reopens unarranged, because the second is obviously
 * unarranged and the first looks broken.
 */

/** One window's place within a constellation. */
export interface LayoutSlot {
  /** Offset from the centre of the group, in the backend's own units. */
  dx: number;
  dy: number;
  dz: number;
  width: number;
  height: number;
  /**
   * The states worth carrying. A window that was collapsed or wearing a shape
   * was that way on purpose; a window that was *snapped* was filling a region
   * of the screen, which is a property of the screen and not of the group.
   */
  minimized?: boolean;
  form?: string;
}

export interface WindowLayout {
  /** `Compositor.name` of whatever produced it. */
  backend: string;
  /** Parallel to the surface ids the layout was captured from. */
  slots: LayoutSlot[];
}

/**
 * Reduce a set of placements to offsets from their own centre.
 *
 * Returns `null` when there is nothing worth remembering: no compositor
 * placements at all, or fewer than two windows — one window has no
 * arrangement, and pretending otherwise would have the group's centre land on
 * the window itself and restore it exactly where you were already looking.
 *
 * Windows that are pinned or snapped are skipped rather than recorded. Both
 * are measured against the viewport, so their "position" is a fact about the
 * screen the dashboard was saved on, and carrying it would scatter the group
 * on any other screen.
 */
export function captureLayout(
  backend: string,
  ids: readonly string[],
  places: Record<string, SurfacePlacement>
): WindowLayout | null {
  const rows = ids.map((id) => places[id]).filter((p): p is SurfacePlacement => Boolean(p));
  const free = rows.filter((p) => !p.pinned && !p.snap);
  if (free.length < 2) return null;

  const cx = free.reduce((a, p) => a + p.anchor[0], 0) / free.length;
  const cy = free.reduce((a, p) => a + p.anchor[1], 0) / free.length;
  const cz = free.reduce((a, p) => a + p.anchor[2], 0) / free.length;

  return {
    backend,
    slots: free.map((p) => ({
      dx: p.anchor[0] - cx,
      dy: p.anchor[1] - cy,
      dz: p.anchor[2] - cz,
      width: p.width,
      height: p.height,
      ...(p.minimized ? { minimized: true } : {}),
      ...(p.form && p.form !== "plain" ? { form: p.form } : {}),
    })),
  };
}

/**
 * Turn a layout back into placements, centred on `centre`.
 *
 * Pairs slots with ids by position, and stops at whichever runs out. A
 * dashboard whose app list has been edited since, or one where a module
 * refused to launch, gets the windows it does have arranged among themselves
 * rather than nothing at all.
 */
export function placementsFor(
  layout: WindowLayout,
  ids: readonly string[],
  centre: Vec3
): { id: string; place: SurfacePlacement }[] {
  const n = Math.min(ids.length, layout.slots.length);
  const out: { id: string; place: SurfacePlacement }[] = [];
  for (let i = 0; i < n; i++) {
    const s = layout.slots[i];
    out.push({
      id: ids[i],
      place: {
        anchor: [centre.x + s.dx, centre.y + s.dy, centre.z + s.dz],
        width: s.width,
        height: s.height,
        pinned: false,
        pinX: 0,
        pinY: 0,
        snap: null,
        minimized: s.minimized ?? false,
        form: s.form ?? "plain",
      },
    });
  }
  return out;
}

/**
 * Whether this layout can be applied by the compositor now running.
 *
 * Its own function because it is the whole of the cross-backend policy, and a
 * policy expressed as one comparison in the middle of a longer method is a
 * policy that gets quietly relaxed.
 */
export function layoutFits(layout: WindowLayout | undefined, backend: string): boolean {
  return Boolean(layout) && layout!.backend === backend && layout!.slots.length > 0;
}
