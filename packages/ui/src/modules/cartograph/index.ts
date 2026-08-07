/**
 * Cartograph — build a world, then go and look at it.
 *
 * Three views over one document. The library lists what is in ~/maps, the
 * forge is eleven sliders and a live relief preview, and the sky view is a
 * camera over the finished ground. They are views rather than apps because a
 * map is a thing you make *and* a thing you visit, and splitting that across
 * two windows would mean saving before you could see what you had done.
 *
 * The one hard rule in here: nothing may throw when there is no GPU. The
 * headless harness launches every registered app in jsdom, which has neither a
 * WebGL context nor a 2D one, so every canvas path checks and every sky view
 * has a flat fallback.
 */
import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";
import { drawAtlas, drawThumbnail } from "./atlas";
import { EXAMPLE_DOCS } from "./examples";
import {
  MAX_IMPORT_SIZE,
  docBytes,
  fieldFromDoc,
  importedFrom,
  parseDoc,
  sampleImage,
} from "./heightmap";
import { fieldFromParams, placeName, siteMarkers } from "./terrain";
import { DEFAULT_EXAGGERATION, createSkyView } from "./scene";
import type { SkyView } from "./scene";
import { DEFAULT_PARAMS, MAPS_DIR, MAP_EXT } from "./types";
import type { Field, MapDoc, Marker, MarkerKind, TerrainParams } from "./types";

const K_SHADOWS = "cartograph.shadows";
const K_DETAIL = "cartograph.detail";
const K_LABELS = "cartograph.labels";
const K_RELIEF = "cartograph.exaggeration";

/** Preview and thumbnail resolution. Small on purpose — these redraw a lot. */
const PREVIEW_SIZE = 128;
const THUMB_SIZE = 96;

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, className = "cg-btn"): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

function slider(spec: SliderSpec): HTMLElement {
  const row = el("label", "cg-slider");
  const name = el("span", "cg-slider-name", spec.label);
  const out = el("span", "cg-slider-value");
  const input = el("input");
  input.type = "range";
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);

  const show = (v: number) => {
    out.textContent = spec.format ? spec.format(v) : String(v);
  };
  show(spec.value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    show(v);
    spec.onInput(v);
  });

  const head = el("span", "cg-slider-head");
  head.append(name, out);
  row.append(head, input);
  return row;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "map";

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

function ensureLibrary(ctx: KernelContext): void {
  if (ctx.fs.exists(MAPS_DIR)) return;
  ctx.fs.mkdirp(MAPS_DIR);
  // Something to open on the first run, so the app doesn't introduce itself
  // with an empty shelf and a form.
  for (const doc of EXAMPLE_DOCS) {
    ctx.fs.write(`${MAPS_DIR}/${slug(doc.name)}.${MAP_EXT}`, JSON.stringify(doc, null, 2));
  }
}

function listMaps(ctx: KernelContext): { path: string; doc: MapDoc }[] {
  if (!ctx.fs.isDir(MAPS_DIR)) return [];
  const out: { path: string; doc: MapDoc }[] = [];
  for (const entry of ctx.fs.ls(MAPS_DIR)) {
    if (entry.kind !== "file" || !entry.name.endsWith(`.${MAP_EXT}`)) continue;
    try {
      out.push({ path: entry.path, doc: parseDoc(ctx.fs.read(entry.path)) });
    } catch {
      // A corrupt map should cost you that map, not the whole library.
    }
  }
  return out.sort((a, b) => a.doc.name.localeCompare(b.doc.name));
}

function saveMap(ctx: KernelContext, path: string, doc: MapDoc): void {
  ctx.fs.write(path, JSON.stringify(doc, null, 2));
}

/** A thumbnail-resolution field. Generated maps regenerate small; imports don't. */
function previewField(doc: MapDoc, size: number): Field {
  if (doc.imported) return fieldFromDoc(doc);
  return fieldFromParams({ ...doc.params, size });
}

/* ------------------------------------------------------------------ */
/* The module                                                          */
/* ------------------------------------------------------------------ */

export const cartograph: VoidModule = {
  manifest: {
    id: "cartograph",
    name: "Cartograph",
    kind: "app",
    glyph: "\u25b2",
    blurb: "build a world and fly over it",
    version: "0.1.0",
  },

  handles: [MAP_EXT],
  priority: 10,

  activate(ctx: KernelContext) {
    ctx.defineSetting({
      key: K_DETAIL,
      label: "Terrain detail",
      kind: "select",
      group: "Apps",
      hint: "grid resolution for newly forged maps",
      default: "192",
      options: [
        { value: "128", label: "128 — coarse" },
        { value: "192", label: "192 — balanced" },
        { value: "256", label: "256 — fine" },
      ],
    });
    ctx.defineSetting({
      key: K_RELIEF,
      label: "Vertical exaggeration",
      kind: "slider",
      group: "Apps",
      hint: "real relief is almost flat at map scale; every atlas ever printed cheats here",
      default: DEFAULT_EXAGGERATION,
      min: 1,
      max: 20,
      step: 1,
      unit: "\u00d7",
    });
    ctx.defineSetting({
      key: K_SHADOWS,
      label: "Terrain shadows",
      kind: "toggle",
      group: "Apps",
      hint: "cast shadows in the sky view",
      default: true,
    });
    ctx.defineSetting({
      key: K_LABELS,
      label: "Place labels",
      kind: "toggle",
      group: "Apps",
      default: true,
    });

    ctx.defineCommand({
      id: "cartograph.forge",
      label: "Forge a new map",
      hint: "cartograph",
      glyph: "\u25b2",
      run: (c) => c.launch("cartograph", { forge: true }),
    });

    return () => {};
  },

  launch(ctx: KernelContext, args?: LaunchArgs) {
    ensureLibrary(ctx);
    const openPath = typeof args?.path === "string" ? args.path : null;
    const startInForge = args?.forge === true;

    ctx.openSurface({
      title: "cartograph",
      width: 820,
      height: 560,
      render: (root) => mount(root, ctx, { openPath, startInForge }),
    });
  },
};

/* ------------------------------------------------------------------ */
/* The window                                                          */
/* ------------------------------------------------------------------ */

interface MountArgs {
  openPath: string | null;
  startInForge: boolean;
}

function mount(root: HTMLElement, ctx: KernelContext, args: MountArgs): () => void {
  root.replaceChildren();
  root.classList.add("cg-root");

  const bar = el("div", "cg-bar");
  const crumb = el("div", "cg-crumb", "library");
  const actions = el("div", "cg-bar-actions");
  bar.append(crumb, actions);

  const body = el("div", "cg-body");
  root.append(bar, body);

  let sky: SkyView | null = null;
  let disposed = false;
  let saveTimer = 0;

  /** Current document and the path it came from, when a map is open. */
  let doc: MapDoc | null = null;
  let path: string | null = null;

  const teardown = () => {
    disposed = true;
    window.clearTimeout(saveTimer);
    sky?.dispose();
    sky = null;
  };

  const queueSave = () => {
    if (!doc || !path) return;
    window.clearTimeout(saveTimer);
    const target = path;
    const snapshot = doc;
    saveTimer = window.setTimeout(() => {
      if (disposed) return;
      saveMap(ctx, target, snapshot);
    }, 400);
  };

  const clearBody = () => {
    sky?.dispose();
    sky = null;
    body.replaceChildren();
    actions.replaceChildren();
  };

  /* ---------------- library ---------------- */

  function showLibrary(): void {
    clearBody();
    doc = null;
    path = null;
    crumb.textContent = "library";
    actions.append(
      button("forge", () => showForge()),
      button("import\u2026", () => importImage())
    );

    const maps = listMaps(ctx);
    if (!maps.length) {
      const empty = el("div", "cg-empty");
      empty.append(
        el("p", undefined, "No maps yet."),
        el("p", "cg-dim", "Forge one from noise, or import a greyscale heightmap image.")
      );
      body.append(empty);
      return;
    }

    const grid = el("div", "cg-grid");
    for (const entry of maps) {
      grid.append(card(entry.path, entry.doc));
    }
    body.append(grid);
  }

  function card(mapPath: string, mapDoc: MapDoc): HTMLElement {
    const wrap = el("div", "cg-card");
    const canvas = el("canvas", "cg-thumb");
    canvas.width = 320;
    canvas.height = 320;

    // Thumbnails are generated at a fraction of the real resolution — a
    // library of a dozen 256² maps is otherwise a two-second stall on open.
    let field: Field | null = null;
    try {
      field = previewField(mapDoc, THUMB_SIZE);
      drawThumbnail(canvas, field, { ...mapDoc.params, size: field.size });
    } catch {
      // No canvas backend, or a map whose parameters no longer make sense.
    }

    const meta = el("div", "cg-card-meta");
    const title = el("div", "cg-card-name", mapDoc.name);
    const sub = el(
      "div",
      "cg-card-sub",
      mapDoc.imported
        ? `imported \u00b7 ${mapDoc.imported.size}\u00b2`
        : `seed ${mapDoc.params.seed} \u00b7 ${mapDoc.params.extentKm}km`
    );
    meta.append(title, sub);
    if (mapDoc.note) meta.append(el("div", "cg-card-note", mapDoc.note));

    const row = el("div", "cg-card-actions");
    row.append(
      button("open", () => openMap(mapPath, mapDoc), "cg-btn is-primary"),
      button("delete", () => remove(mapPath, mapDoc), "cg-btn is-quiet")
    );

    wrap.append(canvas, meta, row);
    canvas.addEventListener("dblclick", () => openMap(mapPath, mapDoc));
    return wrap;
  }

  function remove(mapPath: string, mapDoc: MapDoc): void {
    const text = ctx.fs.read(mapPath);
    ctx.fs.rm(mapPath);
    ctx.notify(`deleted ${mapDoc.name}`, {
      kind: "warn",
      action: {
        label: "undo",
        run: () => {
          ctx.fs.write(mapPath, text);
          showLibrary();
        },
      },
    });
    showLibrary();
  }

  /* ---------------- import ---------------- */

  function importImage(): void {
    const input = el("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void ingest(file);
    });
    input.click();
  }

  async function ingest(file: Blob): Promise<void> {
    try {
      const sampled = await sampleImage(file, MAX_IMPORT_SIZE, false);
      if (disposed) return;
      const params: TerrainParams = {
        ...DEFAULT_PARAMS,
        size: sampled.size,
        seed: (Date.now() & 0xffff) || 1,
      };
      const name = fileLabel(file) || "imported";
      const next: MapDoc = {
        format: "voidshell.map",
        version: 1,
        name,
        note: "imported heightmap",
        params,
        markers: [],
        imported: importedFrom(sampled),
      };
      const field = fieldFromDoc(next);
      next.markers = siteMarkers(field, params, 7);

      const target = `${MAPS_DIR}/${slug(name)}.${MAP_EXT}`;
      saveMap(ctx, target, next);
      ctx.notify(
        `imported ${name} \u2014 ${sampled.size}\u00b2, ${Math.round(docBytes(next) / 1024)}KB`,
        "good"
      );
      openMap(target, next);
    } catch (err) {
      ctx.notify(`could not read that image: ${(err as Error).message}`, "warn");
    }
  }

  function fileLabel(file: Blob): string {
    const named = file as Blob & { name?: string };
    if (typeof named.name !== "string") return "";
    return named.name.replace(/\.[^.]+$/, "").slice(0, 40);
  }

  /* ---------------- forge ---------------- */

  function showForge(): void {
    clearBody();
    crumb.textContent = "forge";
    actions.append(button("library", () => showLibrary(), "cg-btn is-quiet"));

    const detail = Number(ctx.state.get<string>(K_DETAIL, "192")) || 192;
    const params: TerrainParams = {
      ...DEFAULT_PARAMS,
      size: detail,
      seed: Math.floor(Math.random() * 0xffff) + 1,
    };
    let name = "New province";

    const pane = el("div", "cg-forge");
    const previewWrap = el("div", "cg-forge-preview");
    const canvas = el("canvas", "cg-preview");
    canvas.width = 512;
    canvas.height = 512;
    const stat = el("div", "cg-preview-stat");
    previewWrap.append(canvas, stat);

    const controls = el("div", "cg-forge-controls");

    const nameRow = el("label", "cg-field");
    nameRow.append(el("span", "cg-field-name", "name"));
    const nameInput = el("input", "cg-input");
    nameInput.type = "text";
    nameInput.value = name;
    nameInput.addEventListener("input", () => {
      name = nameInput.value;
    });
    nameRow.append(nameInput);
    controls.append(nameRow);

    let pending = 0;
    const redraw = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        if (disposed) return;
        try {
          const field = fieldFromParams({ ...params, size: PREVIEW_SIZE });
          drawAtlas(canvas, field, { ...params, size: PREVIEW_SIZE }, { relief: 0.9 });
          stat.textContent = `${Math.round(field.landFraction * 100)}% land \u00b7 peak ${Math.round(
            field.peak * params.reliefM
          )}m`;
        } catch {
          stat.textContent = "preview unavailable";
        }
      }, 60);
    };

    const bind = <K extends keyof TerrainParams>(
      key: K,
      spec: Omit<SliderSpec, "value" | "onInput">
    ) =>
      controls.append(
        slider({
          ...spec,
          value: params[key] as number,
          onInput: (v) => {
            (params[key] as number) = v;
            redraw();
          },
        })
      );

    const seedRow = el("div", "cg-field");
    seedRow.append(el("span", "cg-field-name", "seed"));
    const seedValue = el("span", "cg-seed", String(params.seed));
    seedRow.append(
      seedValue,
      button(
        "reroll",
        () => {
          params.seed = Math.floor(Math.random() * 0xffff) + 1;
          seedValue.textContent = String(params.seed);
          redraw();
        },
        "cg-btn is-quiet"
      )
    );
    controls.append(seedRow);

    bind("extentKm", { label: "extent", min: 60, max: 800, step: 10, format: (v) => `${v} km` });
    bind("reliefM", { label: "relief", min: 400, max: 9000, step: 100, format: (v) => `${v} m` });
    bind("seaLevel", {
      label: "sea level",
      min: 0,
      max: 0.85,
      step: 0.01,
      format: (v) => v.toFixed(2),
    });
    bind("ridges", { label: "ridges", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) });
    bind("continentality", {
      label: "island pull",
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => v.toFixed(2),
    });
    bind("warp", { label: "warp", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) });
    bind("erosion", { label: "erosion", min: 0, max: 60, step: 1, format: (v) => `${v} passes` });
    bind("latitude", {
      label: "latitude",
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => (v > 0.66 ? "arctic" : v > 0.33 ? "temperate" : "tropical"),
    });
    bind("aridity", {
      label: "aridity",
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => (v > 0.66 ? "desert" : v > 0.33 ? "dry" : "wet"),
    });

    const save = button(
      "forge it",
      () => {
        const field = fieldFromParams(params);
        const next: MapDoc = {
          format: "voidshell.map",
          version: 1,
          name: name.trim() || "untitled",
          params: { ...params },
          markers: siteMarkers(field, params),
        };
        const target = `${MAPS_DIR}/${slug(next.name)}.${MAP_EXT}`;
        saveMap(ctx, target, next);
        ctx.notify(`forged ${next.name}`, "good");
        openMap(target, next, field);
      },
      "cg-btn is-primary is-wide"
    );
    controls.append(save);

    pane.append(previewWrap, controls);
    body.append(pane);
    redraw();
  }

  /* ---------------- sky view ---------------- */

  function openMap(mapPath: string, mapDoc: MapDoc, prebuilt?: Field): void {
    clearBody();
    doc = mapDoc;
    path = mapPath;
    crumb.textContent = mapDoc.name;
    actions.append(button("library", () => showLibrary(), "cg-btn is-quiet"));

    let field: Field;
    try {
      field = prebuilt ?? fieldFromDoc(mapDoc);
    } catch (err) {
      body.append(el("div", "cg-empty", `could not build this map: ${(err as Error).message}`));
      return;
    }

    const view = el("div", "cg-view");
    const stageHost = el("div", "cg-stage");
    const panel = el("div", "cg-panel");
    view.append(stageHost, panel);
    body.append(view);

    sky = createSkyView(stageHost, {
      shadows: ctx.state.get<boolean>(K_SHADOWS, true),
      onPickGround: (u, v) => addMarker(u, v),
      onPickMarker: (id) => {
        const m = mapDoc.markers.find((x) => x.id === id);
        if (m) sky?.flyTo(m.u, m.v);
      },
    });

    if (!sky) {
      // No WebGL. Show the flat map rather than an apology — it is the same
      // data, and on a machine without a GPU it is the only view there is.
      const flat = el("canvas", "cg-flat");
      flat.width = 900;
      flat.height = 900;
      try {
        drawAtlas(flat, field, mapDoc.params, { markers: mapDoc.markers });
      } catch {
        /* no canvas backend either — the harness. */
      }
      stageHost.append(flat);
      stageHost.append(el("div", "cg-note", "no WebGL here \u2014 showing the flat atlas"));
    } else {
      sky.setTerrain(field, mapDoc.params);
      sky.setMarkers(mapDoc.markers);
      sky.setExaggeration(ctx.state.get<number>(K_RELIEF, DEFAULT_EXAGGERATION));
      sky.setLabelsVisible(ctx.state.get<boolean>(K_LABELS, true));
      sky.setSun(0.34);
    }

    buildPanel(panel, mapDoc, field);
  }

  function addMarker(u: number, v: number): void {
    if (!doc) return;
    const kinds: MarkerKind[] = ["hold", "town", "port", "ruin", "peak", "camp"];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const marker: Marker = {
      id: `m${Date.now().toString(36)}`,
      name: placeName(Math.random, kind),
      u,
      v,
      kind,
    };
    doc.markers = [...doc.markers, marker];
    sky?.setMarkers(doc.markers);
    queueSave();
    rebuildMarkerList();
    ctx.notify(`placed ${marker.name}`, "good");
  }

  let markerList: HTMLElement | null = null;

  function rebuildMarkerList(): void {
    if (!markerList || !doc) return;
    markerList.replaceChildren();
    if (!doc.markers.length) {
      markerList.append(el("div", "cg-dim", "double-click the ground to place one"));
      return;
    }
    for (const m of doc.markers) {
      const row = el("div", "cg-marker");
      const dot = el("span", `cg-dot is-${m.kind}`);
      const input = el("input", "cg-marker-name");
      input.type = "text";
      input.value = m.name;
      input.addEventListener("input", () => {
        m.name = input.value;
        queueSave();
      });
      input.addEventListener("change", () => {
        sky?.setMarkers(doc?.markers ?? []);
      });

      const go = button("\u2192", () => sky?.flyTo(m.u, m.v), "cg-btn is-tiny");
      const drop = button(
        "\u00d7",
        () => {
          if (!doc) return;
          doc.markers = doc.markers.filter((x) => x.id !== m.id);
          sky?.setMarkers(doc.markers);
          queueSave();
          rebuildMarkerList();
        },
        "cg-btn is-tiny is-quiet"
      );

      row.append(dot, input, go, drop);
      markerList.append(row);
    }
  }

  function buildPanel(panel: HTMLElement, mapDoc: MapDoc, field: Field): void {
    panel.replaceChildren();

    const stats = el("div", "cg-stats");
    stats.append(
      stat("relief", `${Math.round(field.peak * mapDoc.params.reliefM)} m`),
      stat("extent", `${mapDoc.params.extentKm} km`),
      stat("land", `${Math.round(field.landFraction * 100)}%`),
      stat("grid", `${field.size}\u00b2`)
    );
    panel.append(stats);

    if (sky) {
      panel.append(
        slider({
          label: "sun",
          min: 0,
          max: 1,
          step: 0.01,
          value: 0.34,
          format: (v) => (v < 0.2 ? "dawn" : v < 0.45 ? "morning" : v < 0.7 ? "afternoon" : "dusk"),
          onInput: (v) => sky?.setSun(v),
        }),
        slider({
          label: "exaggeration",
          min: 1,
          max: 20,
          step: 1,
          value: ctx.state.get<number>(K_RELIEF, DEFAULT_EXAGGERATION),
          format: (v) => `${v}\u00d7`,
          onInput: (v) => sky?.setExaggeration(v),
        })
      );

      const toggles = el("div", "cg-toggles");
      let atlas = false;
      let wire = false;
      let labels = ctx.state.get<boolean>(K_LABELS, true);
      const projectionBtn = button("top-down", () => {
        atlas = !atlas;
        sky?.setProjection(atlas ? "atlas" : "sky");
        projectionBtn.classList.toggle("is-on", atlas);
      });
      const wireBtn = button("wireframe", () => {
        wire = !wire;
        sky?.setWireframe(wire);
        wireBtn.classList.toggle("is-on", wire);
      });
      const labelBtn = button("labels", () => {
        labels = !labels;
        sky?.setLabelsVisible(labels);
        labelBtn.classList.toggle("is-on", labels);
      });
      labelBtn.classList.toggle("is-on", labels);
      toggles.append(projectionBtn, wireBtn, labelBtn, button("reset", () => sky?.resetView()));
      panel.append(toggles);
    }

    panel.append(el("div", "cg-panel-head", "places"));
    markerList = el("div", "cg-markers");
    panel.append(markerList);
    rebuildMarkerList();
  }

  function stat(label: string, value: string): HTMLElement {
    const wrap = el("div", "cg-stat");
    wrap.append(el("span", "cg-stat-label", label), el("span", "cg-stat-value", value));
    return wrap;
  }

  /* ---------------- open ---------------- */

  if (args.startInForge) {
    showForge();
  } else if (args.openPath) {
    try {
      openMap(args.openPath, parseDoc(ctx.fs.read(args.openPath)));
    } catch (err) {
      ctx.notify(`not a map: ${(err as Error).message}`, "warn");
      showLibrary();
    }
  } else {
    showLibrary();
  }

  return teardown;
}
