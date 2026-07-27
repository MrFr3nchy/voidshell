# Project apps

voidshell does not run your projects. It launches their **artifacts**.

Each catalogued project is a separate repository that compiles to static web
output. CI builds it into `public/apps/<id>/`, Vite copies that verbatim into
`dist/`, and a generated module frames it in a panel. From inside the shell it
is indistinguishable from the app "running" — but there is no process anywhere,
which is exactly why it survives a static deploy and costs nothing to host.

## Why not just spawn `npm run dev` remotely?

That is what `plugins/host.ts` does, and it is `apply: "serve"` on purpose. It
POSTs a string into `spawn(cmd, { shell: true })`. On a developer's machine
that is a convenience; reachable from the internet it is remote code execution
with a nice UI. A static deploy also has no Node process to spawn anything
with. The bridge stays local, permanently.

## How it fits together

```
src/apps/catalog.json        one entry per project — the single source of truth
  │
  ├─► src/apps/catalog.ts     validates it, exports PROJECT_APPS
  │     └─► src/main.ts       registers one module per entry
  │           └─► createProjectApp — frames /apps/<id>/
  │
  └─► .github/workflows/build-apps.yml
        └─► public/apps/<id>/  built artifact, committed
```

Because each entry becomes a real module, projects appear in the radial
launcher, the All Apps drawer and `⌘K` alongside everything else. They are not
rows inside a "projects" browser.

## Adding a project

1. Add an entry to `src/apps/catalog.json`:

   ```json
   {
     "id": "my-game",
     "name": "My Game",
     "glyph": "◈",
     "blurb": "One line for the drawer",
     "repo": "MrFr3nchy/my-game",
     "builder": "vite",
     "width": 960,
     "height": 640
   }
   ```

2. Bump `MODULE_COUNT` in `tools/smoke.mts` — it is `28 + PROJECT_APPS.length`
   and computed for you, so this is automatic. Nothing else to touch.

3. Run **Actions → build project apps → Run workflow**. Leave `only` blank to
   build everything, or name one id to rebuild just that.

`builder` must be one of `vite` or `godot`. An unrecognised value is dropped at
load with a console warning rather than registering an app whose artifact will
never exist.

## One-time setup: `APPS_TOKEN`

Private project repos are invisible to the default `GITHUB_TOKEN`, which is
scoped to voidshell alone. Create a fine-grained PAT with **Contents: read** on
the project repos and save it as the `APPS_TOKEN` repository secret. Public-only
catalogues work without it.

## Per-project status

| Project | Stack | Status |
|---|---|---|
| **pawnageddon** | Vite + Phaser + React | ✅ catalogued, builds today |
| **ninja-run** | Godot 4.6 | ⚠️ catalogued, see below |
| **break-the-house** | Python, CLI | ⏸ needs a Pyodide runner — the shell already has the worker, it just isn't wired to a catalogue entry |
| **hero-nexus** | Next 15 + Firebase | ⏸ needs `output: "export"` in its own repo; Firebase is client-side so a static export is plausible |
| **stonks-surplus** | Next 16 + Prisma + Anthropic SDK | ❌ not static. A database and a server-held API key mean a real backend |
| **essense-game-night** | PHP | ❌ needs a server |
| **cyclone** | Rust, Linux mod manager | ☠️ hardlinks into Steam directories. Its purpose is mutating one specific machine. The web version is a remote control for an agent, which is a different project |

## Godot notes

Two things make a Godot web export fail silently, and CI handles both:

- **Renderer.** `ninja-run` is `Forward Plus`, which targets Vulkan. Browsers
  do not expose Vulkan. The workflow appends a
  `renderer/rendering_method.web="gl_compatibility"` platform override, leaving
  the desktop renderer alone. If the game leans on Forward+ features it will
  look different on the web; that is a game-side decision, not a CI one.
- **Export preset.** `export_presets.cfg` is normally gitignored, so the
  workflow synthesises a `Web` preset instead of requiring the game repo to
  carry CI config.

The version comes from `godotVersion` in the catalogue and must match a real
tag on `godotengine/godot` releases, or the download step 404s.

## Cross-origin isolation

Godot exports (and anything else using `SharedArrayBuffer`) need the document to
be cross-origin isolated. voidshell already sends `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: credentialless` — originally for
the Pyodide stdin worker, which happens to be the same entrance fee. Artifacts
are same-origin under `/apps/`, so they inherit it.

If a deploy drops those headers the module says so in the panel footer instead
of letting the engine die with an unreadable stack trace. See `DEPLOY.md`.

## Repository size

Built artifacts are committed, so the repo grows with every rebuild. The commit
job replaces each app directory wholesale rather than merging, which keeps the
tree clean but not the history. If this becomes uncomfortable, the options are
Git LFS or a dedicated artifact branch that App Platform builds from instead of
`main`.
