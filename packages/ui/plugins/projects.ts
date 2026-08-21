import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Plugin } from "vite";
import { readRoot, type RootHandle, type RootOption } from "./projectsRoot";

/**
 * Mounts the author's real project directory into voidshell's filesystem.
 *
 * Two modes, one API. In dev this serves a live scan over HTTP, so editing a
 * file on disk shows up in the shell on reload. For a production build the
 * same scan is frozen into the bundle, because the deployed site is static and
 * has no disk to read.
 *
 * Text files are embedded whole (under a size cap); binaries are indexed by
 * name and size only, which is what keeps a 27MB asset folder from becoming a
 * 27MB download.
 */

const VIRTUAL_ID = "virtual:voidshell-projects";
const RESOLVED_ID = "\0" + VIRTUAL_ID;
const DEV_ENDPOINT = "/__vs/projects.json";
export const ROOT_ENDPOINT = "/__vs/projects/root";

/** Directories that are build output, dependencies, or VCS noise. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "target", ".cache",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", "coverage",
  ".godot", ".import", ".turbo", ".svelte-kit", "vendor",
]);

/** Lockfiles: enormous, generated, and nobody wants to read them in a shell. */
const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
  "poetry.lock", "composer.lock", ".DS_Store",
]);

/**
 * Binary extensions. The list is a denylist rather than a text allowlist
 * because source trees are full of unguessable text files — .firebaserc,
 * .gql, .prettierrc — and misclassifying those makes them unreadable in the
 * shell. Anything not listed here is attempted as UTF-8; the NUL-byte check
 * at read time catches whatever slips through.
 */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".tiff", ".psd",
  ".ico", ".icns", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".mp4", ".webm", ".mov", ".avi",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm", ".o", ".a", ".class",
  ".pyc", ".pyo", ".rlib", ".node", ".db", ".sqlite", ".sqlite3",
  ".blend", ".fbx", ".obj", ".glb", ".gltf", ".import", ".ctex", ".res",
]);

const MAX_TEXT_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024; // hard ceiling on embedded text

export interface ProjectEntry {
  /** Path relative to the mount root, e.g. "pawnageddon/src/main.rs". */
  path: string;
  type: "file" | "dir";
  size: number;
  /** Present only for text files that fit under the cap. */
  text?: string;
  /** Why the content is absent: binary blob, or too big to embed. */
  omitted?: "binary" | "toolarge";
}

export interface ProjectMeta {
  name: string;
  description: string;
  language: string;
  remote: string | null;
}

export interface ProjectsSnapshot {
  generatedAt: string;
  root: string;
  projects: ProjectMeta[];
  entries: ProjectEntry[];
  /** Total bytes of embedded text, for the shell's `df`. */
  embeddedBytes: number;
}

function isTextFile(name: string): boolean {
  return !BINARY_EXT.has(path.extname(name).toLowerCase());
}

/** Cheap language guess from the files a project actually contains. */
function detectLanguage(dir: string): string {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has("Cargo.toml")) return "Rust";
  if (has("project.godot")) return "Godot";
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return "Next.js";
      if (deps.three) return "TypeScript · WebGL";
      if (deps.react) return "React";
      return "JavaScript";
    } catch {
      return "JavaScript";
    }
  }
  if (has("requirements.txt") || has("pyproject.toml")) return "Python";
  if (fs.existsSync(path.join(dir, "package", "metadata.json"))) return "KDE Plasma · QML";
  try {
    if (fs.readdirSync(dir).some((f) => f.endsWith(".py"))) return "Python";
  } catch { /* unreadable dir — fall through */ }
  return "—";
}

/** First meaningful prose line of a README, used as the project blurb. */
function readDescription(dir: string): string {
  for (const name of ["README.md", "README.txt", "README"]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const lines = fs.readFileSync(p, "utf8").split("\n");
      for (const raw of lines) {
        const l = raw.trim();
        if (!l || l.startsWith("#") || l.startsWith("![") || l.startsWith(">")) continue;
        return l.replace(/\*\*/g, "").replace(/\[(.+?)\]\(.+?\)/g, "$1").slice(0, 200);
      }
    } catch { /* unreadable README — no blurb */ }
  }
  return "";
}

function gitRemote(dir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url.replace(/\.git$/, "") || null;
  } catch {
    return null;
  }
}

export function scanProjects(root: string, selfName: string): ProjectsSnapshot {
  const entries: ProjectEntry[] = [];
  const projects: ProjectMeta[] = [];
  let embeddedBytes = 0;

  let topLevel: string[];
  try {
    topLevel = fs.readdirSync(root);
  } catch {
    return { generatedAt: new Date().toISOString(), root, projects, entries, embeddedBytes: 0 };
  }

  const walk = (abs: string, rel: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;

      let st: fs.Stats;
      try {
        st = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never follow: cycles and escapes

      if (st.isDirectory()) {
        entries.push({ path: childRel, type: "dir", size: 0 });
        walk(childAbs, childRel);
      } else if (st.isFile()) {
        const entry: ProjectEntry = { path: childRel, type: "file", size: st.size };
        if (!isTextFile(name)) {
          entry.omitted = "binary";
        } else if (st.size > MAX_TEXT_BYTES || embeddedBytes > MAX_TOTAL_BYTES) {
          entry.omitted = "toolarge";
        } else {
          try {
            const text = fs.readFileSync(childAbs, "utf8");
            // A NUL byte means it was binary despite the extension.
            if (text.includes("\u0000")) entry.omitted = "binary";
            else {
              entry.text = text;
              embeddedBytes += st.size;
            }
          } catch {
            entry.omitted = "binary";
          }
        }
        entries.push(entry);
      }
    }
  };

  for (const name of topLevel.sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const abs = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    projects.push({
      name,
      description:
        name === selfName
          ? "The shell you are currently inside."
          : readDescription(abs),
      language: detectLanguage(abs),
      remote: gitRemote(abs),
    });
    entries.push({ path: name, type: "dir", size: 0 });
    walk(abs, name);
  }

  return {
    generatedAt: new Date().toISOString(),
    root,
    projects,
    entries,
    embeddedBytes,
  };
}

export interface ProjectsPluginOptions {
  /**
   * Directory to mount. A plain string pins it; a `RootHandle` lets it be
   * repointed while the dev server runs. Omitted, it falls back to the old
   * behaviour so the plugin is still usable on its own.
   */
  root?: RootOption;
}

export function voidshellProjects(opts: ProjectsPluginOptions = {}): Plugin {
  let fallbackRoot = "";
  let selfName = "";
  let isBuild = false;
  const scanRoot = () => readRoot(opts.root, fallbackRoot);
  /** Present only when the caller passed a handle, i.e. only in dev. */
  const handle = (): RootHandle | null =>
    opts.root && typeof opts.root !== "string" ? opts.root : null;

  return {
    name: "voidshell-projects",

    configResolved(config) {
      isBuild = config.command === "build";
      fallbackRoot = path.resolve(config.root, "..");
      selfName = path.basename(config.root);
    },

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },

    load(id) {
      if (id !== RESOLVED_ID) return null;

      if (isBuild) {
        // Freeze the scan into the bundle — the deployed site has no disk.
        const root = scanRoot();
        const snap = scanProjects(root, selfName);
        const kb = (snap.embeddedBytes / 1024).toFixed(0);
        // A build that quietly ships an empty /projects is the failure this
        // whole file exists to make visible, so say so rather than reporting
        // "0 projects" as though it were a result.
        if (!snap.projects.length) {
          this.warn?.(
            `no projects found under ${root} — /projects will be empty. ` +
              `Set VOIDSHELL_PROJECTS_ROOT or projectsRoot in voidshell.local.json.`
          );
        }
        this.info?.(
          `mounted ${snap.projects.length} projects from ${root}, ` +
            `${snap.entries.length} entries, ${kb}KB text`
        );
        /**
         * Emitted as a JSON asset, not inlined into the bundle.
         *
         * It used to be a `const snapshot = {...}` in this module, which put
         * the entire scanned source tree in the entry chunk: 3.5MB raw and
         * ~970KB gzipped, roughly four times the size of the shell itself, all
         * of it on the critical path before a single pixel is drawn. Nothing
         * needs it until a window asks for a file in /projects.
         *
         * A separate *asset* rather than a dynamic import chunk, for two
         * reasons. JSON.parse is substantially faster than the engine parsing
         * an equivalent object literal, and a file whose contents change on
         * every scan should not share a cache entry with a bundle that mostly
         * does not.
         *
         * `ROLLUP_FILE_URL_` resolves against the configured `base`, which is
         * what keeps this working on a project page served from a
         * subdirectory rather than 404ing next to a bundle that loaded fine.
         */
        const ref = this.emitFile({
          type: "asset",
          name: "projects.json",
          source: JSON.stringify(snap),
        });
        return `const url = import.meta.ROLLUP_FILE_URL_${ref};
const EMPTY = { generatedAt: "", root: "", projects: [], entries: [], embeddedBytes: 0 };
export function loadProjects() {
  return fetch(url)
    .then((r) => { if (!r.ok) throw new Error("projects scan failed: " + r.status); return r.json(); })
    .catch((err) => {
      // Never fatal. A shell without /projects is a shell; a shell that
      // refuses to boot because a side mount is missing is a bug.
      console.warn("[voidshell] /projects unavailable:", err);
      return EMPTY;
    });
}`;
      }

      // Dev: fetch live so disk edits appear on reload.
      return `export function loadProjects() {
  return fetch(${JSON.stringify(DEV_ENDPOINT)})
    .then((r) => { if (!r.ok) throw new Error("projects scan failed: " + r.status); return r.json(); })
    .catch((err) => {
      console.warn("[voidshell] /projects unavailable:", err);
      return { generatedAt: "", root: "", projects: [], entries: [], embeddedBytes: 0 };
    });
}`;
    },

    configureServer(server) {
      server.middlewares.use(DEV_ENDPOINT, (_req, res) => {
        try {
          const snap = scanProjects(scanRoot(), selfName);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(snap));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      /**
       * Read and repoint the mount, without restarting Vite.
       *
       * Dev only, by the same construction as the host bridge:
       * `configureServer` never runs for a production build, so a deployed
       * voidshell has no way to reach this and the Settings control it backs
       * degrades to showing the frozen root the bundle was built with.
       */
      server.middlewares.use(ROOT_ENDPOINT, (req, res) => {
        const h = handle();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");

        const report = (info: ReturnType<RootHandle["info"]>) => {
          // Count projects rather than just echoing the path: "that directory
          // exists" and "that directory has anything in it" are different
          // answers, and only the second one is the question being asked.
          let projects = 0;
          try {
            projects = scanProjects(info.root, selfName).projects.length;
          } catch {
            /* unreadable — reported as zero, alongside exists:false */
          }
          res.end(JSON.stringify({ ...info, projects, settable: true }));
        };

        if (!h) {
          res.statusCode = 501;
          res.end(JSON.stringify({ error: "no root handle", settable: false }));
          return;
        }

        if (req.method === "GET") return report(h.info());

        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "GET or POST" }));
          return;
        }

        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          let next = "";
          try {
            next = String((JSON.parse(raw || "{}") as { root?: unknown }).root ?? "");
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "body is not valid JSON" }));
            return;
          }
          try {
            report(h.set(next));
          } catch (err) {
            // A refused path leaves the old root in place, so a typo costs a
            // message rather than the mount.
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String((err as Error).message) }));
          }
        });
      });
    },
  };
}
