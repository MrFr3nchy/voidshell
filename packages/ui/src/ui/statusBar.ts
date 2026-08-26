import type {
  KernelContext,
  KernelEvent,
  NotifyKind,
  LogEntry,
  StationKind,
} from "../kernel/types";
import { DEFAULT_HOSTNAME, DEFAULT_USER, HOSTNAME_KEY, USER_KEY } from "../kernel/sysfs";

const STATION_KINDS: { kind: StationKind; glyph: string; title: string }[] = [
  { kind: "rock", glyph: "◉", title: "found a rocky outpost" },
  { kind: "giant", glyph: "◕", title: "found a gas giant" },
  { kind: "ring", glyph: "⦸", title: "found a ring waystation" },
];

/**
 * The status bar.
 *
 * voidshell deliberately has no taskbar — you summon apps from the ring rather
 * than picking them off a strip. But "no taskbar" had quietly become "no
 * persistent chrome at all", and that is most of why the place didn't read as
 * an OS: there was no clock, nothing said who you were, and there was no
 * evidence that anything was running when every window was closed.
 *
 * This is the smallest thing that fixes that. It lists no windows and launches
 * nothing directly, so it isn't a taskbar by the back door — it reports who,
 * when, how long, and how much, which is what a status bar is for.
 *
 * The bell is the other half: toasts vanish after 2.6 seconds, so until now a
 * notice you glanced away from was gone for good. The journal already keeps
 * them, so the bell is just a window onto entries that were always being
 * recorded.
 */

/** Published here and imported by the shell module, as the spawner's keys are. */
export const STATUSBAR_KEY = "shell.statusbar";
export const SECONDS_KEY = "shell.statusbar.seconds";

export interface StatusBarHandle {
  dispose(): void;
}

export function createStatusBar(hud: HTMLElement, ctx: KernelContext): StatusBarHandle {
  const bar = document.createElement("div");
  bar.className = "statusbar";

  const who = document.createElement("span");
  who.className = "sb-item sb-who";

  const procs = document.createElement("button");
  procs.className = "sb-item sb-procs";
  procs.type = "button";
  procs.title = "running processes — open the monitor";

  const up = document.createElement("span");
  up.className = "sb-item sb-up";

  const stations = document.createElement("button");
  stations.className = "sb-item sb-stations";
  stations.type = "button";
  stations.title = "stations — found one, or travel to one you have";
  stations.textContent = "⦸";

  const clock = document.createElement("span");
  clock.className = "sb-item sb-clock";

  const bell = document.createElement("button");
  bell.className = "sb-item sb-bell";
  bell.type = "button";
  bell.title = "notices";
  const bellGlyph = document.createElement("span");
  bellGlyph.textContent = "◉";
  const badge = document.createElement("span");
  badge.className = "sb-badge";
  bell.append(bellGlyph, badge);

  bar.append(who, procs, up, stations, clock, bell);

  /* ---------------- the notice history popover ---------------- */

  const popover = document.createElement("div");
  popover.className = "sb-popover";
  popover.hidden = true;

  /** Notices seen since the popover was last opened. */
  let unread = 0;

  const paintBadge = () => {
    badge.textContent = unread ? String(Math.min(unread, 99)) : "";
    badge.classList.toggle("live", unread > 0);
  };

  const paintPopover = () => {
    popover.replaceChildren();

    const title = document.createElement("div");
    title.className = "sb-pop-title";
    title.textContent = "notices";
    popover.appendChild(title);

    // The journal is the store; this reads the `notify` tag back out of it
    // rather than keeping a second list that could disagree with the log.
    const notices = ctx
      .journal()
      .filter((e: LogEntry) => e.tag === "notify")
      .slice(-40)
      .reverse();

    if (!notices.length) {
      const empty = document.createElement("div");
      empty.className = "sb-pop-empty";
      empty.textContent = "nothing has happened yet";
      popover.appendChild(empty);
    }

    for (const n of notices) {
      const row = document.createElement("div");
      row.className = `sb-pop-row is-${n.level}`;
      const when = document.createElement("span");
      when.className = "sb-pop-when";
      // Journal stamps are uptime-relative, so "how long ago" is the gap
      // between now and then — both measured from boot.
      when.textContent = ago(ctx.uptime() - n.t);
      const text = document.createElement("span");
      text.className = "sb-pop-text";
      text.textContent = n.msg;
      row.append(when, text);
      popover.appendChild(row);
    }

    const footer = document.createElement("button");
    footer.className = "sb-pop-more";
    footer.type = "button";
    footer.textContent = "open the full journal";
    footer.addEventListener("click", () => {
      togglePopover(false);
      ctx.launch("monitor", { tab: "journal" });
    });
    popover.appendChild(footer);
  };

  const togglePopover = (next?: boolean) => {
    const open = next ?? popover.hidden;
    popover.hidden = !open;
    bell.classList.toggle("open", open);
    if (open) {
      unread = 0;
      paintBadge();
      paintPopover();
    }
  };

  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleStationsPopover(false);
    togglePopover();
  });
  procs.addEventListener("click", () => ctx.launch("monitor"));

  /* ---------------- stations: found one, travel to one ----------------
   *
   * This lives here rather than in a window because a window is exactly
   * what travel used to require staying open: the trip is instant to
   * trigger but takes a couple of seconds to land, and closing (or just
   * losing track of) the one app that could send you anywhere else made
   * every subsequent trip a re-open. The status bar never closes.
   */
  const stationsPopover = document.createElement("div");
  stationsPopover.className = "sb-popover sb-stations-pop";
  stationsPopover.hidden = true;
  // A row's own click handler can repaint the popover (found/destroy both
  // do), which detaches the very button that was clicked before the event
  // finishes bubbling — the document-level dismiss handler then sees a
  // target that's no longer inside the popover and closes it mid-click.
  // Stopped once here rather than per-button, so it can't regress quietly
  // when a new row is added later.
  stationsPopover.addEventListener("click", (e) => e.stopPropagation());

  const paintStations = () => {
    stationsPopover.replaceChildren();

    const title = document.createElement("div");
    title.className = "sb-pop-title";
    title.textContent = "found a station";
    stationsPopover.appendChild(title);

    const foundRow = document.createElement("div");
    foundRow.className = "sb-station-found";
    for (const k of STATION_KINDS) {
      const b = document.createElement("button");
      b.className = "sb-station-kind";
      b.type = "button";
      b.title = k.title;
      b.textContent = k.glyph;
      b.addEventListener("click", () => {
        ctx.spawnStation(k.kind);
        paintStations();
      });
      foundRow.appendChild(b);
    }
    stationsPopover.appendChild(foundRow);

    const listTitle = document.createElement("div");
    listTitle.className = "sb-pop-title";
    listTitle.textContent = "your stations";
    stationsPopover.appendChild(listTitle);

    const here = ctx.currentStation();
    const list = ctx.listStations();
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "sb-pop-empty";
      empty.textContent = "nothing founded yet";
      stationsPopover.appendChild(empty);
    }
    for (const s of list) {
      const glyph = STATION_KINDS.find((k) => k.kind === s.kind)?.glyph ?? "○";
      const row = document.createElement("div");
      row.className = "sb-station-row";

      const name = document.createElement("span");
      name.className = "sb-station-name";
      name.textContent = `${glyph} ${s.name}`;

      const travel = document.createElement("button");
      travel.className = "sb-station-travel";
      travel.type = "button";
      if (s.id === here) {
        travel.textContent = "here";
        travel.disabled = true;
      } else {
        travel.textContent = "travel";
        travel.addEventListener("click", () => {
          ctx.travelTo(s.id);
          ctx.notify(`travelling to ${s.name}…`, "good");
          toggleStationsPopover(false);
        });
      }

      const kill = document.createElement("button");
      kill.className = "sb-station-kill";
      kill.type = "button";
      kill.textContent = "✕";
      kill.title = "destroy this station";
      kill.addEventListener("click", () => {
        ctx.destroyStation(s.id);
        paintStations();
      });

      row.append(name, travel, kill);
      stationsPopover.appendChild(row);
    }
  };

  const toggleStationsPopover = (next?: boolean) => {
    const open = next ?? stationsPopover.hidden;
    stationsPopover.hidden = !open;
    stations.classList.toggle("open", open);
    if (open) paintStations();
  };

  stations.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover(false);
    toggleStationsPopover();
  });

  // Clicking anywhere else dismisses it, the way every notification tray does.
  const onDocClick = (e: MouseEvent) => {
    if (!popover.hidden && !popover.contains(e.target as Node)) togglePopover(false);
    if (!stationsPopover.hidden && !stationsPopover.contains(e.target as Node)) {
      toggleStationsPopover(false);
    }
  };
  document.addEventListener("click", onDocClick);

  /* ---------------- live values ---------------- */

  const paint = () => {
    const now = new Date();
    const showSeconds = ctx.state.get<boolean>(SECONDS_KEY, false);
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    clock.textContent = showSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;

    // Read straight out of /etc — the same bytes `cat /etc/passwd` returns, so
    // `hostname foo` in the console retitles the bar with no wiring between them.
    who.textContent = `${ctx.state.get(USER_KEY, DEFAULT_USER)}@${ctx.state.get(
      HOSTNAME_KEY,
      DEFAULT_HOSTNAME
    )}`;

    const running = ctx.ps().length;
    procs.textContent = `⌘ ${running}`;

    up.textContent = `up ${humanUptime(ctx.uptime())}`;
  };

  paint();
  const timer = window.setInterval(paint, 1000);

  const offs = [
    ctx.on("system.notify", (e: KernelEvent) => {
      const p = e.payload as { kind?: NotifyKind } | undefined;
      if (popover.hidden) {
        unread++;
        paintBadge();
      } else paintPopover();
      // A warning pulses the bell; routine chatter doesn't earn the attention.
      if (p?.kind === "warn") {
        bell.classList.remove("alarm");
        void bell.offsetWidth; // restart the animation
        bell.classList.add("alarm");
      }
    }),
    ctx.on("proc.spawned", paint),
    ctx.on("proc.exited", paint),
    ctx.state.subscribe(STATUSBAR_KEY, () => {
      bar.hidden = !ctx.state.get<boolean>(STATUSBAR_KEY, true);
    }),
  ];

  bar.hidden = !ctx.state.get<boolean>(STATUSBAR_KEY, true);
  bar.appendChild(popover);
  bar.appendChild(stationsPopover);
  hud.appendChild(bar);

  return {
    dispose() {
      window.clearInterval(timer);
      document.removeEventListener("click", onDocClick);
      for (const off of offs) off();
      bar.remove();
    },
  };
}

/** Uptime in the fewest words that are still true. */
function humanUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A gap in milliseconds, rendered as the coarsest unit that stays honest. */
function ago(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(secs / 60);
  if (m < 1) return `${secs}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
