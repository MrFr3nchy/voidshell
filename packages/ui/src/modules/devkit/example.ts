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
