/**
 * The flat map: shaded relief, drawn straight down.
 *
 * Exists because the sky view is the wrong tool three times over — thumbnails
 * in the library would each need a WebGL context, the forge needs a preview
 * that survives being redrawn on every slider drag, and "what shape is this
 * continent" is a question a top-down image answers better than any camera.
 *
 * Every entry point tolerates a null 2D context and does nothing. That is not
 * defensive habit: the headless harness runs this in jsdom, which has no
 * canvas backend at all.
 */
import type { Field, Marker, TerrainParams } from "./types";

export interface AtlasOptions {
  /** Draw place names and pins over the relief. */
  markers?: Marker[];
  /** Ink for the marker pins and labels. */
  ink?: string;
  /** Sun azimuth in radians, measured clockwise from north. */
  sunAzimuth?: number;
  /** How hard the relief shading bites, 0..1. */
  relief?: number;
}

/**
 * Render `field` to fill `canvas`, letterboxed to stay square.
 *
 * The relief is built at grid resolution into an ImageData and then scaled up
 * by the canvas, rather than being drawn per-pixel at display size — a 192²
 * buffer is 37k pixels whatever the panel is, which is what keeps the forge
 * preview interactive while a slider is moving.
 */
export function drawAtlas(
  canvas: HTMLCanvasElement,
  field: Field,
  params: TerrainParams,
  opts: AtlasOptions = {}
): void {
  const g = canvas.getContext("2d");
  if (!g) return;

  const w = canvas.width;
  const h = canvas.height;
  if (w < 2 || h < 2) return;

  const relief = drawnRelief(field, params, opts);
  g.clearRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";

  // Square, centred. Stretching a map to fit a rectangle is a lie about the
  // land, and this one has a scale bar on it.
  const side = Math.min(w, h);
  const ox = (w - side) / 2;
  const oy = (h - side) / 2;
  if (relief) g.drawImage(relief, ox, oy, side, side);

  const markers = opts.markers ?? [];
  if (markers.length) drawMarkers(g, markers, ox, oy, side, opts.ink ?? "#e8f2ff");
}

/** The relief itself, as an offscreen canvas at grid resolution. */
function drawnRelief(
  field: Field,
  params: TerrainParams,
  opts: AtlasOptions
): HTMLCanvasElement | null {
  const n = field.size;
  const buf = document.createElement("canvas");
  buf.width = n;
  buf.height = n;
  const bg = buf.getContext("2d");
  if (!bg) return null;

  const img = bg.createImageData(n, n);
  const px = img.data;
  const { h, rgb, water } = field;

  const az = opts.sunAzimuth ?? -Math.PI * 0.75;
  const strength = opts.relief ?? 1;
  // Light direction in grid space, from up and to the north-west by default.
  const lx = Math.cos(az);
  const ly = Math.sin(az);
  const lz = 0.72;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // Any water, not just the sea. A river is a cell whose height is well
      // above the waterline, so testing sea level alone hillshades the inside
      // of every channel — which draws each one as a bright rim and a dark
      // rim, exactly like the ridge it is the opposite of.
      const under = h[i] < params.seaLevel || water.surface[i] >= 0;

      let shade = 1;
      if (!under) {
        // Central differences scaled by resolution, so the shading looks the
        // same whether the map is 128 or 256 across.
        const dx = h[y * n + Math.min(n - 1, x + 1)] - h[y * n + Math.max(0, x - 1)];
        const dy = h[Math.min(n - 1, y + 1) * n + x] - h[Math.max(0, y - 1) * n + x];
        const sx = -dx * n * 0.5;
        const sy = -dy * n * 0.5;
        const inv = 1 / Math.hypot(sx, sy, 1);
        const dot = (sx * lx + sy * ly + lz) * inv;
        shade = 0.42 + 0.78 * Math.max(0, dot);
        shade = 1 + (shade - 1) * strength;
      } else {
        // A flat wash under water, lifted very slightly in the shallows so the
        // shelf reads without the sea acquiring hills.
        shade = 0.94;
      }

      px[i * 4] = clamp255(rgb[i * 3] * shade * 255);
      px[i * 4 + 1] = clamp255(rgb[i * 3 + 1] * shade * 255);
      px[i * 4 + 2] = clamp255(rgb[i * 3 + 2] * shade * 255);
      px[i * 4 + 3] = 255;
    }
  }

  bg.putImageData(img, 0, 0);
  return buf;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function drawMarkers(
  g: CanvasRenderingContext2D,
  markers: Marker[],
  ox: number,
  oy: number,
  side: number,
  ink: string
): void {
  g.save();
  g.font = `${Math.max(9, Math.round(side * 0.026))}px ui-monospace, monospace`;
  g.textBaseline = "middle";
  g.lineWidth = 3;
  g.strokeStyle = "rgba(4,8,16,0.72)";

  for (const m of markers) {
    const x = ox + m.u * side;
    const y = oy + m.v * side;

    g.beginPath();
    g.arc(x, y, m.kind === "hold" ? 3.6 : 2.4, 0, Math.PI * 2);
    g.fillStyle = ink;
    g.stroke();
    g.fill();

    // Outline first, then fill: a one-pass label vanishes over snow.
    const label = m.name;
    const tx = x + 7;
    g.strokeText(label, tx, y);
    g.fillStyle = ink;
    g.fillText(label, tx, y);
  }
  g.restore();
}

/**
 * A small standalone thumbnail, for the library grid.
 *
 * Separate from `drawAtlas` because the sizes involved make labels illegible
 * and the pins into noise — a thumbnail's job is to be recognisable at 160px,
 * which means shape and colour and nothing else.
 */
export function drawThumbnail(
  canvas: HTMLCanvasElement,
  field: Field,
  params: TerrainParams
): void {
  drawAtlas(canvas, field, params, { relief: 0.85 });
}
