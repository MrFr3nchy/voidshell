/**
 * The process table.
 *
 * Before this existed, voidshell had windows but no *processes*: launching an
 * app meant opening a surface, and closing the surface meant the app was simply
 * gone. Nothing could be listed, nothing could be killed, and the service
 * modules — aurora, horizon, shell — were completely invisible despite running
 * for the whole session. An OS is, more than anything else, a thing that keeps
 * track of what is running.
 *
 * The model is deliberately thin:
 *
 *   - Every module that activates gets a **daemon** process at boot, in
 *     registration order, so `ps` shows the background services that were
 *     always there.
 *   - Every app launch gets a **running** process which owns the surfaces
 *     opened during that launch, and exits when its last surface closes.
 *
 * That second rule is what makes the table honest rather than decorative:
 * process lifetime is derived from surface ownership, so it can't drift out of
 * sync with what's actually on screen.
 */

import type { LaunchArgs } from "./types";

export type ProcState = "running" | "daemon" | "exited";

export interface ProcInfo {
  pid: number;
  moduleId: string;
  name: string;
  kind: "app" | "world" | "service";
  state: ProcState;
  /** Epoch milliseconds, so the age can be rendered against a wall clock. */
  started: number;
  /** Surface ids this process owns. Empty for daemons. */
  surfaces: string[];
  /** The argv equivalent — what the process was launched with. */
  args?: LaunchArgs;
}

/**
 * pid 1 is reserved for the kernel itself, the way init is. It never appears
 * from a module launch, so `kill 1` has something meaningful to refuse.
 */
export const KERNEL_PID = 1;

export class ProcTable {
  private procs = new Map<number, ProcInfo>();
  private nextPid = KERNEL_PID;

  /** Register the kernel's own entry. Called once, at the top of boot. */
  initKernel(): ProcInfo {
    return this.add({
      moduleId: "kernel",
      name: "voidshell",
      kind: "service",
      state: "daemon",
    });
  }

  private add(p: Omit<ProcInfo, "pid" | "started" | "surfaces">): ProcInfo {
    const proc: ProcInfo = {
      ...p,
      pid: this.nextPid++,
      started: Date.now(),
      surfaces: [],
    };
    this.procs.set(proc.pid, proc);
    return proc;
  }

  /** A long-lived background module. Spawned at activate, never exits. */
  spawnDaemon(moduleId: string, name: string, kind: "world" | "service"): ProcInfo {
    return this.add({ moduleId, name, kind, state: "daemon" });
  }

  /** A launched app instance. Lives as long as it owns at least one surface. */
  spawnApp(moduleId: string, name: string, args?: LaunchArgs): ProcInfo {
    return this.add({ moduleId, name, kind: "app", state: "running", args });
  }

  get(pid: number): ProcInfo | undefined {
    return this.procs.get(pid);
  }

  /** Every live process, lowest pid first — the order `ps` is expected in. */
  list(): ProcInfo[] {
    return [...this.procs.values()].sort((a, b) => a.pid - b.pid);
  }

  /** The process owning a given surface, if any. */
  ownerOf(surfaceId: string): ProcInfo | undefined {
    return this.list().find((p) => p.surfaces.includes(surfaceId));
  }

  attachSurface(pid: number, surfaceId: string): void {
    this.procs.get(pid)?.surfaces.push(surfaceId);
  }

  /**
   * Release a surface from whatever owns it, and report the process if that was
   * its last one — the caller decides what "the last window closed" means.
   */
  detachSurface(surfaceId: string): ProcInfo | null {
    const proc = this.ownerOf(surfaceId);
    if (!proc) return null;
    proc.surfaces = proc.surfaces.filter((s) => s !== surfaceId);
    return proc.surfaces.length === 0 ? proc : null;
  }

  /** Remove a process from the table. Daemons are never reaped. */
  reap(pid: number): void {
    const proc = this.procs.get(pid);
    if (!proc || proc.state === "daemon") return;
    this.procs.delete(pid);
  }

  /** Wall-clock age of a process, formatted the way `ps` shows ELAPSED. */
  static elapsed(proc: ProcInfo, now = Date.now()): string {
    const secs = Math.max(0, Math.floor((now - proc.started) / 1000));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
}
