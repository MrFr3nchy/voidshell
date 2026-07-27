import raw from "./catalog.json";

/**
 * The catalogue of external projects mounted into voidshell as apps.
 *
 * These are not modules written for the shell — they are separate repositories
 * that compile to static web output. CI builds each one into
 * `public/apps/<id>/`, Vite copies that verbatim into `dist/`, and the shell
 * frames it. Nothing here executes at runtime on a server, which is the whole
 * reason it survives a static deploy.
 *
 * The JSON is the single source of truth: the shell reads it to register
 * modules, and `.github/workflows/build-apps.yml` reads the same file to decide
 * what to build. Adding a project means editing one file.
 */

/**
 * How a project turns into a directory of static files.
 *
 * - `vite`  — an npm project whose `build` script emits `dist/`. Built with
 *             `--base` set, because a bundle that assumes it lives at the
 *             origin root emits absolute asset URLs that 404 under /apps/<id>/.
 * - `godot` — a Godot project exported to Web. Requires the Compatibility
 *             renderer and cross-origin isolation; see APPS.md.
 */
export type AppBuilder = "vite" | "godot";

export interface ProjectAppDef {
  /** Module id, URL segment, and build output directory name. */
  id: string;
  name: string;
  /** Single glyph for the radial launcher. */
  glyph: string;
  blurb: string;
  /** owner/repo, used by CI to check the source out. */
  repo: string;
  builder: AppBuilder;
  /** Godot only: which engine version CI should download. */
  godotVersion?: string;
  width: number;
  height: number;
}

const BUILDERS = new Set<string>(["vite", "godot"]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Validated at load rather than trusted.
 *
 * `resolveJsonModule` types the import structurally, which says nothing about
 * whether `builder` is a builder the pipeline actually implements. A typo there
 * would otherwise register a module whose artifact no CI job ever produces —
 * an app that exists in the launcher and 404s forever. Dropping the entry and
 * warning is the honest failure.
 */
function parse(entries: unknown): ProjectAppDef[] {
  if (!Array.isArray(entries)) return [];
  const out: ProjectAppDef[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const id = str(e.id);
    const builder = str(e.builder);
    if (!id || !BUILDERS.has(builder)) {
      console.warn("[voidshell] skipping malformed app catalogue entry:", e.id ?? e);
      continue;
    }

    const def: ProjectAppDef = {
      id,
      name: str(e.name) || id,
      glyph: str(e.glyph) || "\u25a3",
      blurb: str(e.blurb),
      repo: str(e.repo),
      builder: builder as AppBuilder,
      width: num(e.width, 960),
      height: num(e.height, 640),
    };
    const godotVersion = str(e.godotVersion);
    if (godotVersion) def.godotVersion = godotVersion;

    out.push(def);
  }

  return out;
}

export const PROJECT_APPS: ProjectAppDef[] = parse(
  (raw as { apps?: unknown }).apps
);
