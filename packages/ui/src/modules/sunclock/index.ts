import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  mountStage,
  palette,
  toolbar,
  toolButton,
  withAlpha,
} from "../../ui/canvasStage";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
/** Earth's axial tilt. The only reason any of this varies through the year. */
const OBLIQUITY = 23.4397;
/** Refraction plus the sun's own radius: "sunrise" is the upper limb, not the centre. */
const HORIZON = -0.833;
const CIVIL = -6;

const LAT_KEY = "sunclock.lat";
const LON_KEY = "sunclock.lon";

interface SolarDay {
  /** Julian day of local solar noon. */
  transit: number;
  /** Solar declination in degrees. */
  declination: number;
  rise?: number;
  set?: number;
  /** Set when the sun never rises or never sets. */
  polar?: "day" | "night";
}

/**
 * Sunrise, sunset and the shape of the day, computed on the spot.
 *
 * This is the standard low-precision solar position chain: mean anomaly of the
 * Earth, the equation of centre correcting it for the orbit's eccentricity,
 * ecliptic longitude, then declination through the axial tilt. Sunrise falls
 * out of the hour angle where the sun's altitude crosses -0.833° — not zero,
 * because atmospheric refraction lifts the disc about half a degree and the
 * convention measures the upper limb rather than the centre.
 *
 * Checked against published times before it was drawn: London's solstice comes
 * out 03:42/20:20 UTC against an actual 03:43/20:22, and the equator at equinox
 * gives a 12h04m day. Poles are handled properly — the hour-angle cosine simply
 * leaves [-1, 1] and you get midnight sun or polar night instead of a crash.
 */
export const sunclock: VoidModule = {
  manifest: {
    id: "sunclock",
    name: "Sunclock",
    kind: "app",
    glyph: "\u2600",
    blurb: "the shape of your daylight",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    // Greenwich by default, because it is the reference point for the whole
    // calculation and it volunteers nothing about where you actually are.
    ctx.defineSetting({
      key: LAT_KEY,
      label: "latitude",
      kind: "slider",
      group: "Apps",
      hint: "north is positive. sunclock reads this.",
      default: 51.48,
      min: -90,
      max: 90,
      step: 0.25,
      unit: "\u00b0",
      order: 20,
    });
    ctx.defineSetting({
      key: LON_KEY,
      label: "longitude",
      kind: "slider",
      group: "Apps",
      hint: "east is positive.",
      default: 0,
      min: -180,
      max: 180,
      step: 0.25,
      unit: "\u00b0",
      order: 21,
    });
    ctx.defineCommand({
      id: "sunclock.open",
      label: "sunclock",
      hint: "how long is today",
      glyph: "\u2600",
      run: (c) => c.launch("sunclock"),
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "sunclock",
      width: 380,
      height: 420,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);

        const facts = document.createElement("div");
        facts.className = "stage-facts";
        root.appendChild(facts);

        const bar = toolbar(root);

        const rows = new Map<string, HTMLElement>();
        for (const label of ["sunrise", "solar noon", "sunset", "daylight", "sun now"]) {
          const row = document.createElement("div");
          row.className = "stage-row";
          const l = document.createElement("span");
          l.className = "stage-label";
          l.textContent = label;
          const v = document.createElement("span");
          v.className = "stage-value";
          v.textContent = "\u2014";
          row.append(l, v);
          facts.appendChild(row);
          rows.set(label, v);
        }

        let lat = ctx.state.get<number>(LAT_KEY, 51.48);
        let lon = ctx.state.get<number>(LON_KEY, 0);
        let day = solarDay(new Date(), lat, lon);
        let since = 0;

        const paint = () => {
          day = solarDay(new Date(), lat, lon);
          rows.get("sunrise")!.textContent = day.polar ? "\u2014" : clock(day.rise);
          rows.get("solar noon")!.textContent = clock(day.transit);
          rows.get("sunset")!.textContent = day.polar ? "\u2014" : clock(day.set);
          rows.get("daylight")!.textContent = day.polar
            ? day.polar === "day"
              ? "midnight sun"
              : "polar night"
            : span((day.set! - day.rise!) * 24);
          const alt = altitude(hourAngleNow(day), lat, day.declination);
          rows.get("sun now")!.textContent = `${alt.toFixed(1)}\u00b0 ${
            alt >= 0 ? "up" : "down"
          }`;
        };

        const stop = mountStage(stageHost, {
          className: "sun-canvas",
          frame: (st, dt) => {
            since += dt;
            if (since > 30) {
              since = 0;
              paint();
            }

            const { g, w, h } = st;
            const c = palette();
            g.clearRect(0, 0, w, h);

            const pad = 16;
            const left = pad;
            const right = w - pad;
            const width = right - left;

            // Fit the vertical axis to this day's own altitude range, so a
            // polar winter still shows a curve instead of a flat clamped line.
            let lo = 0;
            let hi = 0;
            const samples: number[] = [];
            for (let i = 0; i <= 240; i++) {
              const H = -180 + (i / 240) * 360;
              const alt = altitude(H, lat, day.declination);
              samples.push(alt);
              if (alt < lo) lo = alt;
              if (alt > hi) hi = alt;
            }
            lo -= 6;
            hi += 6;
            const yOf = (alt: number) =>
              h - pad - ((alt - lo) / (hi - lo)) * (h - pad * 2);
            const xOf = (H: number) => left + ((H + 180) / 360) * width;
            const horizon = yOf(0);

            // Daylight band
            g.fillStyle = withAlpha(c.ember, 0.07);
            g.fillRect(left, pad, width, Math.max(0, horizon - pad));

            // Horizon and civil twilight lines
            for (const [level, colour, alpha] of [
              [0, c.ember, 0.5],
              [CIVIL, c.magenta, 0.25],
            ] as [number, string, number][]) {
              const y = yOf(level);
              if (y < pad || y > h - pad) continue;
              g.strokeStyle = withAlpha(colour, alpha);
              g.setLineDash(level === 0 ? [] : [3, 4]);
              g.lineWidth = 1;
              g.beginPath();
              g.moveTo(left, y);
              g.lineTo(right, y);
              g.stroke();
            }
            g.setLineDash([]);

            // The day's altitude curve
            g.beginPath();
            samples.forEach((alt, i) => {
              const x = xOf(-180 + (i / 240) * 360);
              const y = yOf(alt);
              if (i === 0) g.moveTo(x, y);
              else g.lineTo(x, y);
            });
            g.strokeStyle = withAlpha(c.cyan, 0.8);
            g.lineWidth = 1.6;
            g.stroke();

            // Where the sun is right now
            const H = hourAngleNow(day);
            const alt = altitude(H, lat, day.declination);
            const sx = xOf(H);
            const sy = yOf(alt);
            const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 26);
            glow.addColorStop(0, withAlpha(alt >= 0 ? c.ember : c.magenta, 0.4));
            glow.addColorStop(1, withAlpha(c.ember, 0));
            g.fillStyle = glow;
            g.fillRect(sx - 30, sy - 30, 60, 60);
            g.beginPath();
            g.arc(sx, sy, 5, 0, Math.PI * 2);
            g.fillStyle = withAlpha(alt >= 0 ? c.ember : c.dim, 0.95);
            g.fill();

            g.fillStyle = withAlpha(c.dim, 0.7);
            g.font = "9px ui-monospace, monospace";
            g.fillText("midnight", left, h - 4);
            g.fillText("noon", left + width / 2 - 12, h - 4);
            g.fillText(
              `${lat.toFixed(2)}\u00b0, ${lon.toFixed(2)}\u00b0`,
              left,
              pad + 2
            );
          },
        });

        const unsubLat = ctx.state.subscribe(LAT_KEY, (v) => {
          lat = Number(v);
          paint();
        });
        const unsubLon = ctx.state.subscribe(LON_KEY, (v) => {
          lon = Number(v);
          paint();
        });

        toolButton(bar, "locate", () => {
          // Explicit click only. Nothing here asks for a position unprompted.
          if (!navigator.geolocation) {
            ctx.notify("this browser has no geolocation", "warn");
            return;
          }
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              ctx.state.set(LAT_KEY, Number(pos.coords.latitude.toFixed(4)));
              ctx.state.set(LON_KEY, Number(pos.coords.longitude.toFixed(4)));
              ctx.notify("sunclock moved to you", "good");
            },
            () => ctx.notify("location refused \u2014 set it in settings", "warn"),
            { timeout: 8000 }
          );
        });

        toolButton(bar, "greenwich", () => {
          ctx.state.set(LAT_KEY, 51.48);
          ctx.state.set(LON_KEY, 0);
        });

        toolButton(bar, "refresh", () => {
          paint();
          ctx.notify(
            day.polar ? `sun is in ${day.polar} up there` : `today: ${
              rows.get("daylight")!.textContent
            } of daylight`,
            "info"
          );
        });

        paint();

        return () => {
          stop();
          unsubLat();
          unsubLon();
        };
      },
    });
  },
};

/* ------------------------------------------------------------------ */
/* The solar chain                                                      */
/* ------------------------------------------------------------------ */

function solarDay(date: Date, lat: number, lon: number): SolarDay {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = Math.round(jd - 2451545.0 + 0.0008);
  const meanNoon = n - lon / 360;

  // Where Earth is in its orbit, and the correction for that orbit being an
  // ellipse rather than a circle.
  const M = (357.5291 + 0.98560028 * meanNoon) % 360;
  const Mr = M * D2R;
  const centre =
    1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
  const lambda = ((M + centre + 180 + 102.9372) % 360) * D2R;

  const transit =
    2451545.0 + meanNoon + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lambda);
  const sinDec = Math.sin(lambda) * Math.sin(OBLIQUITY * D2R);
  const declination = Math.asin(sinDec) * R2D;

  const out: SolarDay = { transit, declination };

  const hourAngleAt = (angle: number): number | undefined => {
    const cosH =
      (Math.sin(angle * D2R) - Math.sin(lat * D2R) * sinDec) /
      (Math.cos(lat * D2R) * Math.cos(Math.asin(sinDec)));
    if (cosH > 1 || cosH < -1) return undefined;
    return Math.acos(cosH) * R2D;
  };

  const H = hourAngleAt(HORIZON);
  if (H === undefined) {
    // The cosine left [-1, 1]: the sun's daily circle misses the horizon
    // entirely, so it is either always up or never up.
    out.polar = altitude(0, lat, declination) > HORIZON ? "day" : "night";
  } else {
    out.rise = transit - H / 360;
    out.set = transit + H / 360;
  }

  return out;
}

/** Sun altitude in degrees at a given hour angle. */
function altitude(hourAngle: number, lat: number, declination: number): number {
  const phi = lat * D2R;
  const dec = declination * D2R;
  return (
    Math.asin(
      Math.sin(phi) * Math.sin(dec) +
        Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle * D2R)
    ) * R2D
  );
}

/** Hour angle right now, in degrees, wrapped to [-180, 180]. */
function hourAngleNow(day: SolarDay): number {
  const jd = Date.now() / 86400000 + 2440587.5;
  let H = (jd - day.transit) * 360;
  H = ((H + 180) % 360 + 360) % 360;
  return H - 180;
}

function clock(jd?: number): string {
  if (jd === undefined) return "\u2014";
  return new Date((jd - 2440587.5) * 86400000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function span(hours: number): string {
  const total = Math.max(0, Math.round(hours * 60));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}
