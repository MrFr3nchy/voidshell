import type { KernelContext, KernelEvent } from "../kernel/types";
import { DEFAULT_HOSTNAME, DEFAULT_USER, HOSTNAME_KEY, USER_KEY } from "../kernel/sysfs";

/**
 * Lock, reboot and shutdown.
 *
 * An OS has a *session*, not just a window — a beginning, an interruption you
 * can walk away from, and an end. voidshell had ignition and nothing else: the
 * boot sequence was a beautiful front door onto a building with no other doors.
 *
 * All three states are one veil with different contents, because they're the
 * same idea at different depths: the screen is between you and the void, and
 * what changes is whether it lets you back.
 *
 * The lock screen is honest about what it is — there is no password, because a
 * passphrase checked in client-side JavaScript against a value in localStorage
 * protects nothing and would imply otherwise. It is a screen you can leave up,
 * which is the part that's actually useful in a browser tab.
 */

export type PowerAction = "lock" | "reboot" | "shutdown";

export interface PowerHooks {
  /** Persist the session before the world goes away. */
  save(): void;
  /** Close every window, used on the way down. */
  closeAll(): void;
}

export interface PowerHandle {
  lock(): void;
  locked(): boolean;
  dispose(): void;
}

export function createPower(
  hud: HTMLElement,
  ctx: KernelContext,
  hooks: PowerHooks
): PowerHandle {
  const veil = document.createElement("div");
  veil.className = "power-veil";
  veil.hidden = true;
  hud.appendChild(veil);

  let state: PowerAction | null = null;
  let clockTimer = 0;

  const clear = () => {
    window.clearInterval(clockTimer);
    clockTimer = 0;
    veil.replaceChildren();
  };

  /* ---------------- lock ---------------- */

  const lock = () => {
    if (state) return;
    state = "lock";
    clear();

    const face = document.createElement("div");
    face.className = "lock-face";

    const time = document.createElement("div");
    time.className = "lock-time";
    const date = document.createElement("div");
    date.className = "lock-date";
    const who = document.createElement("div");
    who.className = "lock-who";
    who.textContent = `${ctx.state.get(USER_KEY, DEFAULT_USER)}@${ctx.state.get(
      HOSTNAME_KEY,
      DEFAULT_HOSTNAME
    )}`;
    const hint = document.createElement("div");
    hint.className = "lock-hint";
    hint.textContent = "press any key to return";

    const tick = () => {
      const now = new Date();
      time.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(
        now.getMinutes()
      ).padStart(2, "0")}`;
      date.textContent = now.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
    };
    tick();
    clockTimer = window.setInterval(tick, 1000);

    face.append(time, date, who, hint);
    veil.append(face);
    veil.hidden = false;
    requestAnimationFrame(() => veil.classList.add("up"));

    ctx.log("session locked");
  };

  const unlock = () => {
    if (state !== "lock") return;
    state = null;
    veil.classList.remove("up");
    window.setTimeout(() => {
      veil.hidden = true;
      clear();
    }, 420);
    ctx.log("session unlocked");
  };

  /* ---------------- down ---------------- */

  /**
   * Reboot and shutdown share everything up to the last step, so they share the
   * code too. The difference is one line at the end, which is the honest size
   * of the difference.
   */
  const down = (action: "reboot" | "shutdown") => {
    if (state) return;
    state = action;
    clear();

    ctx.log(`${action} requested`, "warn");
    hooks.save();

    const face = document.createElement("div");
    face.className = "down-face";

    const spark = document.createElement("div");
    spark.className = "down-spark";
    const word = document.createElement("div");
    word.className = "down-word";
    word.textContent = action === "reboot" ? "restarting" : "shutting down";

    face.append(spark, word);
    veil.append(face);
    veil.hidden = false;
    veil.classList.add("up", "is-down");

    // Let the words land before the world goes. Windows close on the way out so
    // the compositor isn't animating a scene nobody will see.
    window.setTimeout(() => {
      hooks.closeAll();
      if (action === "reboot") {
        location.reload();
        return;
      }
      word.textContent = "it is now safe to close this tab";
      word.classList.add("final");
      spark.remove();
    }, 1200);
  };

  /* ---------------- input ---------------- */

  // Capture phase, so a locked screen swallows the shell's own global binds
  // rather than racing them.
  const onKey = (e: KeyboardEvent) => {
    if (state !== "lock") return;
    e.preventDefault();
    e.stopPropagation();
    unlock();
  };
  const onPointer = (e: MouseEvent) => {
    if (state !== "lock") return;
    e.preventDefault();
    e.stopPropagation();
    unlock();
  };

  window.addEventListener("keydown", onKey, true);
  veil.addEventListener("mousedown", onPointer, true);

  const off = ctx.on("system.power", (e: KernelEvent) => {
    const action = (e.payload as { action?: PowerAction } | undefined)?.action;
    if (action === "lock") lock();
    else if (action === "reboot") down("reboot");
    else if (action === "shutdown") down("shutdown");
  });

  return {
    lock,
    locked: () => state === "lock",
    dispose() {
      off();
      window.removeEventListener("keydown", onKey, true);
      clear();
      veil.remove();
    },
  };
}
