/**
 * voidshell's filesystem.
 *
 * A single tree of nodes, assembled from mounts. Two mounts ship today:
 *
 *   /home/void   writable, persisted to localStorage — your actual files
 *   /projects    read-only, materialised from the build-time disk scan
 *
 * Read-only-ness is enforced per-node rather than per-path prefix, so a mount
 * carries its own permissions wherever it is grafted in. Writes to /projects
 * fail the same way they would on a real read-only mount: with EROFS, not by
 * silently doing nothing.
 */

export type NodeKind = "file" | "dir";

export interface VNode {
  name: string;
  kind: NodeKind;
  /** Directory children, keyed by name. Undefined for files. */
  children?: Map<string, VNode>;
  /** File contents. Undefined when the content wasn't embedded. */
  content?: string;
  /** True size in bytes — may exceed content.length for non-embedded files. */
  size: number;
  /** Set when the file exists on disk but its content isn't available here. */
  omitted?: "binary" | "toolarge";
  readonly?: boolean;
  mtime: number;
  /** Free-form badge shown by the file manager, e.g. a project's language. */
  meta?: Record<string, string>;
}

export class FsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FsError";
  }
}

const enoent = (p: string) => new FsError("ENOENT", `no such file or directory: ${p}`);
const enotdir = (p: string) => new FsError("ENOTDIR", `not a directory: ${p}`);
const eisdir = (p: string) => new FsError("EISDIR", `is a directory: ${p}`);
const erofs = (p: string) => new FsError("EROFS", `read-only filesystem: ${p}`);
const eexist = (p: string) => new FsError("EEXIST", `already exists: ${p}`);

function dir(name: string, readonly = false): VNode {
  return { name, kind: "dir", children: new Map(), size: 0, readonly, mtime: Date.now() };
}

function file(name: string, content: string, readonly = false): VNode {
  return {
    name,
    kind: "file",
    content,
    size: content.length,
    readonly,
    mtime: Date.now(),
  };
}

/** Split a path into segments, resolving "." and "..". Always absolute. */
export function normalize(p: string, cwd = "/"): string {
  const raw = p.startsWith("/") ? p : `${cwd}/${p}`;
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

export function basename(p: string): string {
  const n = normalize(p);
  return n === "/" ? "/" : n.slice(n.lastIndexOf("/") + 1);
}

export function dirname(p: string): string {
  const n = normalize(p);
  if (n === "/") return "/";
  const i = n.lastIndexOf("/");
  return i === 0 ? "/" : n.slice(0, i);
}

export interface DirEntry {
  name: string;
  path: string;
  kind: NodeKind;
  size: number;
  readonly: boolean;
  omitted?: "binary" | "toolarge";
  meta?: Record<string, string>;
}

const STORAGE_KEY = "voidshell.fs.home";

export class VFS {
  private root = dir("/");
  /** Bumped on every mutation so UIs can cheaply tell they're stale. */
  private version = 0;
  private listeners = new Set<(version: number) => void>();

  constructor() {
    this.mkdirp("/home/void");
    this.mkdirp("/home/void/notes");
    this.mkdirp("/tmp");
  }

  // ---------- lookup ----------

  private lookup(p: string): VNode | null {
    const n = normalize(p);
    if (n === "/") return this.root;
    let cur = this.root;
    for (const seg of n.slice(1).split("/")) {
      if (cur.kind !== "dir" || !cur.children) return null;
      const next = cur.children.get(seg);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /** Throwing lookup — use when absence is an error. */
  private must(p: string): VNode {
    const n = this.lookup(p);
    if (!n) throw enoent(p);
    return n;
  }

  exists(p: string): boolean {
    return this.lookup(p) !== null;
  }

  stat(p: string): DirEntry {
    const n = this.must(p);
    return {
      name: n.name,
      path: normalize(p),
      kind: n.kind,
      size: n.size,
      readonly: !!n.readonly,
      omitted: n.omitted,
      meta: n.meta,
    };
  }

  isDir(p: string): boolean {
    return this.lookup(p)?.kind === "dir";
  }

  ls(p: string): DirEntry[] {
    const n = this.must(p);
    if (n.kind !== "dir" || !n.children) throw enotdir(p);
    const base = normalize(p);
    return [...n.children.values()]
      .map((c) => ({
        name: c.name,
        path: base === "/" ? `/${c.name}` : `${base}/${c.name}`,
        kind: c.kind,
        size: c.size,
        readonly: !!c.readonly,
        omitted: c.omitted,
        meta: c.meta,
      }))
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1
      );
  }

  read(p: string): string {
    const n = this.must(p);
    if (n.kind === "dir") throw eisdir(p);
    if (n.content === undefined) {
      throw new FsError(
        "ENODATA",
        n.omitted === "binary"
          ? `binary file, contents not available: ${p}`
          : `file too large to embed: ${p}`
      );
    }
    return n.content;
  }

  // ---------- mutation ----------

  private parentFor(p: string): VNode {
    const parent = this.must(dirname(p));
    if (parent.kind !== "dir" || !parent.children) throw enotdir(dirname(p));
    if (parent.readonly) throw erofs(p);
    return parent;
  }

  write(p: string, content: string): void {
    const n = normalize(p);
    const existing = this.lookup(n);
    if (existing) {
      if (existing.kind === "dir") throw eisdir(p);
      if (existing.readonly) throw erofs(p);
      existing.content = content;
      existing.size = content.length;
      existing.mtime = Date.now();
    } else {
      const parent = this.parentFor(n);
      parent.children!.set(basename(n), file(basename(n), content));
    }
    this.touched();
  }

  mkdir(p: string): void {
    const n = normalize(p);
    if (this.exists(n)) throw eexist(p);
    const parent = this.parentFor(n);
    parent.children!.set(basename(n), dir(basename(n)));
    this.touched();
  }

  /** mkdir -p. Silently succeeds when the path already exists. */
  mkdirp(p: string): void {
    const segs = normalize(p).slice(1).split("/").filter(Boolean);
    let cur = this.root;
    let path = "";
    for (const seg of segs) {
      path += `/${seg}`;
      let next = cur.children!.get(seg);
      if (!next) {
        if (cur.readonly) throw erofs(path);
        next = dir(seg);
        cur.children!.set(seg, next);
      }
      if (next.kind !== "dir") throw enotdir(path);
      cur = next;
    }
    this.touched();
  }

  rm(p: string, recursive = false): void {
    const n = normalize(p);
    if (n === "/") throw new FsError("EPERM", "refusing to remove /");
    const node = this.must(n);
    if (node.readonly) throw erofs(p);
    if (node.kind === "dir" && node.children!.size > 0 && !recursive) {
      throw new FsError("ENOTEMPTY", `directory not empty: ${p} (use -r)`);
    }
    const parent = this.parentFor(n);
    parent.children!.delete(basename(n));
    this.touched();
  }

  mv(from: string, to: string): void {
    const src = normalize(from);
    const node = this.must(src);
    if (node.readonly) throw erofs(from);
    let dest = normalize(to);
    // `mv a b/` and `mv a b` where b is a dir both mean "into b".
    if (this.isDir(dest)) dest = `${dest === "/" ? "" : dest}/${basename(src)}`;
    if (this.exists(dest)) throw eexist(to);
    const destParent = this.parentFor(dest);
    this.parentFor(src).children!.delete(basename(src));
    node.name = basename(dest);
    destParent.children!.set(node.name, node);
    this.touched();
  }

  // ---------- mounts ----------

  /**
   * Graft a prebuilt subtree at `at`. Used for /projects; the whole subtree is
   * marked read-only so the existing write guards reject mutations for free.
   */
  mount(at: string, node: VNode): void {
    const n = normalize(at);
    this.mkdirp(dirname(n));
    const parent = this.must(dirname(n));
    node.name = basename(n);
    parent.children!.set(node.name, node);
    this.touched();
  }

  // ---------- persistence ----------

  /** Serialise just the writable home tree. /projects comes from the build. */
  private serialize(node: VNode): unknown {
    if (node.kind === "file") return { n: node.name, k: "f", c: node.content ?? "" };
    return {
      n: node.name,
      k: "d",
      ch: [...node.children!.values()].map((c) => this.serialize(c)),
    };
  }

  private deserialize(raw: any): VNode {
    if (raw.k === "f") return file(raw.n, raw.c ?? "");
    const d = dir(raw.n);
    for (const c of raw.ch ?? []) d.children!.set(c.n, this.deserialize(c));
    return d;
  }

  save(): void {
    try {
      const home = this.lookup("/home/void");
      if (home) localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize(home)));
    } catch (err) {
      console.warn("[vfs] could not persist home:", err);
    }
  }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const home = this.deserialize(JSON.parse(raw));
      const parent = this.must("/home");
      home.name = "void";
      parent.children!.set("void", home);
      this.touched();
    } catch (err) {
      console.warn("[vfs] could not restore home:", err);
    }
  }

  // ---------- change notification ----------

  private touched(): void {
    this.version++;
    for (const l of this.listeners) l(this.version);
  }

  onChange(fn: (version: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getVersion(): number {
    return this.version;
  }

  /**
   * Node counts and byte totals for `df`. `bytes` is what is actually held in
   * memory; `indexed` is the real on-disk size including files whose contents
   * were never embedded. The two differ by a lot once binaries are indexed.
   */
  usage(): { files: number; dirs: number; bytes: number; indexed: number } {
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    let indexed = 0;
    const walk = (n: VNode) => {
      if (n.kind === "file") {
        files++;
        indexed += n.size;
        if (n.content !== undefined) bytes += n.content.length;
      } else {
        dirs++;
        for (const c of n.children!.values()) walk(c);
      }
    };
    walk(this.root);
    return { files, dirs: dirs - 1, bytes, indexed };
  }
}

/** Build the read-only /projects subtree from a build-time scan. */
export function buildProjectsTree(snapshot: {
  projects: { name: string; description: string; language: string; remote: string | null }[];
  entries: { path: string; type: "file" | "dir"; size: number; text?: string; omitted?: "binary" | "toolarge" }[];
}): VNode {
  const root = dir("projects", true);
  const byPath = new Map<string, VNode>([["", root]]);

  // Entries arrive parent-before-child from the scanner's walk order, so a
  // single pass suffices; missing parents are still created defensively.
  const ensureDir = (p: string): VNode => {
    if (byPath.has(p)) return byPath.get(p)!;
    const parent = ensureDir(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    const node = dir(p.slice(p.lastIndexOf("/") + 1), true);
    parent.children!.set(node.name, node);
    byPath.set(p, node);
    return node;
  };

  for (const e of snapshot.entries) {
    if (e.type === "dir") {
      ensureDir(e.path);
    } else {
      const parentPath = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
      const parent = ensureDir(parentPath);
      const name = e.path.slice(e.path.lastIndexOf("/") + 1);
      parent.children!.set(name, {
        name,
        kind: "file",
        content: e.text,
        size: e.size,
        omitted: e.omitted,
        readonly: true,
        mtime: Date.now(),
      });
    }
  }

  // Decorate each project's root dir with metadata the file manager displays.
  for (const p of snapshot.projects) {
    const node = root.children!.get(p.name);
    if (!node) continue;
    node.meta = {
      description: p.description,
      language: p.language,
      ...(p.remote ? { remote: p.remote } : {}),
    };
  }

  return root;
}
