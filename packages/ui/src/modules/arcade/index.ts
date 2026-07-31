/**
 * Arcade — a cabinet in the void, and a shelf of games to put in it.
 *
 * The module owns everything that isn't a game: the canvas, the frame loop,
 * integer letterboxing, the keyboard, pause, mute, and a high-score table that
 * rides the ordinary settings store and so follows the account rather than the
 * browser. Games get a delta, a pad and a scaled 2D context — see `types.ts`.
 *
 * Two things here are worth explaining, because both look like over-thinking
 * until you run it inside a shell that already has keybinds:
 *
 * **Keys are captured, not listened for.** voidshell binds Space to the
 * launcher ring, and Space is also how you flap. The cabinet takes a
 * capture-phase listener on `window` and stops propagation for the keys it
 * uses, so the event never reaches the shell's bubble-phase handler. That is
 * only defensible because it is scoped: keys are swallowed *only* while the
 * cabinet is engaged, engaging requires a click on the canvas, and Escape
 * always disengages. Click away and Space summons the ring again.
 *
 * **Scaling is integer.** A 320x240 playfield drawn at 2.6x has some pixels
 * two device pixels wide and some three, which on hard-edged pixel art is
 * immediately visible as a shimmer when anything moves. The picture is scaled
 * by a whole number and centred, and the leftover is letterbox. Below 1x —
 * a panel dragged smaller than the playfield — it falls back to fractional
 * rather than refusing to draw.
 */

import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";
import { mountStage, palette, toolbar, toolButton, withAlpha } from "../../ui/canvasStage";
import type { Game, GameDef, GameKey, Pad } from "./types";
import { CABINETS, cabinet } from "./registry";

const SOUND_KEY = "arcade.sound";
const CRT_KEY = "arcade.crt";
const hiKey = (id: string) => `arcade.hi.${id}`;

/**
 * Physical key to cabinet control. Keyed on `code`, not `key`, so the layout
 * is positional — WASD stays where WASD is on an AZERTY keyboard.
 */
const KEYMAP: Record<string, GameKey[]> = {
  ArrowLeft: ["left"],
  ArrowRight: ["right"],
  ArrowUp: ["up", "flap"],
  ArrowDown: ["down"],
  KeyA: ["left"],
  KeyD: ["right"],
  KeyW: ["up", "flap"],
  KeyS: ["down"],
  Space: ["flap", "start"],
  Enter: ["start"],
};

export const arcade: VoidModule = {
  manifest: {
    id: "arcade",
    name: "Arcade",
    kind: "app",
    glyph: "\u25CE",
    blurb: "a cabinet in the void",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "arcade.open",
      label: "arcade",
      hint: "wheel out the cabinet",
      glyph: "\u25CE",
      run: (c) => c.launch("arcade"),
    });

    // One verb per cabinet, so the palette can drop you straight into a game
    // rather than into a menu. Generated from the registry — adding a game
    // does not mean adding a command.
    for (const g of CABINETS) {
      ctx.defineCommand({
        id: `arcade.play.${g.id}`,
        label: `play ${g.name.toLowerCase()}`,
        hint: `${g.year} \u00b7 ${g.blurb}`,
        glyph: g.glyph,
        run: (c) => c.launch("arcade", { game: g.id }),
      });
    }

    ctx.defineSetting({
      key: SOUND_KEY,
      label: "arcade sound",
      kind: "toggle",
      group: "Apps",
      hint: "bleeps from the cabinet",
      default: true,
    });
    ctx.defineSetting({
      key: CRT_KEY,
      label: "arcade scanlines",
      kind: "toggle",
      group: "Apps",
      hint: "the tube it should have been played on",
      default: true,
    });
  },

  launch(ctx: KernelContext, args?: LaunchArgs) {
    const wanted = typeof args?.game === "string" ? args.game : "";

    ctx.openSurface({
      title: "arcade",
      width: 700,
      height: 560,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root", "arcade-root");

        const view = document.createElement("div");
        view.className = "arcade-view";
        root.appendChild(view);

        const facts = document.createElement("div");
        facts.className = "stage-facts arcade-facts";
        root.appendChild(facts);

        const bar = toolbar(root);

        /* ---------------- input ---------------- */

        const held = new Set<GameKey>();
        const edge = new Set<GameKey>();
        const pad: Pad = { down: (k) => held.has(k), hit: (k) => edge.has(k) };
        let engaged = false;

        const setEngaged = (on: boolean) => {
          if (engaged === on) return;
          engaged = on;
          held.clear();
          edge.clear();
          view.classList.toggle("is-engaged", on);
        };

        const onKeyDown = (e: KeyboardEvent) => {
          if (!engaged || !game) return;
          if (e.code === "Escape") {
            e.stopPropagation();
            setEngaged(false);
            return;
          }
          const keys = KEYMAP[e.code];
          if (!keys) return;
          // Capture phase plus stopPropagation: the shell's own Space binding
          // is on window in the bubble phase and never sees this.
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          for (const k of keys) {
            held.add(k);
            edge.add(k);
          }
        };

        const onKeyUp = (e: KeyboardEvent) => {
          const keys = KEYMAP[e.code];
          if (!keys) return;
          if (engaged) e.stopPropagation();
          for (const k of keys) held.delete(k);
        };

        // Alt-tabbing away with a key down would otherwise leave it held for
        // ever, and the player comes back to a bird flying into a wall.
        const onBlur = () => {
          held.clear();
          edge.clear();
        };

        const onPointerDown = (e: PointerEvent) => {
          setEngaged(view.contains(e.target as Node));
        };

        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", onBlur);
        document.addEventListener("pointerdown", onPointerDown, true);

        /* ---------------- the cabinet ---------------- */

        let game: Game | null = null;
        let def: GameDef | null = null;
        let stop: (() => void) | null = null;
        let paused = false;

        const muted = () => !ctx.state.get<boolean>(SOUND_KEY, true);

        const host = {
          hiScore: () => (def ? ctx.state.get<number>(hiKey(def.id), 0) : 0),
          submit: (score: number) => {
            if (!def) return false;
            const best = ctx.state.get<number>(hiKey(def.id), 0);
            if (score <= best) return false;
            ctx.state.set(hiKey(def.id), score);
            ctx.notify(`${def.name}: new high score \u2014 ${score.toLocaleString()}`, "good");
            return true;
          },
          muted,
          facts: (rows: { label: string; value: string }[]) => {
            facts.replaceChildren();
            for (const r of rows) {
              const row = document.createElement("div");
              row.className = "stage-row";
              const l = document.createElement("span");
              l.className = "stage-label";
              l.textContent = r.label;
              const v = document.createElement("span");
              v.className = "stage-value";
              v.textContent = r.value;
              row.append(l, v);
              facts.appendChild(row);
            }
          },
        };

        const closeGame = () => {
          stop?.();
          stop = null;
          game?.dispose?.();
          game = null;
          def = null;
          paused = false;
          setEngaged(false);
          facts.replaceChildren();
        };

        /** The shelf: one card per cabinet, with its record on it. */
        const showShelf = () => {
          closeGame();
          bar.replaceChildren();
          view.className = "arcade-view arcade-shelf";
          view.replaceChildren();

          const head = document.createElement("div");
          head.className = "arcade-head";
          head.textContent = "insert coin";
          view.appendChild(head);

          for (const c of CABINETS) {
            const card = document.createElement("button");
            card.className = "arcade-card";
            card.type = "button";

            const glyph = document.createElement("span");
            glyph.className = "arcade-glyph";
            glyph.textContent = c.glyph;

            const body = document.createElement("span");
            body.className = "arcade-card-body";

            const title = document.createElement("span");
            title.className = "arcade-title";
            title.textContent = c.name;

            const year = document.createElement("span");
            year.className = "arcade-year";
            year.textContent = c.year;

            const blurb = document.createElement("span");
            blurb.className = "arcade-blurb";
            blurb.textContent = c.blurb;

            const keys = document.createElement("span");
            keys.className = "arcade-keys";
            keys.textContent = c.controls.join("   \u00b7   ");

            const hi = document.createElement("span");
            hi.className = "arcade-hi";
            const best = ctx.state.get<number>(hiKey(c.id), 0);
            hi.textContent = best ? `high score ${best.toLocaleString()}` : "no record yet";

            body.append(title, year, blurb, keys, hi);
            card.append(glyph, body);
            card.addEventListener("click", () => play(c));
            view.appendChild(card);
          }
        };

        /** Put a game in the cabinet and switch the panel over to the canvas. */
        const play = (c: GameDef) => {
          closeGame();
          def = c;
          game = c.create(host);
          view.className = "arcade-view stage-host";
          view.replaceChildren();

          const veil = document.createElement("div");
          veil.className = "arcade-veil";
          veil.textContent = "click to take the controls";
          view.appendChild(veil);

          bar.replaceChildren();
          toolButton(bar, "\u25c0 cabinet", () => showShelf());
          toolButton(bar, "pause", (b) => {
            paused = !paused;
            b.textContent = paused ? "resume" : "pause";
            b.classList.toggle("on", paused);
          });
          toolButton(bar, muted() ? "sound off" : "sound on", (b) => {
            const next = muted();
            ctx.state.set(SOUND_KEY, next);
            b.textContent = next ? "sound on" : "sound off";
            b.classList.toggle("on", next);
          }).classList.toggle("on", !muted());

          stop = mountStage(view, {
            className: "arcade-canvas",
            frame: (st, dt) => {
              if (!game || !def) return;
              if (!paused) {
                // Clamped again on top of the stage's own clamp: a long frame
                // must never let a rider tunnel through a platform.
                game.update(Math.min(dt, 1 / 30), pad);
                edge.clear();
              }
              present(st.g, st.w, st.h, def, game, {
                crt: ctx.state.get<boolean>(CRT_KEY, true),
                paused,
                engaged,
              });
            },
          });

          // Launching was itself a click, so hand the controls over directly
          // rather than making the player click a second time.
          setEngaged(true);
        };

        const target = wanted ? cabinet(wanted) : undefined;
        if (target) play(target);
        else showShelf();

        return () => {
          window.removeEventListener("keydown", onKeyDown, true);
          window.removeEventListener("keyup", onKeyUp, true);
          window.removeEventListener("blur", onBlur);
          document.removeEventListener("pointerdown", onPointerDown, true);
          closeGame();
        };
      },
    });
  }
};

/**
 * Letterbox, scale, draw, and put a tube in front of it.
 *
 * A free function, not a method: `this` inside `launch` is only the module
 * when the kernel happens to call it as `mod.launch(...)`, and a render path
 * should not depend on the caller's dispatch style.
 */
function present(
    g: CanvasRenderingContext2D,
    w: number,
    h: number,
    def: GameDef,
    game: Game,
    opts: { crt: boolean; paused: boolean; engaged: boolean }
  ): void {
    const c = palette();

    g.fillStyle = "#04050c";
    g.fillRect(0, 0, w, h);

    const raw = Math.min(w / def.width, h / def.height);
    const scale = raw >= 1 ? Math.floor(raw) : raw;
    const vw = def.width * scale;
    const vh = def.height * scale;
    const ox = Math.round((w - vw) / 2);
    const oy = Math.round((h - vh) / 2);

    g.save();
    g.imageSmoothingEnabled = false;
    g.beginPath();
    g.rect(ox, oy, vw, vh);
    g.clip();
    g.translate(ox, oy);
    g.scale(scale, scale);
    game.draw(g);
    g.restore();

    if (opts.crt && scale >= 2) {
      g.fillStyle = "rgba(0, 0, 0, 0.16)";
      for (let y = oy; y < oy + vh; y += 2) g.fillRect(ox, y, vw, 1);
    }

    // A hairline of the void's own colour around the picture, so the cabinet
    // reads as part of the shell rather than as a video pasted into it.
    g.strokeStyle = withAlpha(c.cyan, 0.28);
    g.lineWidth = 1;
    g.strokeRect(ox + 0.5, oy + 0.5, vw - 1, vh - 1);

    if (!opts.engaged && !opts.paused) {
      // No keyboard: say so by dimming, rather than letting the player press
      // Space and watch the launcher ring open over their game.
      g.fillStyle = "rgba(4, 5, 12, 0.45)";
      g.fillRect(ox, oy, vw, vh);
    }

    if (opts.paused) {
      g.fillStyle = "rgba(4, 5, 12, 0.62)";
      g.fillRect(ox, oy, vw, vh);
      g.fillStyle = c.text;
      g.font = "600 13px ui-monospace, monospace";
      g.textAlign = "center";
      g.fillText("PAUSED", ox + vw / 2, oy + vh / 2);
      g.textAlign = "left";
    }
}
