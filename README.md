# voidshell

A spatial WebOS **core**. Not a desktop — a place. You float inside a
shader-lit void where apps crystallize into 3D space as glass panels. There's
no taskbar; you summon a constellation of apps and pick one.

This is the kernel and its first render backend, built to be torn apart and
extended. Rename it, gut the modules, replace the compositor — that's the point.

**[Open the demo →](https://mrfr3nchy.github.io/voidshell/)** — the whole
client, in your browser, with nothing to install. Not a video: the same kernel,
the same compositor and the same modules, over a workspace that lives in the
tab. See [Guest sessions](#guest-sessions).

## Run it

```bash
npm install
npx voidshell dev      # API on :3000, client on :5173, one Ctrl-C stops both
```

Dashboards live on the server, so the client alone gets you a lock screen —
with *look around first* on it, which opens a real session that simply isn't
saved. `voidshell dev` runs both halves against a throwaway database in
`.voidshell-dev/`; `--fresh` empties it, `--api-only` skips Vite.

`npm run dev` still starts just the client if that's what you want.

Deploying is the same CLI — `voidshell setup` provisions a droplet and
`voidshell deploy` ships to it. See [DEPLOY.md](DEPLOY.md), or run
`npx voidshell` for the full command list.

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
| **⌘/ctrl + shift + T** | reopen the last closed window |
| **⌘/ctrl + `** | step through the open windows |
| **⌘/ctrl + shift + E** | see every window at once |
| **home** | recentre the view |
| drag a title bar | move a window through space |
| double-click a title bar | fill the screen / put it back |
| drag a title bar to an edge | snap it to that half, or to the top to fill |
| **⌘ / ctrl** + scroll a window | push it away / pull it closer |
| drag any edge or corner | resize from that side |
| drag **⁙** onto another window | bind them into a constellation |
| drag **⁙** onto a celestial body | merge — the window rides that orbit |
| drag **⁙** onto a singularity | the window is eaten |
| drag a launcher node into the void | open that app exactly where you drop it |
| drag an app from All Apps onto a node | rebind that node |

Nothing is ever lost. Any window that drifts out of view puts a chevron on the
edge of the screen pointing at it — click it and the void rotates until you're
facing it again. Constellations report as one destination instead of four.

## Guest sessions

The lock screen used to be the whole story: no account, no void. Which meant
the first thing anyone was asked to do was create a credential to find out what
they were creating it for — and it is the reason this could not be linked to.

A guest session is not a demo mode. It is the kernel, the compositor and every
module, over a `WorkspaceHost` that keeps the snapshot in the tab instead of on
the server. Nothing is stubbed, nothing is read-only, and the code path is the
one real sessions take; the only difference is where the save goes.

It is offered in three places, for three different reasons:

- **On the key screen**, as *look around first* — the answer to being asked for
  a credential before being shown what it unlocks.
- **On the can't-reach-the-server screen**, as *go in without it*. Nothing
  behind that screen needs the server except the saving, so refusing to boot
  over an outage costs you the whole OS rather than one of its properties.
- **As a whole build.** `VITE_VOIDSHELL_GUEST=1 npm run build` produces a
  bundle that never probes `/api` at all — that's what's on the demo link, a
  static site with no server half to talk to.

**It is not written down anywhere, on purpose.** `localStorage` would survive a
reload, and browser storage is banned in the client by a CI guard for a reason
worth keeping: a dashboard that lives in the browser is a dashboard that
doesn't follow the account. Rather than carve an exception into that rule for
the one case where it would be convenient, a guest session says what it is on
the way in — and the modules that would otherwise lie about it read
`tmp.sys.guest` and change what they call things. The shell's *sign out*
becomes *start over*, because there is no account to leave and no key to come
back with.

## The mental model

Three things, and they barely know about each other:

1. **The kernel** (`packages/ui/src/kernel/`) — the entire OS. It owns the module registry,
   the process table, the surface (window) table, the filesystem, the journal,
   the settings and command registries, an event bus, and shared state. It
   renders *nothing*. Like a microkernel, everything interesting lives outside
   it.

2. **The compositor** (`packages/ui/src/compositor/`) — the render backend. The kernel hands
   it abstract *surfaces* and says "give this a body." How it does that — WebGL,
   DOM, WebGPU — is entirely the compositor's business. `ThreeCompositor` is the
   spectacle one. Swapping it is **one line** in `packages/ui/src/main.ts`.

3. **Modules** (`packages/ui/src/modules/`) — the unit of everything. An app, a theme, a
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

That projection is written into a single `transform` per panel per frame rather
than into `left`/`top`. Writing those forces a layout pass per panel per frame,
each one behind a 14px `backdrop-filter` — a transform is composited, so the
overlay stops touching layout at all.

### Windows that stop floating

A panel is a rectangle projected from a point in space, which is lovely and also
means it can never be exactly the size of your screen: there is no distance at
which "as big as the viewport" is a stable answer, because looking around
changes it. So a window that fills the screen **stops being projected**. It is
laid out in screen space instead — the same trick pinning already used — while
its 3D anchor sits untouched underneath, so putting it back is a restore rather
than a re-placement.

Double-click a title bar or hit **□** to fill the screen; drag a title bar
against the top edge to fill, or against a side to take that half. Dragging a
snapped window tears it off and hands it back at its old size, under the cursor.
Only lone windows snap — a constellation travels as one object, and snapping a
member would silently tear it out of its group.

### Reaching a window without the mouse

Two ways, because "where is that thing" has two shapes.

**⌘/ctrl + `** steps through the open windows and turns the void to face each
one; shift walks back. Deliberately a stable order rather than most-recently-
used: in a place where windows have *positions*, an order you can walk in both
directions is easier to predict than a stack that reshuffles itself every time
you look at something.

**⌘/ctrl + shift + E** is the overview — every window flies into a grid facing
you, and clicking one takes you there. `arrange` has fanned windows into
formations for a while, but it is a permanent re-layout, which is why nobody
used it to *find* anything: looking cost you the arrangement you had. Every
anchor is remembered on the way in and restored on the way out, so this is a
look rather than a decision. Escape puts everything back.

Snapped and pinned windows sit the overview out. They are already on the glass
and fully visible, and dragging them into the world to show them to you would be
undoing the thing you asked them to do.

### Stacking

Windows stack in **bands**: floating, then snapped, then pinned. Inside a band,
depth decides — a near panel occludes a far one — and focus adds a bump smaller
than the gap between bands. That bump is what makes clicking a window raise it,
which distance alone could never express: two overlapping panels used to be
ranked by their distance to the camera forever, and the nearer one won even when
you were working in the other.

The bands also fix pinning. Pinned panels sat at a flat `z-index: 90000` while
floating ones scored `100000 - distance` — around 97,800 to 99,500 — so "pin to
screen" quietly put a window *behind* the void it was meant to stick in front of.

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

Everything written through `ctx.state` (except the `tmp.` namespace) is part of
the workspace the server holds for your account. That single mechanism is the
whole persistence story: settings, launcher bindings, saved dashboards, notes
and window layout all ride on it for free — and because it follows the account
rather than the browser, the same key on another machine is the same dashboard.

## Constellations

A dashboard is several windows that agree to be one thing. Drag any member and
the whole group travels; light threads draw between them; the compass reports
them once, by name. Bind them with the **⁙** handle or from the Dashboards app,
and save the arrangement — a saved dashboard is just a name and a list of apps,
so it survives a reload and re-assembles itself on demand.

**The thread is a control.** Click one to harden or loosen that bond, or use the
window menu. A hard bond *translates*: every member moves by the same vector, so
the formation keeps its shape and members nearer the camera grow as it travels.
A loose one *rotates* the formation about the camera instead, holding every
member's distance — and so its size — exactly constant. A loose thread is drawn
dashed and says so on its label, because that difference is worth seeing without
having to drag the thing to find out.

Firmness is per-constellation. It used to be one global setting, which made it a
property of the whole void rather than of a particular group; the setting now
seeds the default for new constellations and a bond you hardened stays hardened.

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

Register it in `packages/ui/src/main.ts` with `kernel.register(hello)` and it appears in the
launcher, the app drawer and the command palette — no other file changes.

### The syscall surface (`KernelContext`)

Everything a module can do, deliberately small:

- `emit` / `on` — the OS's IPC
- `state.get/set/subscribe` — shared memory, persisted
- `fs.*` — the filesystem (see below)
- `openSurface` / `closeSurface` / `openSurfaces` / `focusSurface` / `setTitle`
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
same idea at different depths. The power lock screen is **honest about what it
is** — it has no password, because a passphrase checked in client-side
JavaScript against a value the client also holds protects nothing and would
imply otherwise. It's a screen you can leave up, which is the part that's
actually useful in a tab. The credential that does mean something is your
account key, and that one is checked on the server.

Autostart runs on every boot, restored session or not — that's what makes it
autostart rather than a second session file. The singleton guard means anything
the restore already re-opened gets refocused, not cloned.

### What a session actually remembers

A layout used to come back as the right *apps* in the right *places*, which is
less than it sounds. It recorded which module had been running and not what that
module was holding, so a restored editor reopened **empty** — and two editors on
two files were worse, because the second launch hit the singleton guard and
simply refocused the first, losing a window outright. Constellations vanished
too: the shape survived and the thing that made it one object did not.

A session now writes down each window's launch arguments, its title, whether it
was collapsed, and which constellation it belonged to — by index, since group
ids are minted per session and mean nothing on the next boot. Sessions written
in the old shape are a bare array and still restore, because dropping a layout
on the first boot after an upgrade is a worse bug than the one being fixed.

### Closing a window is undoable

`rm` has been recoverable for a while; closing a window was final, even though
the kernel knows exactly which module owned it, what it was launched with, and
where it floated. **⌘/ctrl + shift + T** brings back the last one, in its place,
holding what it held. The ring is twelve deep and lives in memory — this is an
undo for the last few seconds, not a second session file.

## Notices

`ctx.notify()` is how anything in the system says something, and for a while it
could only say it *once, briefly*: every notice expired after 2.6 seconds
whatever it was, nothing could be dismissed early, and nothing could be acted
on. Warnings were the worst case — the system told you something was wrong, gave
you no way to do anything about it, and then took the message away.

A notice can now carry a single offer:

```ts
ctx.notify(`window limit reached (${MAX_SURFACES})`, {
  kind: "warn",
  action: { label: "see every window", run: (c) => c.expose(true) },
});
```

Warnings and anything carrying an offer stay until dismissed; routine chatter
still expires. Hovering pauses the countdown, because reading a notice should
not be a race against it. The stack cap that stops a chatty module wallpapering
the screen only evicts the expiring ones — a notice somebody asked to keep isn't
chatter.

Two places use it so far: the window limit, which used to be a dead end (a
warning, and no route from there to the window you would have closed), and being
signed out elsewhere, which is the one save failure retrying cannot fix and so
the one that has to offer a way back in.

## The status bar

voidshell deliberately has no taskbar. But "no taskbar" had quietly become "no
persistent chrome at all", and that was most of why the place didn't read as an
OS: no clock, nothing saying who you were, and no evidence anything was running
once every window was closed.

The status bar lists no windows and launches nothing off a strip, so it isn't a
taskbar by the back door. It answers *who, when, how long, how much* — and hosts
the notice bell. Turn it off in Settings › System.

## The filesystem

`packages/ui/src/kernel/vfs.ts` is a single tree assembled from mounts, reached by modules
through `ctx.fs`. Five mounts ship:

| mount | mode | backing |
| --- | --- | --- |
| `/home/void` | read-write | your account's workspace, on the server |
| `/projects` | read-only | scan of a project folder you choose (see below) |
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
shell's bookkeeping, not your documents — and `ls -a` still shows them (the file
list has a "show dotfiles" toggle in its sort menu).

There is a **Trash app**, because everything above was reachable only by typing.
It lists what you deleted, where each thing came from, and when — the manifest,
which no plain listing of `~/.Trash` can show — with **put back** per item and a
two-click **empty trash**. Deleting anything now raises a notice carrying an
**undo** button, rather than a sentence telling you to go and type
`restore note.md` in a console you may not have open.

Permissions live on the *node*, not on a path prefix, so a mount carries its own
rules wherever it's grafted in. Writing to `/projects` fails with `EROFS` the way
a real read-only mount does, rather than silently no-op'ing.

### How `/projects` gets there

`packages/ui/plugins/projects.ts` is a Vite plugin with two modes behind one API:

- **dev** — serves a live scan at `/__vs/projects.json`, so editing a file on
  disk shows up in the shell on reload.
- **build** — freezes the same scan into the bundle, because the deployed site
  is static and has no disk to read.

Text files are embedded whole under a 128KB cap. Binaries are indexed by name
and size but never embedded — that's what keeps a 27MB asset folder from
becoming a 27MB download. Classification is a binary-extension *denylist*, not a
text allowlist, so unguessable text files (`.firebaserc`, `.gql`) stay readable;
a NUL-byte check catches anything mislabeled.

### Choosing the folder

The root used to be `path.resolve(uiDir, "../../..")` — the directory holding
the checkout. That is not a hard-coded *path*, but it is a hard-coded
*assumption*, and it has the same effect: right when voidshell happens to sit
beside the repos you want mounted, silently wrong when it doesn't, with nothing
reporting the difference. `/projects` was simply whatever was next door on that
machine, which is why the mount changed shape depending on which computer you
sat down at.

The location is now something you state. Three sources, first hit wins:

1. `VOIDSHELL_PROJECTS_ROOT` in the environment — also picked up from
   `.env.local`, which is the one of the two that survives a reboot:

   ```bash
   VOIDSHELL_PROJECTS_ROOT=~/code npm run dev
   ```

2. `projectsRoot` in `voidshell.local.json` at the repo root — gitignored,
   per-machine, and what the in-shell setting writes to:

   ```json
   { "projectsRoot": "~/code" }
   ```

3. The directory containing the checkout, as before, so an untouched clone
   behaves exactly as it always did.

`~` expands on both routes. People write `~/code` in a JSON file and reasonably
expect it to mean something, and a JSON file has no shell to do it for them.
Relative paths resolve against the checkout rather than the working directory,
so `npm run dev` gives the same answer whichever folder you run it from.

A root that doesn't exist warns and skips the mount rather than crashing the
dev server, and a build that finds zero projects warns with the name of the
setting to change — an empty `/projects` that says nothing is the failure this
exists to prevent.

**Settings › System › Projects folder** does the same from inside the shell. It
writes `voidshell.local.json` and offers a reload, because `/projects` is
mounted once during boot and the tree already on screen is still the old one. In
a production build it degrades to a read-only report of the root the bundle was
frozen with: the endpoint behind it is dev-only by the same construction as the
host bridge.

### Files: browsing and typing over one directory

Browsing and typing are the same activity, so they share a window and a working
directory. Click into a folder and the prompt follows; `cd` and the list
follows; click a place in the sidebar and both go there. The divider between the
panes is draggable, and its position persists.

The app is called **Files** now. It was called "Workspace", which is also the
name of the account state the server persists (`WorkspaceSnapshot`,
`ApiWorkspaceHost`) — two unrelated things under one word, in a system where one
of them is a file manager.

A sidebar of **places** — Home, Desktop, Notes, Trash — sits beside a list of
**volumes** read from the mount table, so a filesystem grafted in later appears
without this being edited. Dropping a file onto a place moves it there; dropping
onto Trash deletes it.

The list does what a file list is expected to do: sort by kind, name, size or
date; select more than one thing with shift and ctrl; arrow keys, Enter to open,
Backspace to go up, Delete to trash, F2 to rename, ⌘A, ⌘I for info, and
type-ahead. The filter box searches the whole subtree below the current
directory, bounded so typing into it can't freeze on /projects. Every row says
what kind of file it is, when it changed, and how big it is.

The path bar is a row of clickable crumbs and a drop target — dragging a file
onto an ancestor moves it up the tree.

The console is a real shell over that FS: `cd` / `ls -la` / `cat` / `tree` /
`find`, plus `mkdir`, `rm`, `mv`, `touch`, `df`, `mount` and `history`. It holds
no privileges the syscall surface doesn't already grant every module.

### One file menu, everywhere a file appears

The desktop and the file list each grew their own right-click menu and they had
already disagreed — different verbs, different spellings for the same operation,
"Run" on one and not the other. `packages/ui/src/ui/fileMenu.ts` builds it once;
callers pass only what genuinely differs (the desktop remembers icon positions,
the list knows its working directory).

It carries **Open**, **Open With ›**, **Run**, **Reveal in Files**, copy/cut/
paste, **Rename**, **Get Info**, and **Move to Trash**. "New ›" offers a folder
or any of the file templates in `kernel/filetypes.ts`, instead of the single
`untitled.md` guess that taught you to create the wrong thing and rename it.

**Get Info** is a panel with what `stat` has always known and nothing could
show: kind, size, when it changed, whether it's writable, and which mount it is
on — the fact that explains why /projects won't save.

### What a file *is*, in one place

`kernel/filetypes.ts` maps an extension to a glyph, a label and a family. There
used to be three answers to "what does a .py look like": a table in the desktop,
a bare dot in the file list, and nothing anywhere else — so the file manager drew
every file identically. One table, four surfaces: desktop icons, file rows, the
trash, and the editor's start pane.

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
| drag any edge or corner | resize from that side |
| `Delete` / `Enter` | delete or open the selected icon |

Resizing accounts for the 3D projection: a drag of N screen pixels is N/scale
*logical* pixels, since panels are drawn smaller with distance. There is a grip
on every edge and corner, because a panel that is the right width but the wrong
height is the common case, and a corner-only grip makes you fight whichever
dimension was already correct.

It also has to move the window. A panel is *centred* on its anchor — drawn with
`translate(-50%, -50%)` about a projected point — so widening it pushes both
edges outward by half the change. Writing the new width alone therefore made the
grip travel at half the speed of the cursor and dragged the opposite edge along
with it. Every resize walks the anchor half a delta the other way, which pins
the edge you aren't holding and lets the one you are holding track the pointer.

Dragging *out of* `/projects` copies rather than moves — the source is a
read-only mount, and a move would fail with `EROFS` the user can do nothing
about.

### Windows are named after what they hold

A title used to be fixed at open. That's fine for an app that is only ever
itself, and wrong for every app that holds a *document*: the editor's title went
stale the moment you opened a second file into it, the file manager never said
which directory you were in, and the browser claimed to be "portal" whatever
page it was showing — which tells you nothing at all when three of them are
floating in the void.

`ctx.setTitle(surfaceId, title)` renames a live window. The kernel holds the
authoritative title and the compositor draws it, so the title bar, the compass
and the command palette all follow from one call. The editor marks unsaved work
with a leading `•`, the Workspace shows its working directory, and Portal is
named after the page it is showing.

### Apps, associations, and arguments

`launch(id, args)` is the OS's exec: modules receive `args.path` the way a
program receives argv. A module declares what it opens via `handles`, and
`ctx.openPath(p)` routes to whichever one claims the extension — `"dir"` goes to
Files. Adding a viewer for a new filetype is one array entry, not a change to
the desktop.

Three rules decide the winner, in `packages/ui/src/kernel/assoc.ts`:

1. **your choice** — "Open With → always open markdown here…" writes `assoc.md`
   into the store, and that beats everything below.
2. **whoever named the extension**, highest `priority` first.
3. **`fallback: true`**, for unclaimed *text* only.

That third rule replaced `handles: ["*"]`, which claimed PNGs and ZIPs as well
as text — so "open with the editor" used to be offered for files it can only
render as a screenful of replacement characters. Binary types now get no text
fallback at all, and `openPath` says *nothing opens .png files* rather than
opening an empty editor.

Registration order no longer decides anything. It used to: `main.ts` carried a
comment explaining that the file manager had to be registered before the editor
or directories would open in a textarea, which is a landmine dressed as a
comment.

`ctx.handlersFor(path)` returns every candidate, best first — that's the
"Open With" menu — and `ctx.openWith(path, id)` ignores the table entirely.

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
`Cross-Origin-Embedder-Policy: credentialless`, set in `packages/ui/vite.config.ts` for dev
and in the `Caddyfile` for production. Without those headers everything else
still works; only stdin degrades, with an explanation rather than a hang.

`credentialless` rather than `require-corp` in **both** places. Both grant
SharedArrayBuffer, but `require-corp` additionally hard-blocks every
cross-origin asset that omits `Cross-Origin-Resource-Policy` — which is
essentially the whole web, including anything Portal tries to frame.
`credentialless` loads those without credentials instead. Dev and production
disagreed on this for a while, which meant framing worked locally and failed
once deployed.

## The browser

Portal is a web browser: tabs that keep their pages alive, an address bar that
searches when you don't give it a URL, real back/forward, and bookmarks. `browse
<url|query>` opens it from the console.

The honest part is what stands between an iframe and the open web. **A browser
refuses to frame any document whose server sends `X-Frame-Options` or a CSP
`frame-ancestors`,** and Google, YouTube, GitHub and every major search engine
send one. No client-side code defeats that — the enforcement is in the browser,
not the page. The only way to embed those is to be the one serving the response.

So there are two modes, and the pane says which one it's in:

| mode | when | what happens |
| --- | --- | --- |
| **proxied** | dev | the host bridge serves the site from a local port with those headers stripped — effectively everything loads |
| **direct** | production, or no bridge | the iframe points at the site; framable sites work, the rest render blank and say so |

**One proxy port per origin**, for the same reason the app proxy uses one per
port: a page's absolute URLs (`/w/load.php`, `/static/app.js`) resolve against
the origin root, so serving Wikipedia at the root of its own port is what makes
them resolve back through the proxy. Cross-origin redirects — `http`→`https`,
bare→`www` — are rewritten to a proxy port for the new origin, so a redirect
can't quietly bounce you out to the blocked original.

**The framed page reports its own navigation.** A cross-origin frame's location
is unreadable, so clicking a link would leave the address bar stale forever.
Since the proxy serves the bytes, it injects a few lines into `<head>` that
`postMessage` the real URL on load, `popstate`, `hashchange` and both history
methods — which is what makes back/forward and the address bar behave like a
browser's rather than like a bookmark list. That injection is also why the proxy
requests `identity` encoding: rewriting a gzipped body would mean gunzipping it.

Frames are sandboxed (`allow-scripts allow-forms allow-same-origin`), so a page
can script and navigate itself but can't reach the shell.

Bookmarks live at `~/.bookmarks` as `url<tab>title`, because a file can be
grepped, piped and edited and a store key can't.

**Dev-only, by construction.** `packages/ui/plugins/host.ts` is `apply: "serve"`, so the
proxy does not exist in a production build. While the dev server runs it is a
general-purpose web proxy bound to `127.0.0.1`, capped at 24 origins, and framed
sites lose their clickjacking protection *inside the shell* — that is the trade
being made for being able to embed them at all.

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
page. `packages/ui/plugins/host.ts` runs inside the Vite dev server: it spawns children,
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

## Two renderers

This section used to be an instruction: *write a `DomCompositor`, swap it in
for `new ThreeCompositor()`, and every module renders unchanged in a 2D world.*
That was a claim about an interface with exactly one implementation, which is
another way of saying it was a description of `ThreeCompositor` written in the
optative mood. There are two now.

| | `three-projected` | `dom-flat` |
| --- | --- | --- |
| world | an infinite sphere you turn inside | an infinite plane you pan over |
| draws | WebGL nebula, dust, celestial bodies | a gradient and a grid |
| depth | distance from the camera, panels scale with it | stacking order; zoom is global |
| bodies | suns, moons, planets, singularities | none — `spawnBody` returns `""` |
| needs | a working GPU context | nothing |

**Try it: [`?compositor=dom`](https://mrfr3nchy.github.io/voidshell/?compositor=dom).**
Same shell, same windows, same files, flat.

### What the second one proved

Everything shared between them was already written to know nothing about 3D,
and it turns out those files meant it. `createPanelChrome`, `panelMenuItems`,
`TetherLayer`, `Compass`, the window shapes and the context menu are used by
both backends **unchanged** — so a flat window has the same title bar, the same
right-click menu, the same silhouettes and the same constellation threads,
because it is literally the same code. Exactly one thing had to move:
`closeSurfaceById`, four lines, private to the Three backend and needed by
both.

Nothing in `modules/` changed. Not one line.

### Choosing one

`?compositor=dom` in the URL beats a saved preference, which beats a WebGL
probe. That last one is the point of the whole exercise: a void that needs a
GPU context is a black rectangle on a locked-down laptop, in a VM with no
passthrough, over a remote desktop, on driver-blocklisted Android, and in every
headless browser. When the probe fails, the shell opens flat and says so,
rather than opening a void you cannot see.

Settings → World → **render backend** makes it stick. It takes effect on
reload, because the compositor is chosen once before the kernel is built —
which the setting says, with a reload button, rather than in a footnote.

### Writing a third

The optional methods (`linkSurfaces`, `lookAtSurface`, `arrange`…) degrade to
no-ops, so a minimal backend is genuinely minimal. `spawnBody` returning `""`
is the contract's own word for "this world has no such thing", and every caller
in the kernel already treats it that way. `tools/dom-compositor-checks.mts` is
the shape of a test for one: it asserts the contract — snapshots round-trip,
the overview is reversible, the unsupported half declines honestly — in jsdom,
with no browser.

## The apps that come with it

Beyond the world toys and the arcade, the set a desktop is expected to have:

| app | what it is |
| --- | --- |
| **Files** | the file manager and the console, over one directory |
| **Editor** | write, preview and run text; the fallback opener |
| **Notes** | Markdown files in `~/notes` — nothing more |
| **Trash** | what you deleted, where it came from, and how to get it back |
| **Calculator** | a tape you type expressions into |
| **Calendar** | a month, and a journal entry per day |
| **Timer** | countdown and stopwatch |
| **Portal** | a web browser |
| **Dev Server** | frames a dev server the host bridge is running |
| **Cartograph** | build a world, then go and fly through it |
| **Pawnageddon** | chess, until the chaos deck gets involved |
| **Settings** | every knob, from every module |

Two of those used to be windows that did nothing when opened on their own.
**Editor** with no file said "No file. Open one from the desktop or the
Workspace" — an app whose answer to being launched is to name two other apps.
It opens a start pane now: what you had open recently, what's in your home
directory, a search box, and a new-file line. **Dev Server** (which was called
"Web App") said "No port." It now asks the host what is actually running and
lists it, and where there is no host bridge — every deployed build — it says
*that*, instead of describing a console command that would also fail.

### Cartograph: water, and a city

A map is thirteen numbers and a seed. The generator invents a continent from
them; a *hydrology* pass then rains on it, and everything interesting follows
from what the water does. Droplet erosion carves the valley network — branching
drainage is not modelled anywhere, it falls out of following each drop
downhill. A priority flood fills what is left, and whatever holds water is a
lake. D8 accumulation routes the flow, and where enough of it gathers is a
river, which is then *cut into the ground* rather than painted on it, because
water running along the outside of a hillside is something the eye catches
instantly even when it cannot say why.

Sea, lakes and rivers are one surface and one mesh. That is the point of doing
it this way: the old build had a single flat plane at sea level, which can draw
an ocean and by construction cannot draw a lake — a lake is above sea level —
or a river, which is neither flat nor level.

**The maps are not blurry any more**, and the reason is worth knowing if you
write another canvas app for this shell. The compositor projects each floating
panel from a point in space and writes the result as a CSS `scale()` between
0.35 and 1.6. A canvas sized to its own `clientWidth` therefore renders at
layout size and is then *stretched* by whatever the panel's depth implies — at
the far end, a 62%-resolution image blown up. The sky view sizes its drawing
buffer by the element's real on-screen scale instead, read back from its
bounding rect. Everything else is downstream of that: the terrain is a baked
colour, normal and AO/roughness set at up to 4096², synthesised between the
field's samples rather than generated at that size, since a river is in the
same valley whether you sampled it 192 or 2048 times.

**Pure view** takes the live canvas out of the window entirely and puts it on
the glass — chromeless, above the pinned band, at true device resolution
because nothing is scaling it. Escape steps out one level at a time,
fullscreen → widget → back in the window. **Fly** swaps the orbit camera for
WASD, Q/E for down and up, shift to sprint, drag to look and the wheel as a
throttle. Fly mode swallows exactly the keys it uses, so rising does not also
summon the launcher ring.

**New York** ships in the library. It is a hand-authored reconstruction, not
data: the coastlines were written from knowledge of the place as longitude and
latitude, and the sixteen landmark towers stand at their real coordinates at
their real architectural heights — One World Trade at 541m, the Empire State
at 443m. Everything between them is generated from a street grid, including
Manhattan's 29°-off-north Commissioners' grid and its 3.4:1 blocks. It is
accurate to a few hundred metres on the shore and invented everywhere else;
Newark Bay and the Hackensack are simply absent rather than badly
approximated. If you want the real geometry, the import button reads a
greyscale heightmap and that is the honest way in.

### Notes are files

Notes used to live in the settings store under `notes.doc.<id>` keys. It worked,
and it made the one app whose whole job is holding your text the one place in
the shell you could not `cat`, `grep`, back up, open in the editor, or see in
the file manager — while `~/notes` sat empty from the day the VFS created it.

A note is a Markdown file in `~/notes` now, and everything follows for free: the
desktop can hold one, the editor opens one, the trash catches one you delete by
mistake, and the calendar writes one per day into `~/notes/journal`. Existing
notes are migrated into files on first boot and the old keys are left alone —
tidying up a storage model is not a reason to lose what somebody wrote.

### Markdown, rendered

The editor previews `.md` (⌘P, or the button), and read-only Markdown — every
README under `/projects`, the welcome file — opens rendered. The renderer is
~200 lines in `modules/editor/markdown.ts` rather than a dependency, and it
builds nodes with `textContent`; it never touches `innerHTML`. That is not
belt-and-braces: the files it renders come from a scan of whatever is on the
machine's disk, so "the input is trusted" is not a claim anyone should make
about it.

## What's next

- Constellation *layouts* — remembering relative positions, not just membership.
- Multi-user: the store is already the only source of truth worth syncing.
- Syntax highlighting in the file viewer (the language is already detected).
- Multi-select on the *desktop* (marquee drag, shift-click). The file list has
  it; desktop icons are still one at a time.
- Undo for *edits*. Deletions are recoverable from the trash now, but a bad
  `mv` or a clobbering `>` still isn't.
- Per-module permissions. Every module currently gets the whole syscall surface;
  a manifest that declares what it needs is the obvious next tightening, and the
  process table is the thing that would enforce it.
- Multi-line file writing from the shell (`write` joins its arguments with
  spaces, so use the editor for anything with real line breaks).
- Running the web projects in-shell — iframe-based `render()` for `hero-nexus`
  and `stonks-surplus`, which currently browse as source only.
- Portal's history is per-tab and in-memory; it isn't written down, so a reload
  loses it. Bookmarks persist, history doesn't.
