import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Plugin } from "vite";

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
  /** Directory to mount. Defaults to the parent of the vite root. */
  root?: string;
}

export function voidshellProjects(opts: ProjectsPluginOptions = {}): Plugin {
  let scanRoot = "";
  let selfName = "";
  let isBuild = false;

  return {
    name: "voidshell-projects",

    configResolved(config) {
      isBuild = config.command === "build";
      scanRoot = opts.root ?? path.resolve(config.root, "..");
      selfName = path.basename(config.root);
    },

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },

    load(id) {
      if (id !== RESOLVED_ID) return null;

      if (isBuild) {
        // Freeze the scan into the bundle — the deployed site has no disk.
        const snap = scanProjects(scanRoot, selfName);
        const kb = (snap.embeddedBytes / 1024).toFixed(0);
        this.info?.(
          `mounted ${snap.projects.length} projects, ${snap.entries.length} entries, ${kb}KB text`
        );
        return `const snapshot = ${JSON.stringify(snap)};
export function loadProjects() { return Promise.resolve(snapshot); }`;
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
          const snap = scanProjects(scanRoot, selfName);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(snap));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}
