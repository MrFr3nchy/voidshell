import type { KernelContext, VoidModule } from "../../kernel/types";
import {
  AUTOSTART_KEY,
  DEFAULT_HOSTNAME,
  DEFAULT_USER,
  HOSTNAME_KEY,
  USER_KEY,
} from "../../kernel/sysfs";
import { emptyTrash, TRASH_DIR } from "../../kernel/trash";
import {
  ALLAPPS_KEY,
  COUNT_KEY,
  HINT_KEY,
  MAX_SLOTS,
  RADIUS_KEY,
  SLOTS_KEY,
  resolveSlots,
} from "../../ui/spawner";
import { SECONDS_KEY, STATUSBAR_KEY } from "../../ui/statusBar";

export const SOUND_KEY = "system.sound";
export const RESTORE_KEY = "system.restoreSession";

const KEYBINDS: [string, string][] = [
  ["space", "summon / dismiss the launcher ring"],
  ["\u2318 / ctrl + k", "command palette"],
  ["\u2318 / ctrl + shift + a", "all apps"],
  ["\u2318 / ctrl + ,", "settings"],
  ["\u2318 / ctrl + shift + l", "lock the session"],
  ["home", "recentre the view"],
  ["escape", "close whatever is open"],
  ["\u2318 / ctrl + shift + u", "dissolve every constellation"],
  ["\u2318 / ctrl + shift + k", "close every window"],
  ["drag the void", "look around"],
  ["scroll a window", "push it away / pull it closer"],
  ["drag \u2059 onto a window", "link them into a constellation"],
  ["drag \u2059 onto a body", "merge \u2014 the window rides its orbit"],
  ["drag \u2059 onto a singularity", "let it be eaten"],
  ["click a thread", "harden or loosen that constellation"],
];

/**
 * The shell module is voidshell's own settings surface. It doesn't render the
 * Settings app — it publishes controls into the registry and lets whatever
 * settings UI exists pick them up. Anything it can't do from a module (wiping
 * the store, opening the drawer) it asks for over the bus, which keeps it from
 * reaching into the shell's DOM.
 */
export const shell: VoidModule = {
  manifest: {
    id: "shell",
    name: "Shell",
    kind: "service",
    glyph: "\u25a3",
    blurb: "owns the launcher and the system knobs",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    /* ---------------- launcher ---------------- */

    ctx.defineSetting({
      key: COUNT_KEY,
      label: "launcher nodes",
      hint: "how many apps fan out of the ring",
      kind: "slider",
      group: "Launcher",
      order: 10,
      default: 6,
      min: 1,
      max: MAX_SLOTS,
      step: 1,
    });

    ctx.defineSetting({
      key: SLOTS_KEY,
      label: "what each node launches",
      hint: "drag a row to reorder \u00b7 or drop an app onto a node straight from All Apps",
      kind: "custom",
      group: "Launcher",
      order: 11,
      render: (root, c) => renderSlotEditor(root, c),
    });

    ctx.defineSetting({
      key: RADIUS_KEY,
      label: "ring radius",
      kind: "slider",
      group: "Launcher",
      order: 20,
      default: 118,
      min: 80,
      max: 220,
      step: 2,
    });

    ctx.defineSetting({
      key: ALLAPPS_KEY,
      label: "show the \u201call apps\u201d node",
      kind: "toggle",
      group: "Launcher",
      order: 21,
      default: true,
    });

    ctx.defineSetting({
      key: HINT_KEY,
      label: "show the hint line",
      kind: "toggle",
      group: "Launcher",
      order: 22,
      default: true,
    });

    /* ---------------- identity ---------------- */

    // These two are the backing store for /etc/passwd and /etc/hostname. The
    // settings screen and `hostname foo` in the console are two doors onto one
    // value, which is the whole reason /etc is generated rather than stored.

    ctx.defineSetting({
      key: USER_KEY,
      label: "who you are",
      hint: "shows in the prompt, the status bar and /etc/passwd",
      kind: "custom",
      group: "System",
      order: 1,
      default: DEFAULT_USER,
      render: (root, c) => renderTextSetting(root, c, USER_KEY, DEFAULT_USER),
    });

    ctx.defineSetting({
      key: HOSTNAME_KEY,
      label: "what this machine is called",
      hint: "the other half of the prompt · also `hostname` in the console",
      kind: "custom",
      group: "System",
      order: 2,
      default: DEFAULT_HOSTNAME,
      render: (root, c) => renderTextSetting(root, c, HOSTNAME_KEY, DEFAULT_HOSTNAME),
    });

    /* ---------------- status bar ---------------- */

    ctx.defineSetting({
      key: STATUSBAR_KEY,
      label: "show the status bar",
      hint: "clock, uptime, running processes and the notice bell",
      kind: "toggle",
      group: "System",
      order: 5,
      default: true,
    });

    ctx.defineSetting({
      key: SECONDS_KEY,
      label: "seconds on the clock",
      kind: "toggle",
      group: "System",
      order: 6,
      default: false,
    });

    /* ---------------- system ---------------- */

    ctx.defineSetting({
      key: AUTOSTART_KEY,
      label: "launch these at boot",
      hint: "the same list as /etc/autostart — edit it either way",
      kind: "custom",
      group: "System",
      order: 12,
      default: [],
      render: (root, c) => renderAutostart(root, c),
    });

    ctx.defineSetting({
      key: RESTORE_KEY,
      label: "restore my windows on reload",
      hint: "re-opens what was open, exactly where it floated",
      kind: "toggle",
      group: "System",
      order: 10,
      default: true,
    });

    ctx.defineSetting({
      key: SOUND_KEY,
      label: "audible feedback",
      hint: "a soft blip when windows open, close and link",
      kind: "toggle",
      group: "System",
      order: 11,
      default: false,
    });

    ctx.defineSetting({
      key: "system.keys",
      label: "everything you can press",
      kind: "custom",
      group: "System",
      order: 30,
      render: (root) => {
        const dl = document.createElement("dl");
        dl.className = "set-keys";
        for (const [key, what] of KEYBINDS) {
          const dt = document.createElement("dt");
          dt.textContent = key;
          const dd = document.createElement("dd");
          dd.textContent = what;
          dl.append(dt, dd);
        }
        root.appendChild(dl);
      },
    });

    ctx.defineSetting({
      key: "system.saveNow",
      label: "save this layout now",
      hint: "it also saves itself whenever you leave",
      kind: "action",
      group: "System",
      order: 40,
      run: (c) => {
        c.emit("shell.saveSession");
        c.notify("layout saved", "good");
      },
    });

    ctx.defineSetting({
      key: "system.emptyTrash",
      label: "empty the trash",
      hint: "deleted files live in ~/.Trash until this \u2014 `restore <name>` gets them back",
      kind: "action",
      group: "System",
      order: 42,
      run: (c) => {
        const n = emptyTrash(c);
        c.notify(
          n ? `deleted ${n} item${n === 1 ? "" : "s"} for good` : "the trash was already empty",
          n ? "good" : "info"
        );
      },
    });

    ctx.defineSetting({
      key: "system.reset",
      label: "wipe everything and start over",
      hint: "settings, launcher bindings, saved dashboards, notes \u2014 all of it",
      kind: "action",
      group: "System",
      order: 43,
      run: (c) => c.emit("shell.factoryReset"),
    });

    /* ---------------- commands ---------------- */

    ctx.defineCommand({
      id: "shell.allApps",
      label: "all apps",
      hint: "every installed module",
      glyph: "\u2237",
      run: (c) => c.emit("shell.openDrawer"),
    });
    ctx.defineCommand({
      id: "shell.settings",
      label: "settings",
      hint: "every knob in the void",
      glyph: "\u2699",
      run: (c) => c.launch("settings"),
    });
    ctx.defineCommand({
      id: "shell.unlinkAll",
      label: "dissolve every constellation",
      hint: "frees every window without closing anything",
      glyph: "\u2059",
      run: (c) => {
        const groups = c.listGroups();
        for (const g of groups) c.unlinkGroup(g.id);
        c.notify(`dissolved ${groups.length} constellation${groups.length === 1 ? "" : "s"}`, "good");
      },
    });
    ctx.defineCommand({
      id: "shell.closeAll",
      label: "close every window",
      hint: "clean slate",
      glyph: "\u2717",
      run: (c) => {
        const open = c.openSurfaces();
        for (const s of open) c.closeSurface(s.id);
        c.notify(`closed ${open.length} window${open.length === 1 ? "" : "s"}`);
      },
    });

    /* ---------------- power ---------------- */

    // The shell owns the screen, so these publish an intent and the HUD's power
    // veil acts on it. Same split as factoryReset: modules don't touch chrome.
    ctx.defineCommand({
      id: "shell.lock",
      label: "lock",
      hint: "leave the void up without leaving it open",
      glyph: "\u25cd",
      run: (c) => c.emit("system.power", { action: "lock" }),
    });
    ctx.defineCommand({
      id: "shell.reboot",
      label: "restart",
      hint: "save the session and boot again",
      glyph: "\u21bb",
      run: (c) => c.emit("system.power", { action: "reboot" }),
    });
    ctx.defineCommand({
      id: "shell.shutdown",
      label: "shut down",
      hint: "save everything and stop",
      glyph: "\u23fb",
      run: (c) => c.emit("system.power", { action: "shutdown" }),
    });
    ctx.defineCommand({
      id: "shell.trash",
      label: "open the trash",
      hint: "deleted files, still recoverable",
      glyph: "\u232b",
      run: (c) => {
        // The directory is created lazily on first delete, so a user who has
        // never deleted anything would otherwise get "no such path".
        c.fs.mkdirp(TRASH_DIR);
        c.openPath(TRASH_DIR);
      },
    });

    /* ---------------- audible feedback ---------------- */

    const blip = makeBlipper(() => ctx.state.get<boolean>(SOUND_KEY, false));
    const offs = [
      ctx.on("surface.opened", () => blip(660, 0.05)),
      ctx.on("surface.closed", () => blip(220, 0.06)),
      ctx.on("system.notify", () => blip(880, 0.03)),
    ];

    return () => offs.forEach((off) => off());
  },
};

/**
 * A one-line text setting. The settings registry has no "text" kind — it was
 * built for knobs, and a free-text field is the one shape a slider, a toggle
 * and a select can't cover. Rather than widen SettingKind for two uses, this
 * renders one through the `custom` escape hatch, which is what it's for.
 */
function renderTextSetting(
  root: HTMLElement,
  ctx: KernelContext,
  key: string,
  fallback: string
): () => void {
  const input = document.createElement("input");
  input.className = "set-text";
  input.type = "text";
  input.spellcheck = false;
  input.value = ctx.state.get<string>(key, fallback);

  const commit = () => {
    const next = input.value.trim() || fallback;
    input.value = next;
    ctx.state.set(key, next);
  };
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);

  root.appendChild(input);
  // Someone else may have set it — `hostname foo` in the console writes the
  // same key through /etc/hostname's sink.
  return ctx.state.subscribe(key, (v) => {
    if (document.activeElement !== input) input.value = String(v ?? fallback);
  });
}

/**
 * The autostart editor: a checkbox per app, writing the same store key that
 * /etc/autostart reads and writes. Neither is the "real" one.
 */
function renderAutostart(root: HTMLElement, ctx: KernelContext): () => void {
  const paint = () => {
    root.replaceChildren();
    const chosen = new Set(ctx.state.get<string[]>(AUTOSTART_KEY, []));
    const list = document.createElement("div");
    list.className = "auto-list";

    for (const app of ctx.registry().filter((m) => m.kind === "app")) {
      const row = document.createElement("label");
      row.className = "auto-row";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = chosen.has(app.id);
      box.addEventListener("change", () => {
        // Rebuilt from the registry order so the file stays stable rather than
        // recording the order the boxes happened to be clicked in.
        const next = ctx.registry()
          .filter((m) => m.kind === "app")
          .map((m) => m.id)
          .filter((id) => (id === app.id ? box.checked : chosen.has(id)));
        ctx.state.set(AUTOSTART_KEY, next);
      });

      const glyph = document.createElement("span");
      glyph.className = "auto-glyph";
      glyph.textContent = app.glyph ?? "·";

      const name = document.createElement("span");
      name.className = "auto-name";
      name.textContent = app.name;

      row.append(box, glyph, name);
      list.appendChild(row);
    }
    root.appendChild(list);
  };

  paint();
  return ctx.state.subscribe(AUTOSTART_KEY, paint);
}

/**
 * The slot editor. Each row is one node in the ring; the select rebinds it and
 * the handle reorders the ring by dragging. It's the long-hand version of
 * dropping an app onto a node from the drawer, for when the ring isn't open.
 */
function renderSlotEditor(root: HTMLElement, ctx: KernelContext): () => void {
  const apps = ctx.registry().filter((m) => m.kind === "app");

  const paint = () => {
    root.replaceChildren();
    const slots = resolveSlots(ctx);
    const list = document.createElement("div");
    list.className = "slot-list";

    slots.forEach((id, index) => {
      const row = document.createElement("div");
      row.className = "slot-row";
      row.dataset.index = String(index);

      const grip = document.createElement("span");
      grip.className = "slot-grip";
      grip.textContent = "\u2261";
      grip.title = "drag to reorder";

      const num = document.createElement("span");
      num.className = "slot-num";
      num.textContent = String(index + 1);

      const sel = document.createElement("select");
      sel.className = "cos-select slot-select";
      for (const a of apps) {
        const o = document.createElement("option");
        o.value = a.id;
        o.textContent = `${a.glyph ?? "\u00b7"}  ${a.name}`;
        if (a.id === id) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        const next = resolveSlots(ctx);
        next[index] = sel.value;
        ctx.state.set(SLOTS_KEY, next);
      });

      row.append(grip, num, sel);
      bindReorder(row, grip, list, index, () => resolveSlots(ctx), ctx);
      list.appendChild(row);
    });

    root.appendChild(list);
  };

  paint();
  // The editor lives as long as the Settings window does; handing the
  // unsubscribes back means the settings surface tears them down for us.
  const offs = [
    ctx.state.subscribe(COUNT_KEY, paint),
    ctx.state.subscribe(SLOTS_KEY, paint),
  ];
  return () => offs.forEach((off) => off());
}

function bindReorder(
  row: HTMLElement,
  grip: HTMLElement,
  list: HTMLElement,
  index: number,
  read: () => string[],
  ctx: KernelContext
): void {
  let active = false;

  grip.addEventListener("pointerdown", (e) => {
    active = true;
    row.classList.add("lifting");
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  grip.addEventListener("pointermove", (e) => {
    if (!active) return;
    const rows = [...list.children] as HTMLElement[];
    rows.forEach((r) => r.classList.remove("drop-before", "drop-after"));
    const target = rowUnder(rows, e.clientY);
    if (!target || target.el === row) return;
    target.el.classList.add(target.after ? "drop-after" : "drop-before");
  });

  const end = (e: PointerEvent) => {
    if (!active) return;
    active = false;
    row.classList.remove("lifting");
    grip.releasePointerCapture(e.pointerId);

    const rows = [...list.children] as HTMLElement[];
    rows.forEach((r) => r.classList.remove("drop-before", "drop-after"));
    const target = rowUnder(rows, e.clientY);
    if (!target || target.el === row) return;

    const to = Number(target.el.dataset.index) + (target.after ? 1 : 0);
    const next = read();
    const [moved] = next.splice(index, 1);
    next.splice(to > index ? to - 1 : to, 0, moved);
    ctx.state.set(SLOTS_KEY, next);
  };

  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

function rowUnder(
  rows: HTMLElement[],
  y: number
): { el: HTMLElement; after: boolean } | null {
  for (const el of rows) {
    const r = el.getBoundingClientRect();
    if (y < r.top || y > r.bottom) continue;
    return { el, after: y > r.top + r.height / 2 };
  }
  return null;
}

/**
 * A three-line synth. Notifications and window events get a short sine blip —
 * off by default, because an OS that makes noise without asking is a rude OS.
 */
function makeBlipper(enabled: () => boolean): (freq: number, gain: number) => void {
  let audio: AudioContext | null = null;
  return (freq, gain) => {
    if (!enabled()) return;
    try {
      audio ??= new AudioContext();
      if (audio.state === "suspended") void audio.resume();
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      amp.gain.setValueAtTime(0, audio.currentTime);
      amp.gain.linearRampToValueAtTime(gain, audio.currentTime + 0.01);
      amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
      osc.connect(amp).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.2);
    } catch {
      /* no audio device, no problem */
    }
  };
}
