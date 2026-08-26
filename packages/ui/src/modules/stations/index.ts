import type { KernelContext, StationKind, VoidModule } from "../../kernel/types";

const KINDS: { kind: StationKind; glyph: string; blurb: string }[] = [
  { kind: "rock", glyph: "◉", blurb: "terrain, mottled and quiet" },
  { kind: "giant", glyph: "◕", blurb: "banded, with a ring" },
  { kind: "ring", glyph: "⦸", blurb: "a hub and a habitat ring" },
];

/**
 * Stations are places, not decorations.
 *
 * Cosmos spawns bodies that drift past; a station holds still where you
 * found it, so it's somewhere you can leave and come back to. Travel eases
 * the camera there and engages warp for the trip. Windows can ride a
 * station two ways: docked to its surface (fixed, seen from orbit) or in
 * orbit around it (a real moon, not a decoration).
 */
export const stations: VoidModule = {
  manifest: {
    id: "stations",
    name: "Stations",
    kind: "app",
    glyph: "⦸",
    blurb: "found a place, then travel to it",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "stations.found",
      label: "found a station",
      hint: "a rock, out where you're looking",
      glyph: "◉",
      run: (c) => {
        c.spawnStation("rock");
        c.notify("founded — open Stations to travel there", "good");
      },
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "stations",
      width: 360,
      height: 440,
      render: (root) => {
        root.innerHTML = "";

        const foundLabel = label("found a station");
        const foundRow = document.createElement("div");
        foundRow.className = "cos-kinds";
        for (const k of KINDS) {
          const b = document.createElement("button");
          b.className = "cos-kind";
          b.title = k.blurb;
          b.innerHTML = `<span class="cos-kind-glyph">${k.glyph}</span><span class="cos-kind-name">${k.kind}</span>`;
          b.addEventListener("click", () => {
            ctx.spawnStation(k.kind);
            refresh();
          });
          foundRow.appendChild(b);
        }

        const stationsLabel = label("your stations");
        const stationList = document.createElement("div");
        stationList.className = "stn-list";

        const divider1 = document.createElement("div");
        divider1.className = "cos-divider";

        const windowsLabel = label("dock or orbit a window");
        const windowList = document.createElement("div");
        windowList.className = "stn-list";

        const divider2 = document.createElement("div");
        divider2.className = "cos-divider";

        const how = document.createElement("div");
        how.className = "cos-how";
        how.innerHTML =
          "<b>docked</b> windows sit fixed on the surface, as if you're looking down from orbit.<br>" +
          "<b>orbiting</b> windows ride a real moon path around the body — pick any body, station or not.<br>" +
          "<b>travel</b> eases the camera there and engages warp for the trip.";

        root.append(
          foundLabel,
          foundRow,
          stationsLabel,
          stationList,
          divider1,
          windowsLabel,
          windowList,
          divider2,
          how
        );

        function refresh(): void {
          const here = ctx.currentStation();
          const list = ctx.listStations();
          stationList.replaceChildren();
          if (!list.length) {
            const empty = document.createElement("div");
            empty.className = "stn-empty";
            empty.textContent = "nothing founded yet";
            stationList.appendChild(empty);
          }
          for (const s of list) {
            const row = document.createElement("div");
            row.className = "stn-row";

            const glyph = KINDS.find((k) => k.kind === s.kind)?.glyph ?? "○";
            const name = document.createElement("span");
            name.className = "stn-name";
            name.textContent = `${glyph} ${s.name}${s.id === here ? "  · here" : ""}`;

            const rename = document.createElement("button");
            rename.className = "stn-icon-btn";
            rename.textContent = "✎";
            rename.title = "rename";
            rename.addEventListener("click", () => startRename(row, name, s.id));

            const travel = document.createElement("button");
            travel.className = "cos-btn stn-travel";
            travel.textContent = s.id === here ? "here" : "travel";
            travel.disabled = s.id === here;
            travel.addEventListener("click", () => {
              ctx.travelTo(s.id);
              ctx.notify(`travelling to ${s.name}…`, "good");
              setTimeout(refresh, 2000);
            });

            const kill = document.createElement("button");
            kill.className = "cos-kill";
            kill.textContent = "✕";
            kill.title = "destroy this station";
            kill.addEventListener("click", () => {
              ctx.destroyStation(s.id);
              refresh();
            });

            row.append(name, rename, travel, kill);
            stationList.appendChild(row);
          }
          refreshWindows();
        }

        function startRename(row: HTMLElement, name: HTMLElement, id: string): void {
          const input = document.createElement("input");
          input.className = "stn-rename-input";
          input.value = ctx.listStations().find((s) => s.id === id)?.name ?? "";
          const commit = () => {
            ctx.renameStation(id, input.value);
            refresh();
          };
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") refresh();
          });
          input.addEventListener("blur", commit);
          row.replaceChild(input, name);
          input.focus();
          input.select();
        }

        function refreshWindows(): void {
          const list = ctx.listStations();
          windowList.replaceChildren();
          const surfaces = ctx.openSurfaces();
          if (!surfaces.length) {
            const empty = document.createElement("div");
            empty.className = "stn-empty";
            empty.textContent = "nothing open";
            windowList.appendChild(empty);
            return;
          }
          if (!list.length) {
            const empty = document.createElement("div");
            empty.className = "stn-empty";
            empty.textContent = "found a station first";
            windowList.appendChild(empty);
            return;
          }
          for (const s of surfaces) {
            const row = document.createElement("div");
            row.className = "stn-row";

            const name = document.createElement("span");
            name.className = "stn-name";
            name.textContent = s.title;

            const pick = document.createElement("select");
            pick.className = "cos-select stn-pick";
            for (const st of list) {
              const opt = document.createElement("option");
              opt.value = st.id;
              opt.textContent = st.name;
              pick.appendChild(opt);
            }

            const dock = document.createElement("button");
            dock.className = "stn-icon-btn";
            dock.textContent = "⚓";
            dock.title = "dock onto the surface";
            dock.addEventListener("click", () => {
              ctx.dockSurface(s.id, pick.value);
              ctx.notify("docked", "good");
            });

            const orbit = document.createElement("button");
            orbit.className = "stn-icon-btn";
            orbit.textContent = "↻";
            orbit.title = "send into orbit as a moon";
            orbit.addEventListener("click", () => {
              ctx.orbitSurface(s.id, pick.value);
              ctx.notify("in orbit", "good");
            });

            const release = document.createElement("button");
            release.className = "stn-icon-btn";
            release.textContent = "✕";
            release.title = "release — back to floating free";
            release.addEventListener("click", () => {
              ctx.dockSurface(s.id, null);
              ctx.orbitSurface(s.id, null);
              ctx.notify("released", "good");
            });

            row.append(name, pick, dock, orbit, release);
            windowList.appendChild(row);
          }
        }

        refresh();
        return () => root.replaceChildren();
      },
    });
  },
};

function label(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "cos-label";
  el.textContent = text;
  return el;
}
