# voidshell

A spatial WebOS **core**. Not a desktop — a place. You float inside a
shader-lit void where apps crystallize into 3D space as glass panels. There's
no taskbar; you summon a constellation of apps and pick one.

This is the kernel and its first render backend, built to be torn apart and
extended. Rename it, gut the modules, replace the compositor — that's the point.

## Run it

```bash
npm install
npm run dev      # opens http://localhost:5173
```

Other scripts: `npm run build`, `npm run preview`, `npm run typecheck`. There's
also a headless smoke harness in `tools/smoke.mts` that boots the whole kernel
and every module against a stub compositor — see the header of that file for the
two commands to run it.

## Driving it

| gesture | what happens |
| --- | --- |
| drag the void | look around |
| **space** | summon / dismiss the launcher ring |
| **⌘/ctrl + K** | command palette — apps, verbs and open windows in one list |
| **⌘/ctrl + shift + A** | all apps |
| **⌘/ctrl + ,** | settings |
| **⌘/ctrl + shift + L** | lock the session |
| **home** | recentre the view |
| drag a title bar | move a window through space |
| scroll a window | push it away / pull it closer |
| drag the corner grip | resize |
| drag **⁙** onto another window | bind them into a constellation |
| drag **⁙** onto a celestial body | merge — the window rides that orbit |
| drag **⁙** onto a singularity | the window is eaten |
| drag a launcher node into the void | open that app exactly where you drop it |
| drag an app from All Apps onto a node | rebind that node |

Nothing is ever lost. Any window that drifts out of view puts a chevron on the
edge of the screen pointing at it — click it and the void rotates until you're
facing it again. Constellations report as one destination instead of four.

## The mental model

Three things, and they barely know about each other:

1. **The kernel** (`src/kernel/`) — the entire OS. It owns the module registry,
   the process table, the surface (window) table, the filesystem, the journal,
   the settings and command registries, an event bus, and shared state. It
   renders *nothing*. Like a microkernel, everything interesting lives outside
   it.

2. **The compositor** (`src/compositor/`) — the render backend. The kernel hands
   it abstract *surfaces* and says "give this a body." How it does that — WebGL,
   DOM, WebGPU — is entirely the compositor's business. `ThreeCompositor` is the
   spectacle one. Swapping it is **one line** in `src/main.ts`.

3. **Modules** (`src/modules/`) — the unit of everything. An app, a theme, a
   world effect, a background service: all the same contract. They never import
   each other. They talk through the event bus and shared state, so any one can
   be yanked out without the rest noticing.

### Why the panels aren't in WebGL

Live web content **cannot live inside WebGL** — you can't texture-map an
interactive `<iframe>` into a 3D scene and keep it interactive. So the world
(nebula, dust, celestial bodies) is drawn in WebGL, while every panel is
ordinary DOM in an overlay whose screen position is recomputed each frame by
projecting its 3D anchor through the camera. Clicks stay exact, text stays
selectable, and "merging a window onto a planet" is just anchoring it to that
planet's position.

## Settings are a registry, not a screen

Nothing hardcodes the settings UI. A module publishes a control and it appears:

```ts
ctx.defineSetting({
  key: "world.dust",        // a plain store key
  label: "dust motes",
  kind: "slider",           // toggle | slider | select | color | action | custom
  group: "World",           // becomes a tab
  default: 1400, min: 0, max: 5000, step: 100,
});

ctx.state.subscribe("world.dust", (v) => ctx.patchWorld({ dust: Number(v) }));
```

The Settings app walks that registry and builds a control for whatever it finds,
so adding a knob never means editing the settings screen. `kind: "custom"` hands
you a DOM node when a slider won't do — that's how the drag-to-reorder launcher
slot editor lives inside the same list as the checkboxes.

Everything written through `ctx.state` (except the `tmp.` namespace) is mirrored
to `localStorage` on a debounce. That single mechanism is the whole persistence
story: settings, launcher bindings, saved dashboards, notes and window layout
all ride on it for free.

## Constellations

A dashboard is several windows that agree to be one thing. Drag any member and
the whole group travels; light threads draw between them; the compass reports
them once, by name. Bind them with the **⁙** handle or from the Dashboards app,
and save the arrangement — a saved dashboard is just a name and a list of apps,
so it survives a reload and re-assembles itself on demand.

## Writing a module

A module is an object with a manifest and an `activate`. If it's an app, it also
has a `launch` that usually opens a surface. That's it.

```ts
import type { VoidModule } from "../../kernel/types";

export const hello: VoidModule = {
  manifest: { id: "hello", name: "Hello", kind: "app", glyph: "✶" },
  activate() {},
  launch(ctx) {
    ctx.openSurface({
      title: "hello",
      render: (root) => {
        root.textContent = "hi from the void";
      },
    });
  },
};
```

Register it in `src/main.ts` with `kernel.register(hello)` and it appears in the
launcher, the app drawer and the command palette — no other file changes.

### The syscall surface (`KernelContext`)

Everything a module can do, deliberately small:

- `emit` / `on` — the OS's IPC
- `state.get/set/subscribe` — shared memory, persisted
- `fs.*` — the filesystem (see below)
- `openSurface` / `closeSurface` / `openSurfaces` / `focusSurface`
- `lookAt` / `lookAtGroup` / `resetView` / `arrange` — move the viewer, not the windows
- `linkSurfaces` / `unlinkGroup` / `listGroups` — constellations
- `spawnBody` / `destroyBody` / `attachSurface` / `listBodies` — the sky
- `mountAnchored` / `focalPoint` / `screenToWorld` — pin bare DOM into the void
- `patchWorld` — ask the compositor to mutate the environment
- `defineSetting` / `defineCommand` — publish into the shell's registries
- `notify` — say something in the corner of the void
- `launch` / `launchAt` / `registry` — reach other modules
- `openPath(path)` — route a file to whichever module `handles` its extension
- `ps` / `kill` — the process table
- `log` / `journal` / `uptime` — the system journal

`kind: "app"` shows in the launcher. `kind: "world"` and `kind: "service"` stay
invisible — daemons. **Aurora** is worth reading: it owns every colour in the
build and exposes them purely as registered settings, which is how "theme"
becomes a *program* instead of a hardcoded palette.

## Processes

An OS is, more than anything else, a thing that keeps track of what is running.
voidshell used to have windows but no processes: launching an app *was* opening
a surface, and closing the surface meant the app was simply gone. Nothing could
be listed and nothing could be killed, and the service modules — aurora,
horizon, shell — were invisible despite running for the whole session.

Now every launch is a process, and every background module is a daemon:

```
void@void ~ › ps
  PID  STAT    ELAPSED   MODULE        NAME
    1  daemon    04:41   kernel        voidshell
    2  daemon    04:41   aurora        Aurora
    3  daemon    04:41   horizon       Horizon
    4  daemon    04:41   shell         Shell
   11  running   00:52   workspace     Workspace
   14  running   00:07   monitor       Monitor
```

The key move is that **process lifetime is derived from surface ownership**
rather than tracked alongside it. Surfaces opened during a `launch()` belong to
that launch's process, and the process exits when its last window closes — so
`ps` cannot drift out of sync with what's actually on screen.

`kill <pid>` closes every window a process owns, routing through the ordinary
close path so each module still runs its own cleanup. **Daemons refuse to die.**
That isn't a limitation being papered over: aurora owns every colour in the
build and horizon owns the sky, so "killed the theme daemon" would be an
unrecoverable state reachable by typing four characters. A real OS refuses to
kill init for the same reason, and reports `EPERM` rather than pretending it
worked.

## The system is a filesystem

voidshell already decided that the desktop is a directory. This is that bet
taken all the way. Processes, devices, configuration and the log are all
reachable with `cat`:

```
ls /proc                    one directory per running process
cat /proc/uptime            live — recomputed on every read
cat /proc/12/status         what process 12 actually is
cat /proc/meminfo           filesystem and heap
tail -n 20 /var/log/system.log | grep warn
noisy-command > /dev/null   a real sink, not a special case in the shell
echo notes >> /etc/autostart  edits what launches at boot
```

Nothing here invents an API. Each is an ordinary VFS node with a `gen` (content
computed on demand) or a `sink` (where a write goes), which means every tool
that already worked on files — `cat`, `grep`, `tail`, redirection, tab
completion, the file manager — works on them with **no special-casing
anywhere**. `> /dev/null` needed zero shell support: redirection already writes
to a path, and that path throws it away.

The payoff for making sinks writable inside a read-only mount is `/etc`. It is
generated from the settings store *and writes back to it*, so the Settings app,
`hostname foo`, and `echo >> /etc/autostart` are three doors onto one value
rather than three implementations of it. Configuring the system by editing a
config file is the actual mechanism, not a simulation of it.

## The journal

Toasts vanish after 2.6 seconds and `console.log` goes somewhere the shell can't
reach, so until now nothing the system did left a trace you could grep. The
journal is a fixed-size ring the kernel writes boot, mount, spawn, exit and
error events into, and it's served as `/var/log/system.log` — so `tail`, `grep`
and `wc` are the log tooling and none had to be written.

`ctx.log()` is tagged with the calling module's id automatically. `ctx.notify()`
is mirrored in, which is where **notification history** comes from: the bell in
the status bar is just a window onto entries that were always being recorded.

`dmesg [level]` reads it in the console; the Monitor app renders it with the
process table and the mount table.

## Session lifecycle

Ignition was a beautiful front door onto a building with no other doors. There's
now a whole session: `lock`, `reboot` and `shutdown` (as commands, palette
verbs, and **⌘/ctrl + shift + L**), plus `/etc/autostart` deciding what opens at
boot.

All three power states are one veil with different contents, because they're the
same idea at different depths. The lock screen is **honest about what it is** —
there is no password, because a passphrase checked in client-side JavaScript
against a value in localStorage protects nothing and would imply otherwise. It's
a screen you can leave up, which is the part that's actually useful in a tab.

Autostart runs on every boot, restored session or not — that's what makes it
autostart rather than a second session file. The singleton guard means anything
the restore already re-opened gets refocused, not cloned.

## The status bar

voidshell deliberately has no taskbar. But "no taskbar" had quietly become "no
persistent chrome at all", and that was most of why the place didn't read as an
OS: no clock, nothing saying who you were, and no evidence anything was running
once every window was closed.

The status bar lists no windows and launches nothing off a strip, so it isn't a
taskbar by the back door. It answers *who, when, how long, how much* — and hosts
the notice bell. Turn it off in Settings › System.

## The filesystem

`src/kernel/vfs.ts` is a single tree assembled from mounts, reached by modules
through `ctx.fs`. Five mounts ship:

| mount | mode | backing |
| --- | --- | --- |
| `/home/void` | read-write | localStorage, debounced on change |
| `/projects` | read-only | build-time scan of the sibling project dirs |
| `/proc` | synthetic | the process table and live system counters |
| `/dev` | synthetic | `null`, `zero`, `random`, `console` |
| `/etc` | synthetic, writable | the settings store |
| `/var/log` | synthetic | the journal |

`mount` lists them. Files carry an `mtime`, shown by `ls -l` and persisted across
reloads — without that every file would claim to have been modified at boot,
which makes dates worse than useless.

### The trash

`rm` is recoverable. Deleting moves to `~/.Trash` and records where the file came
from, so `restore <name>` puts it back — including re-creating the directory it
lived in if that's gone too. `rm -f` is the permanent path, and it's the only one
that needs `-r` for a directory, because a guard is worth something only on the
irreversible route.

Trashing is a **move**, so it costs nothing and can't corrupt anything. The
manifest that remembers original paths lives in the store rather than as a
dotfile inside `~/.Trash`, which is what lets emptying the trash be a plain
recursive delete with nothing to preserve.

Delete on the desktop and in the file manager route through the same helper.
Dotfiles are hidden in both — `~/.Trash` and `~/.desktop-layout.json` are the
shell's bookkeeping, not your documents — and `ls -a` still shows them.

Permissions live on the *node*, not on a path prefix, so a mount carries its own
rules wherever it's grafted in. Writing to `/projects` fails with `EROFS` the way
a real read-only mount does, rather than silently no-op'ing.

### How `/projects` gets there

`plugins/projects.ts` is a Vite plugin with two modes behind one API:

- **dev** — serves a live scan at `/__vs/projects.json`, so editing a file on
  disk shows up in the shell on reload.
- **build** — freezes the same scan into the bundle, because the deployed site
  is static and has no disk to read.

Text files are embedded whole under a 128KB cap. Binaries are indexed by name
and size but never embedded — that's what keeps a 27MB asset folder from
becoming a 27MB download. Classification is a binary-extension *denylist*, not a
text allowlist, so unguessable text files (`.firebaserc`, `.gql`) stay readable;
a NUL-byte check catches anything mislabeled.

Point it somewhere else with `voidshellProjects({ root: "/some/path" })` in
`vite.config.ts`. It defaults to the parent of the Vite root.

### The Workspace: files and shell over one directory

Browsing and typing are the same activity, so they share a window and a working
directory. Click into a folder and the prompt follows; `cd` and the list
follows. The divider between the panes is draggable, and its position persists.

The console is a real shell over that FS: `cd` / `ls -la` / `cat` / `tree` /
`find`, plus `mkdir`, `rm`, `mv`, `touch`, `df`, `mount` and `history`. It holds
no privileges the syscall surface doesn't already grant every module.

**The system commands.** `ps`, `kill <pid>`, `uptime`, `free` and `dmesg` read
the process table and the journal; `whoami`, `hostname`, `env`, `export` and
`unset` handle identity and environment; `trash` / `restore` manage deletions;
`lock`, `reboot` and `shutdown` end the session. Several are deliberately thin —
`free` prints `/proc/meminfo` rather than recomputing it, so if `/proc` is wrong
the command is wrong in exactly the same way.

**Variables.** `$VAR` and `${VAR}` expand, and `$?` is the last exit status.
`HOME`, `PWD`, `USER` and `HOSTNAME` are *derived* on every lookup rather than
stored, so `$USER` can never disagree with `/etc/passwd` and `cd` can never leave
`$PWD` stale — a shell that caches those has two sources of truth for one fact.
Expansion happens inside the tokenizer, not as a pre-pass, because `'$HOME'` and
`"$HOME"` differ and a regex over the line can't tell them apart. An expanded
value is treated as quoted, so a variable holding `|` can't silently become a
pipe.

**Pipelines and redirection.** `|` chains commands, `>` and `>>` write and
append, and `&&` stops at the first failure. The filters (`grep -i`, `sort -r`,
`uniq`, `wc`, `head -n`, `tail -n`, `cat`) read piped input or a named file
interchangeably, so `ls -l | grep .md | wc` does what it looks like. `grep`
reports no-match as a failure, so it short-circuits a chain the way it should.

**Line editing.** Tab completes commands on the first word and paths after it,
filling in the longest common prefix and listing the options when ambiguous.
`~` expands to `/home/void`. `Ctrl+R` is reverse-i-search through history,
`!!` repeats the last command, and `Ctrl+A/E/U/K/W/L` behave as readline. History
is persisted through the store, so it survives a reload.

Anything that isn't a builtin is still handed to the machine over
[the host bridge](#the-host-bridge).

## The desktop

One idea carries the whole thing: **the desktop is a directory**. Icons are
`/home/void/Desktop` drawn into the void, so dragging a file to the desktop is
an ordinary `mv` and needs no special case. Delete the file in the console and
its icon vanishes, because the shell and the desktop read the same tree.

Icons are anchored in 3D like windows, not pinned to a flat HUD — one coherent
world rather than a 2D layer pasted over a 3D scene. Positions persist in
`/home/void/.desktop-layout.json`, the way a real OS keeps its layout beside the
directory it describes.

| gesture | result |
| --- | --- |
| right-click void | New Folder · New File · Paste · Open Workspace Here · Tidy Icons |
| right-click icon | Open · Run · Edit · Rename · Copy · Cut · Delete |
| drag icon | reposition in space, persisted |
| double-click | open in the associated app |
| drag a row out of the Workspace | drop onto the void to put it on the desktop |
| drag onto the Workspace list | move it into that directory |
| click a window | raises it above its neighbours |
| drag a window's right edge, bottom edge or corner | resize width, height or both |
| `Delete` / `Enter` | delete or open the selected icon |

Resizing accounts for the 3D projection: a drag of N screen pixels is N/scale
*logical* pixels, since panels are drawn smaller with distance. There is a grip
per axis — the east edge takes width, the south edge height, the corner both —
because a panel that is the right width but the wrong height is the common case,
and a corner-only grip makes you fight whichever dimension was already correct.

Dragging *out of* `/projects` copies rather than moves — the source is a
read-only mount, and a move would fail with `EROFS` the user can do nothing
about.

### Apps, associations, and arguments

`launch(id, args)` is the OS's exec: modules receive `args.path` the way a
program receives argv. A module declares what it opens via `handles`, and
`ctx.openPath(p)` routes to whichever one claims the extension — `"dir"` goes to
the Workspace, `"*"` is the fallback. That's the entire association table; adding
a viewer for a new filetype is one array entry, not a change to the desktop.

Launching *with* args deliberately bypasses the singleton guard: "open this
file" is about a specific document, so refocusing whatever the app already had
open would drop the path on the floor.

## Running programs

`.py` and `.js` files are executable, not just readable. The editor is where
that happens: open one and it grows a second pane, so you write and run in the
same window. Hit **Run**, press `Ctrl+Enter`, pick **Run** from a context menu,
or type `run <file>` in the console. Output streams in, `stop` kills it, and the
input line at the bottom is the program's stdin.

The run executes the *buffer*, not the last saved copy — editing and running
are one loop, not a save-then-run dance. Where the file is writable it's saved
first, so the two never disagree afterwards.

| language | runtime | notes |
| --- | --- | --- |
| JavaScript | Web Worker | instant, offline, `require()` resolves against sibling files |
| Python | Pyodide (CPython 3.13 → wasm) | ~10MB fetched from jsDelivr on first run, then cached |

Sibling source files are mounted alongside the entry point, so multi-file
projects import normally. `run /projects/break-the-house/run_game.py` plays the
actual game — `import example_cards` resolves, emoji render, and `input()` works.

**`input()` is real.** Python's stdin is synchronous, but the line you type only
exists on the main thread, so the worker parks on `Atomics.wait` against a
SharedArrayBuffer until the host writes the line back. That needs the page to be
cross-origin isolated — `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, set in `vite.config.ts` for dev and
in the `Caddyfile` for production. Without those headers everything else still
works; only stdin degrades, with an explanation rather than a hang.

## The host bridge

Anything the shell doesn't recognise as a builtin is run **on the machine**:

```
cd /projects/pawnageddon
npm install
npm run dev          → detects the port, opens the game as a window
jobs                 → list running processes
kill job-3           → stop one (kills the whole process group)
app 5174             → frame a port manually
```

A browser has no process API, so this can only work via something outside the
page. `plugins/host.ts` runs inside the Vite dev server: it spawns children,
streams stdout/stderr back over SSE, and reverse-proxies a child's port under
voidshell's own origin so it can be framed.

**It is dev-only by construction.** The plugin is `apply: "serve"`, so it does
not exist in a production build — a deployed voidshell answers every bridge call
with "no host bridge" and has no code path to execute anything. Commands are
additionally confined to directories at or below the projects root; `cwd`
values that escape it (via `..` or a symlink) are rejected.

### Why each app gets its own port

A framed app is served through a small proxy on its **own ephemeral port**, not
under a path like `/__vs/app/5174/`. The path approach cannot work: a dev
server's HTML and modules use absolute URLs (`/src/main.jsx`,
`/node_modules/.vite/deps/react.js`) which resolve against the origin root and
hit voidshell instead of the app. Routing by `Referer` fixes only the first
level — a module imported by a module carries the *importing module's* URL.

Serving each app at the root of its own port makes absolute paths resolve
correctly, and since the proxy owns the response it can inject the COEP/CORP
headers the child needs to be embeddable inside a cross-origin-isolated parent
(a dev server won't send those itself). HMR websockets are forwarded too.

That is also why COEP is `credentialless` rather than `require-corp` — it still
grants SharedArrayBuffer for Python's stdin without hard-blocking every
subresource a framed app loads.

### What can't run

The Plasma widgets (`calendar-widget`, `todo-widget`) are QML and have no web
target. Everything else runs, though a project still needs its own setup —
`hero-nexus` starts and serves but returns 500 until its Firebase environment
variables are set, and the error shows up in the console like any other.

## Swapping the renderer

Write a `DomCompositor implements Compositor` that mounts surfaces as flat
draggable divs, swap it in for `new ThreeCompositor()` in `src/main.ts`, and
every module above renders unchanged in a 2D world. The optional methods
(`linkSurfaces`, `lookAtSurface`, `arrange`…) degrade to no-ops, so a minimal
backend is genuinely minimal.

## What's next

- A `DomCompositor` as the pragmatic fallback backend.
- Constellation *layouts* — remembering relative positions, not just membership.
- Multi-user: the store is already the only source of truth worth syncing.
- Syntax highlighting in the file viewer (the language is already detected).
- Multi-select on the desktop (marquee drag, shift-click) — everything today is
  single-selection.
- Undo for *edits*. Deletions are recoverable from the trash now, but a bad
  `mv` or a clobbering `>` still isn't.
- Per-module permissions. Every module currently gets the whole syscall surface;
  a manifest that declares what it needs is the obvious next tightening, and the
  process table is the thing that would enforce it.
- Multi-line file writing from the shell (`write` joins its arguments with
  spaces, so use the editor for anything with real line breaks).
- Running the web projects in-shell — iframe-based `render()` for `hero-nexus`
  and `stonks-surplus`, which currently browse as source only.
