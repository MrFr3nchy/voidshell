/**
 * What a file *is*, in one place.
 *
 * There used to be three answers to "what does a .py file look like": a glyph
 * table in the desktop, a two-character `▸ / ·` in the file list, and nothing
 * at all anywhere else. Three tables meant a new file type had to be added
 * three times, and in practice never was — the file manager has been drawing
 * every file as a dot since it was written.
 *
 * This is deliberately *not* the association table. Which app opens a .md is a
 * question about installed modules and belongs to the kernel; what a .md is
 * called and what it looks like is a fact about the file and belongs here.
 */

export interface FileType {
  /** Stable id, also the key a "new file" template is chosen by. */
  id: string;
  label: string;
  glyph: string;
  /** Broad family, used for colour and for grouping the New menu. */
  family: "doc" | "code" | "data" | "config" | "web" | "shell" | "binary" | "other";
}

const DIR: FileType = { id: "dir", label: "Folder", glyph: "▸", family: "other" };

const UNKNOWN: FileType = { id: "file", label: "File", glyph: "·", family: "other" };

/**
 * Every type the shell knows by name. Extensions are lowercase and dotless.
 *
 * Ordered roughly by how often you'll meet one. Anything absent still gets a
 * sane row — an unknown extension is a file, not an error.
 */
const TYPES: (FileType & { ext: string[] })[] = [
  { id: "md", label: "Markdown", glyph: "❡", family: "doc", ext: ["md", "markdown", "mdx"] },
  { id: "txt", label: "Plain text", glyph: "≡", family: "doc", ext: ["txt", "text", "log"] },
  { id: "json", label: "JSON", glyph: "{}", family: "data", ext: ["json", "jsonc", "json5"] },
  { id: "ts", label: "TypeScript", glyph: "TS", family: "code", ext: ["ts", "tsx", "mts", "cts"] },
  { id: "js", label: "JavaScript", glyph: "JS", family: "code", ext: ["js", "jsx", "mjs", "cjs"] },
  { id: "py", label: "Python", glyph: "PY", family: "code", ext: ["py", "pyi"] },
  { id: "rs", label: "Rust", glyph: "RS", family: "code", ext: ["rs"] },
  { id: "go", label: "Go", glyph: "GO", family: "code", ext: ["go"] },
  { id: "c", label: "C / C++", glyph: "C", family: "code", ext: ["c", "h", "cc", "cpp", "hpp"] },
  { id: "css", label: "Stylesheet", glyph: "#", family: "web", ext: ["css", "scss", "sass", "less"] },
  { id: "html", label: "HTML", glyph: "<>", family: "web", ext: ["html", "htm", "svg", "xml"] },
  { id: "sh", label: "Shell script", glyph: "$", family: "shell", ext: ["sh", "bash", "zsh", "fish"] },
  { id: "yaml", label: "YAML", glyph: "⚙", family: "config", ext: ["yml", "yaml"] },
  { id: "toml", label: "TOML", glyph: "⚙", family: "config", ext: ["toml", "ini", "conf", "cfg"] },
  { id: "env", label: "Environment", glyph: "⚙", family: "config", ext: ["env"] },
  { id: "csv", label: "Table", glyph: "▦", family: "data", ext: ["csv", "tsv"] },
  { id: "sql", label: "SQL", glyph: "▤", family: "data", ext: ["sql"] },
  { id: "gd", label: "GDScript", glyph: "GD", family: "code", ext: ["gd"] },
  { id: "qml", label: "QML", glyph: "QM", family: "code", ext: ["qml"] },
  {
    id: "image",
    label: "Image",
    glyph: "▨",
    family: "binary",
    ext: ["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp"],
  },
  { id: "audio", label: "Audio", glyph: "♪", family: "binary", ext: ["mp3", "wav", "ogg", "flac", "m4a"] },
  { id: "video", label: "Video", glyph: "▷", family: "binary", ext: ["mp4", "webm", "mov", "mkv"] },
  { id: "font", label: "Font", glyph: "A", family: "binary", ext: ["ttf", "otf", "woff", "woff2"] },
  { id: "archive", label: "Archive", glyph: "▣", family: "binary", ext: ["zip", "tar", "gz", "xz", "7z"] },
  { id: "pdf", label: "Document", glyph: "▥", family: "binary", ext: ["pdf"] },
];

const BY_EXT = new Map<string, FileType>();
for (const t of TYPES) {
  const { ext, ...type } = t;
  for (const e of ext) BY_EXT.set(e, type);
}

/** The extension of a path, lowercase and without the dot. "" when there is none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file, not an extension: ".bashrc" has none.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** What kind of thing this path is. Directories answer `dir`. */
export function fileTypeFor(path: string, kind: "file" | "dir" = "file"): FileType {
  if (kind === "dir") return DIR;
  return BY_EXT.get(extensionOf(path)) ?? UNKNOWN;
}

/** Whether the shell can meaningfully show this file's bytes as text. */
export function isTextual(path: string): boolean {
  return fileTypeFor(path).family !== "binary";
}

/**
 * What "New…" can make.
 *
 * A file manager whose only offer is `untitled.md` teaches you to create the
 * wrong thing and rename it. Each template is a starting name and starting
 * bytes — nothing more, because anything more would be a scaffolding tool.
 */
export interface Template {
  id: string;
  label: string;
  name: string;
  body: string;
}

export const TEMPLATES: Template[] = [
  { id: "md", label: "Markdown", name: "untitled.md", body: "# untitled\n\n" },
  { id: "txt", label: "Text", name: "untitled.txt", body: "" },
  { id: "json", label: "JSON", name: "untitled.json", body: "{\n  \n}\n" },
  {
    id: "py",
    label: "Python",
    name: "untitled.py",
    body: 'def main():\n    print("hello from the void")\n\n\nmain()\n',
  },
  {
    id: "js",
    label: "JavaScript",
    name: "untitled.js",
    body: 'console.log("hello from the void");\n',
  },
  { id: "sh", label: "Shell script", name: "untitled.sh", body: "#!/bin/sh\n\n" },
];
