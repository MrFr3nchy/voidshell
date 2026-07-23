/// <reference types="vite/client" />

/**
 * Supplied by the voidshell-projects Vite plugin. Resolves to a live fetch in
 * dev and to a frozen snapshot in a production build — same signature either
 * way, so the app never branches on mode.
 */
declare module "virtual:voidshell-projects" {
  export interface ProjectEntry {
    path: string;
    type: "file" | "dir";
    size: number;
    text?: string;
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
    embeddedBytes: number;
  }
  export function loadProjects(): Promise<ProjectsSnapshot>;
}
