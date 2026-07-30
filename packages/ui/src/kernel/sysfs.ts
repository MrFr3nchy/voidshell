/**
 * The system, as files.
 *
 * voidshell already decided that the desktop is a directory. This is the same
 * bet taken all the way: processes, devices, configuration and the log are all
 * reachable with `cat`. Nothing here invents an API — every one of these is an
 * ordinary VNode with a `gen` or a `sink`, which means the shell's existing
 * tools operate on them for free:
 *
 *     cat /proc/uptime              live, recomputed on every read
 *     ls /proc                      one directory per running process
 *     cat /proc/12/status           what process 12 actually is
 *     tail -n 20 /var/log/system.log | grep warn
 *     noisy-command > /dev/null     a real sink, not a special case in the shell
 *     echo notes >> /etc/autostart   edits what launches at boot
 *
 * That last one is the payoff for making sinks writable inside a read-only
 * mount: /etc is generated from the settings store *and writes back to it*, so
 * configuring the system by editing a config file is not a simulation of the
 * idea, it's the actual mechanism.
 */

import type { VNode } from "./vfs";
import type { Journal } from "./journal";
import { ProcTable } from "./procs";
import type { CompositorStats, ModuleManifest } from "./types";

/** Everything sysfs needs to describe the running system. */
export interface SysfsHooks {
  journal: Journal;
  procs: ProcTable;
  registry(): ModuleManifest[];
  usage(): { files: number; dirs: number; bytes: number; indexed: number };
  stats(): CompositorStats;
  store: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
  };
  notify(text: string): void;
  compositorName: string;
}

export const HOSTNAME_KEY = "system.hostname";
export const USER_KEY = "system.user";
export const MOTD_KEY = "system.motd";
export const AUTOSTART_KEY = "system.autostart";

export const DEFAULT_HOSTNAME = "void";
export const DEFAULT_USER = "void";
export const DEFAULT_MOTD =
  "the void is listening. type `help`, or `ls /proc` to see what's running.";

const VERSION = "0.2.0";

/* ------------------------------------------------------------------ */
/* node builders                                                       */
/* ------------------------------------------------------------------ */

/** A read-only file whose bytes are produced on demand. */
function genFile(name: string, gen: () => string): VNode {
  return {
    name,
    kind: "file",
    size: 0,
    readonly: true,
    synthetic: true,
    mtime: Date.now(),
    gen,
  };
}

/** A file that can also be written, with the write routed somewhere useful. */
function rwFile(name: string, gen: () => string, sink: (data: string) => void): VNode {
  const node = genFile(name, gen);
  node.sink = sink;
  node.readonly = false;
  return node;
}

/** A directory whose children are fixed at mount time. */
function synDir(name: string, entries: VNode[]): VNode {
  return {
    name,
    kind: "dir",
    size: 0,
    readonly: true,
    synthetic: true,
    mtime: Date.now(),
    children: new Map(entries.map((e) => [e.name, e])),
  };
}

/** A directory whose children are recomputed every time it's traversed. */
function liveDir(name: string, gen: () => VNode[]): VNode {
  return {
    name,
    kind: "dir",
    size: 0,
    readonly: true,
    synthetic: true,
    mtime: Date.now(),
    genDir: () => new Map(gen().map((e) => [e.name, e])),
  };
}

/* ------------------------------------------------------------------ */
/* /proc                                                               */
/* ------------------------------------------------------------------ */

export function buildProc(h: SysfsHooks): VNode {
  /** One directory per live process, exactly as Linux does it. */
  const processDirs = (): VNode[] =>
    h.procs.list().map((p) =>
      synDir(String(p.pid), [
        genFile("status", () =>
          [
            `Name:      ${p.name}`,
            `Pid:       ${p.pid}`,
            `Module:    ${p.moduleId}`,
            `Kind:      ${p.kind}`,
            `State:     ${p.state}`,
            `Started:   ${new Date(p.started).toISOString()}`,
            `Elapsed:   ${ProcTable.elapsed(p)}`,
            `Surfaces:  ${p.surfaces.length ? p.surfaces.join(" ") : "-"}`,
          ].join("\n")
        ),
        // argv, near enough: what the process was launched with.
        genFile("cmdline", () =>
          [p.moduleId, ...Object.entries(p.args ?? {}).map(([k, v]) => `--${k}=${v}`)].join(
            " "
          )
        ),
      ])
    );

  const fixed = [
    genFile("uptime", () => {
      const up = h.journal.uptime() / 1000;
      // Two floats, like the real thing: seconds up, seconds idle. "Idle" here
      // is the share of time the compositor wasn't drawing a full 60fps.
      const fps = Math.max(1, h.stats().fps);
      const idle = up * Math.max(0, 1 - fps / 60);
      return `${up.toFixed(2)} ${idle.toFixed(2)}\n`;
    }),

    genFile(
      "version",
      () =>
        `voidshell ${VERSION} (compositor: ${h.compositorName}) ` +
        `${navigator.userAgent.includes("Firefox") ? "gecko" : "blink"}\n`
    ),

    genFile("meminfo", () => {
      const u = h.usage();
      // performance.memory is Chromium-only and non-standard, so it's reported
      // when present and silently skipped everywhere else.
      const mem = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
        .memory;
      const kb = (n: number) => `${Math.round(n / 1024)} kB`;
      return [
        `FsFiles:      ${u.files}`,
        `FsDirs:       ${u.dirs}`,
        `FsResident:   ${kb(u.bytes)}`,
        `FsIndexed:    ${kb(u.indexed)}`,
        ...(mem
          ? [`HeapUsed:     ${kb(mem.usedJSHeapSize)}`, `HeapLimit:    ${kb(mem.jsHeapSizeLimit)}`]
          : ["HeapUsed:     (not reported by this browser)"]),
      ].join("\n");
    }),

    genFile("loadavg", () => {
      const s = h.stats();
      // There is no run queue to average, so load is expressed as the frame
      // budget actually being spent: 1.00 means the compositor is saturated.
      const load = (Math.max(0, 60 - s.fps) / 60).toFixed(2);
      const procs = h.procs.list();
      const running = procs.filter((p) => p.state === "running").length;
      const lastPid = procs.length ? procs[procs.length - 1].pid : 1;
      return `${load} ${load} ${load} ${running}/${procs.length} ${lastPid}\n`;
    }),

    genFile("modules", () =>
      h
        .registry()
        .map((m) => {
          const proc = h.procs.list().find((p) => p.moduleId === m.id);
          return `${m.id.padEnd(14)} ${m.kind.padEnd(8)} ${
            proc ? `pid ${proc.pid}` : "not running"
          }`;
        })
        .join("\n")
    ),

    genFile("cpuinfo", () => {
      const s = h.stats();
      return [
        `renderer   : ${h.compositorName}`,
        `fps        : ${s.fps}`,
        `panels     : ${s.panels}`,
        `bodies     : ${s.bodies}`,
        `groups     : ${s.groups}`,
        `cores      : ${navigator.hardwareConcurrency ?? "unknown"}`,
      ].join("\n");
    }),
  ];

  return liveDir("proc", () => [...fixed, ...processDirs()]);
}

/* ------------------------------------------------------------------ */
/* /dev                                                                */
/* ------------------------------------------------------------------ */

export function buildDev(h: SysfsHooks): VNode {
  return synDir("dev", [
    // The bit bucket. `command > /dev/null` needed no shell support at all —
    // redirection already writes to a path, and this path throws it away.
    rwFile("null", () => "", () => {}),
    genFile("zero", () => "\0".repeat(512)),
    genFile("random", () =>
      Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, "0")
      ).join("")
    ),
    // Writing to the console raises a notice, so any program that can write a
    // file can talk to the user.
    rwFile("console", () => "", (data) => {
      const text = data.trim();
      if (text) h.notify(text);
    }),
  ]);
}

/* ------------------------------------------------------------------ */
/* /etc                                                                */
/* ------------------------------------------------------------------ */

export function buildEtc(h: SysfsHooks): VNode {
  const line = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);

  return synDir("etc", [
    rwFile(
      "hostname",
      () => line(h.store.get(HOSTNAME_KEY, DEFAULT_HOSTNAME)),
      (d) => h.store.set(HOSTNAME_KEY, d.trim() || DEFAULT_HOSTNAME)
    ),

    rwFile(
      "motd",
      () => line(h.store.get(MOTD_KEY, DEFAULT_MOTD)),
      (d) => h.store.set(MOTD_KEY, d.trim())
    ),

    /**
     * What launches at boot. Backed by the store, so editing this file with
     * the editor, `echo >>`, or the Settings app are three routes to the same
     * state rather than three implementations of it.
     */
    rwFile(
      "autostart",
      () => {
        const ids = h.store.get<string[]>(AUTOSTART_KEY, []);
        return [
          "# one module id per line — launched at boot, in order.",
          "# lines starting with # are ignored.",
          ...ids,
          "",
        ].join("\n");
      },
      (d) => {
        const known = new Set(h.registry().map((m) => m.id));
        const ids = d
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .filter((l) => known.has(l));
        h.store.set(AUTOSTART_KEY, ids);
      }
    ),

    genFile("passwd", () => {
      const user = h.store.get(USER_KEY, DEFAULT_USER);
      return `${user}:x:1000:1000:${user}:/home/void:/bin/vsh\n`;
    }),
  ]);
}

/* ------------------------------------------------------------------ */
/* /var/log                                                            */
/* ------------------------------------------------------------------ */

export function buildVarLog(h: SysfsHooks): VNode {
  return synDir("log", [
    genFile("system.log", () => h.journal.format()),
    genFile("boot.log", () =>
      h.journal
        .read()
        // Everything up to the point the shell finished wiring itself up.
        .filter((e) => e.tag === "kernel" || e.tag === "boot")
        .map((e) => `[${(e.t / 1000).toFixed(3).padStart(8)}] ${e.msg}`)
        .join("\n")
    ),
  ]);
}
