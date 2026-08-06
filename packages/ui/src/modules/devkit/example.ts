/**
 * The module that gets written into ~/modules on first run.
 *
 * Kept as a string rather than a `.js` file in the tree for one reason: it has
 * to survive the build. A real source file next to this one would be compiled
 * and bundled like everything else, and what devkit needs is the *text*.
 *
 * It is also the only documentation of the contract that cannot go stale — it
 * is loaded through exactly the path a hand-written module takes, so if the
 * shape of a module ever changes, the smoke harness stops passing.
 */
export const EXAMPLE_SOURCE = `/**
 * A module the shell was never built with.
 *
 * Edit this file, hit Reload in devkit, and the running system picks up the
 * change — no rebuild, no page refresh. Everything the app can do arrives
 * through \`ctx\`, which is the same syscall surface every built-in module gets.
 */

let clicks = 0;

export default {
  manifest: {
    id: "hello-void",
    name: "hello void",
    kind: "app",
    glyph: "◇",
    blurb: "a module loaded at runtime",
  },

  // Called once, when the module is installed. Register anything that should
  // exist whether or not a window is open. Return a function to undo it.
  activate(ctx) {
    ctx.log("hello-void activated");

    ctx.defineCommand({
      id: "hello.greet",
      label: "say hello",
      glyph: "◇",
      run: (c) => c.notify("hello from a module that was never compiled in", "good"),
    });

    return () => ctx.log("hello-void deactivated");
  },

  // Called when the user launches it.
  launch(ctx) {
    ctx.openSurface({
      title: "hello void",
      width: 300,
      height: 180,
      render: (root, c) => {
        root.style.cssText =
          "display:grid;place-content:center;gap:12px;height:100%;text-align:center;font:14px/1.5 var(--vs-font, monospace)";

        const label = document.createElement("div");
        label.style.opacity = "0.7";
        label.textContent = "loaded from ~/modules/hello.js";

        const button = document.createElement("button");
        button.textContent = "clicked 0 times";
        button.style.cssText =
          "padding:8px 14px;cursor:pointer;background:transparent;color:inherit;" +
          "border:1px solid currentColor;border-radius:6px;font:inherit";
        button.addEventListener("click", () => {
          clicks++;
          button.textContent = \`clicked \${clicks} time\${clicks === 1 ? "" : "s"}\`;
          if (clicks === 5) c.notify("you seem to like this button", "good");
        });

        root.append(label, button);

        // Returned cleanup runs when the window closes.
        return () => c.log("hello-void window closed");
      },
    });
  },
};
`;

/**
 * The TypeScript counterpart, seeded next to it.
 *
 * Not a translation for its own sake: the compile path is invisible until
 * something uses it, and "write a .ts file yourself and find out" is a worse
 * first experience than a file that is already there. It deliberately uses an
 * interface, a generic and a type-only construct, because those are exactly the
 * things that have to survive the round trip.
 *
 * The stray `: number` on a string would be a type error. It is not caught —
 * esbuild strips types without checking them — and the comment says so, because
 * the alternative is letting someone discover it at runtime and assume the
 * compiler was broken rather than absent.
 */
export const EXAMPLE_TS_SOURCE = `/**
 * A TypeScript module, compiled in the tab by esbuild-wasm.
 *
 * Types are STRIPPED, NOT CHECKED. There is no type checker here — a wrong
 * annotation compiles perfectly and fails later, or never. Interfaces and
 * generics are erased; everything else runs as written.
 */

interface Tally {
  label: string;
  count: number;
}

type Render<T> = (value: T) => string;

const describe: Render<Tally> = (t) =>
  \`\${t.label}: \${t.count} time\${t.count === 1 ? "" : "s"}\`;

const tally: Tally = { label: "clicked", count: 0 };

export default {
  manifest: {
    id: "hello-typed",
    name: "hello typed",
    kind: "app",
    glyph: "◈",
    blurb: "a TypeScript module compiled in the browser",
  },

  activate(ctx: any) {
    ctx.log("hello-typed activated");
    return () => ctx.log("hello-typed deactivated");
  },

  launch(ctx: any) {
    ctx.openSurface({
      title: "hello typed",
      width: 320,
      height: 190,
      render: (root: HTMLElement, c: any) => {
        root.style.cssText =
          "display:grid;place-content:center;gap:12px;height:100%;text-align:center;font:14px/1.5 var(--vs-font, monospace)";

        const label = document.createElement("div");
        label.style.opacity = "0.7";
        label.textContent = "compiled from ~/modules/hello.ts";

        const button = document.createElement("button");
        button.textContent = describe(tally);
        button.style.cssText =
          "padding:8px 14px;cursor:pointer;background:transparent;color:inherit;" +
          "border:1px solid currentColor;border-radius:6px;font:inherit";
        button.addEventListener("click", () => {
          tally.count++;
          button.textContent = describe(tally);
        });

        root.append(label, button);
        return () => c.log("hello-typed window closed");
      },
    });
  },
};
`;
