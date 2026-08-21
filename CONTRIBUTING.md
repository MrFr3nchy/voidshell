# Contributing

The short version: **add a module, don't edit the shell.** Almost everything
worth building here is a module, and the kernel is designed so that adding one
never means touching anything else. If a change has you editing the settings
app, the launcher, or `main.ts`, that is usually the signal that the seam you
want already exists somewhere else.

## Getting it running

```bash
npm install
npx voidshell dev        # API on :3000, client on :5173, one Ctrl-C stops both
```

`npm run dev` starts the client alone, which gets you a lock screen and nothing
behind it — dashboards live on the server. `npx voidshell dev --fresh` empties
the throwaway database in `.voidshell-dev/`.

## Before you open a PR

CI runs all of this, and it is faster to find out locally:

```bash
npm run typecheck
npm run build
```

Then the headless harnesses. They boot the real kernel against a stub
compositor, so they catch a surprising amount for something with no browser in
it — the two commands are in the header of `tools/smoke.mts`, and the rest of
`tools/` follows the same pattern.

## The four rules CI enforces literally

These are `grep` over comment-stripped source, not lint rules, because a guard
clever enough to be worded around is a guard people learn to word around. They
fail the build with no suggestion, so they are written down here instead.

**No browser storage in `packages/ui/src`.** No `localStorage`,
`sessionStorage` or `indexedDB`. A dashboard that lives in the browser is a
dashboard that doesn't follow the account, which is the entire point of the
server. Use `ctx.state` — it is persisted for you.

**No `new AudioContext`.** Use `ctx.audio`. Browsers cap how many contexts a
page may hold and the failure is silent, so "every module makes its own" was
never a matter of taste.

**Modules never import `Kernel`.** Everything arrives through the `ctx` handed
to `activate`. The capability fence in `kernel/caps.ts` is only a fence if
nothing else hands out an unfenced context.

**Generated files stay current.** The stock modules are compiled into
`modules/stock.generated.ts` at build time; `node emit.mjs --check` fails if the
committed copy has drifted from its source. Run `tools/emit-modules.mts` after
touching one.

## Writing a module

The whole contract is `packages/ui/src/kernel/types.ts`, and
[docs/MODULE-SDK.md](docs/MODULE-SDK.md) explains it. The parts that bite:

- **`activate` returns its own undo.** A module that leaks its listeners is
  invisible until it is unloaded and its handlers keep firing against a dead
  context. Same for the function `render` returns.
- **Modules import nothing** — not the kernel, not each other. Two modules that
  need to cooperate do it over the event bus or through shared state, and that
  restraint is what lets any one of them be deleted without the rest noticing.
- **Retitle when the document changes.** `ctx.setTitle` feeds the title bar, the
  compass and the command palette at once; an app that holds a file and never
  calls it goes stale in all three.
- **A warning without an offer to fix it is a bug.** `ctx.notify` takes an
  action. If you can say what went wrong, you can usually give the user a button.
- **Never hardcode a colour.** `ctx.stage.palette()` reads the live theme.

You do not have to compile a module in to try one. Write it to `~/modules/x.ts`
inside the shell and load it from devkit — that is how the nineteen stock
modules ship, and nothing distinguishes them from yours once they are planted.

## Style

Match what is already there. The house style is that **comments explain why, not
what** — the interesting content of this codebase is the reasoning, and a
comment restating the line under it is worse than none. Several of the best
comments in here exist because something was tried, failed in a way that looked
like something else, and the note is what stops the next person retrying it.

Commit messages are lowercase, scoped, and say what changed:
`kernel: drop a dead branch in grantsFor`.

## What gets a change rejected

Reaching around the module contract into `Kernel`, `ThreeCompositor` or another
module's internals. Everything else is negotiable.
