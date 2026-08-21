# Module permissions

Companion to [`MODULE-SDK.md`](./MODULE-SDK.md). That document describes the
syscall surface; this one describes how much of it a given module gets.

## The one-paragraph version

A module's manifest may declare `permissions`. If it does, that list is the
whole of what the kernel will let it do, and every other syscall throws a
`CapabilityError` naming the permission it would have needed. If it declares
nothing, it is trusted — exactly as before capabilities existed — unless the
user turns on **Settings › System › Fence modules that ask for nothing**.
Modules compiled into the shell are never fenced.

**A module that was fetched from a URL is the exception, and never gets that
benefit of the doubt.** With no declaration it is held to `surface` whatever
that setting says. See [Fetched modules](#fetched-modules).

```ts
export default {
  manifest: {
    id: "notekeeper",
    name: "notekeeper",
    kind: "app",
    permissions: ["surface", "fs.read", "fs.write"],
  },
  activate() {},
  launch(ctx) {
    ctx.openSurface({ title: "notes", render: (root) => { /* … */ } });
  },
};
```

Read the live state with `cat /proc/permissions`.

## What this is not

**This is not a sandbox.** A module is ordinary JavaScript running on the page.
It can call `fetch`, touch `document`, read globals, and do anything else the
browser gives a script. Nothing in `caps.ts` changes that, and no amount of
declaring `permissions: []` makes a module safe to run blind.

What it *does* fence is the kernel: the filesystem, the window table, the
process table, the settings and command registries, and the privileged half of
the event bus. That is the part holding your files, and the part a module has
no other route to. Fencing the rest means moving modules into an iframe or a
worker, which is a real and much larger change.

The distinction matters when deciding whether to load something. A declared
permission list tells you what a module *intends*, and stops an honest module
from doing damage by accident. It is not a containment boundary for something
actively hostile.

## The capabilities

| Capability | Covers |
| --- | --- |
| `fs.read` | `ls` `read` `stat` `exists` `isDir` `usage` `mounts` `onChange` |
| `fs.write` | `write` `mkdir` `mkdirp` `rm` `mv` |
| `state.write` | `state.set` |
| `surface` | `openSurface` `closeSurface` `setTitle` `openSurfaces` `focusSurface` `activeSurface` `expose` `lookAt` `lookAtGroup` `resetView` `mountAnchored` |
| `world` | `patchWorld` `spawnBody` `destroyBody` `attachSurface` `listBodies` `linkSurfaces` `unlinkGroup` `listGroups` `arrange` |
| `launch` | `launch` `launchAt` `openPath` `openWith` `setDefaultApp` |
| `process` | `kill` |
| `shell` | `defineSetting` `defineCommand` `notify`, and emitting `shell.*` / `system.*` events |

Most apps want `["surface"]` and nothing else. An app that opens documents wants
`["surface", "fs.read", "fs.write"]`. A world module wants `["world"]`. If you
find yourself asking for all eight, you are probably writing shell furniture,
which belongs in the build rather than in `~/modules`.

## What is never gated

Deliberately open to every module, including one granted nothing:

- `on` and `state.subscribe` — listening reveals nothing a module could not
  infer anyway, and a module that cannot listen cannot cooperate with anything.
- `emit`, for any event that is not `shell.*` or `system.*`. Modules talk to
  each other over the bus; gating that would gate the platform's own IPC.
- `state.get`. The store is one flat namespace, so gating reads would also stop
  a module reading back **its own** keys. This is a real hole: treat the store
  as world-readable and don't put secrets in it.
- `ps`, `journal`, `log`, `uptime`, `stats`, `registry`, `settings`, `commands`,
  `handlersFor`, `focalPoint`, `screenToWorld` — all read-only, and most are
  already readable as files under `/proc`. Refusing them here while `cat`
  allows them would be a fence with a gate next to it.
- `stage` and `audio`. Browser primitives with no access to anything of yours.

## Details worth knowing

**Omitted is not the same as `[]`.** No `permissions` key means "trusted", which
is what every manifest written before this existed says by saying nothing.
`permissions: []` is a module actively claiming it needs nothing, and the kernel
holds it to that claim in every mode.

**Fetched modules are held to the safe default.** <a id="fetched-modules"></a>
"Declared nothing, so trusted" is a defensible default for a file you wrote and
an indefensible one for a file you downloaded. The kernel records where a
runtime module's source came from, and having an origin at all is what stops an
absent `permissions` list meaning "trusted" — see `Kernel.grantsFor`. This is
*not* reachable by leaving the strict-mode setting off, because that setting is
about the code you wrote.

An origin decides what an **absent** list means. It does not override one that
is present: a fetched module that declares `["surface", "fs.read"]` gets exactly
that, or fetching one would make its manifest meaningless.

The practical consequence is worth stating rather than discovering. Most modules
publish a setting or a command in `activate`, which needs `shell` — so a fetched
module that declared nothing does not merely run with less, it **refuses to
install**, with an error naming the capability and where to add it. That is the
intended pressure: a module meant to be shared should say what it needs.

`/proc/permissions` labels such a module `fetched` and prints the URL under it,
because a fence whose reason cannot be seen is one people work around.

**A typo throws at install.** `["fs.reed"]` fails loudly rather than quietly
becoming "no permission" — an author who believes they are protected by
something misspelled is worse off than one who declared nothing.

**Grants resolve per call.** A module keeps the context it was activated with
for its whole life, so grants are re-read on every syscall rather than captured
when the context is built. Turning strict mode on takes effect immediately, for
modules already running, without a reload.

**Refusals are visible.** The first denial per capability per context is written
to the journal at `warn` and raised as a notice. Repeats are suppressed, so a
module in a loop cannot storm the HUD.

**Uninstalling drops the grant.** Otherwise the next module to claim that id
would inherit permissions its own manifest never asked for.

## Reading the current state

```
cat /proc/permissions
```

```
MODULE        ORIGIN    ALLOWED
editor        built-in  unrestricted
devkit        built-in  unrestricted
lavalamp      runtime   unrestricted (declared nothing)
notekeeper    runtime   fs.read fs.write surface
```

`built-in` means the shell was compiled with it. `runtime` means devkit loaded
it from a file, and it is the only kind that can be fenced or uninstalled.

## Where the code is

- `packages/ui/src/kernel/caps.ts` — the capability list, `restrict()`, and the
  `/proc/permissions` renderer.
- `packages/ui/src/kernel/Kernel.ts` — `grantsFor()` decides policy;
  `context()` applies it; `install()` parses the manifest.
- `tools/caps-checks.mts` — headless checks, including an explicit assertion of
  everything that is *not* gated.

Adding a syscall to `KernelContext` means deciding which capability it falls
under. `restrict()` is written out by hand rather than as a `Proxy` precisely so
that this decision cannot be skipped: a new syscall that nobody classified fails
the typecheck instead of shipping ungated.
