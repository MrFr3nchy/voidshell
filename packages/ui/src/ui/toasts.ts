import type { KernelContext, KernelEvent, NotifyKind } from "../kernel/types";

/** How long a routine notice sits there before it goes. */
const DWELL = 2600;

interface NoticePayload {
  text?: string;
  kind?: NotifyKind;
  action?: { label: string; run: (ctx: KernelContext) => void };
  sticky?: boolean;
}

/**
 * The void talks back. Anything on the bus can raise a notice via
 * ctx.notify(), which keeps modules from inventing their own alert UI and
 * gives the shell one place to decide how loud the OS is allowed to be.
 *
 * Three things a notice can now do that it couldn't:
 *
 * - **carry an offer.** A warning that tells you something is wrong and gives
 *   you no way to act on it is a worse version of saying nothing. The offer
 *   belongs on the thing that reported the problem, while you are still
 *   looking at it.
 * - **stay.** Everything expired after 2.6 seconds regardless of severity, so
 *   glancing away meant losing the message. Warnings and anything actionable
 *   wait to be dismissed.
 * - **be dismissed.** There was no way to clear one early, which matters more
 *   now that some of them stay.
 *
 * Hovering pauses the countdown, because reading a notice should not be a race
 * against it.
 */
export function createToasts(hud: HTMLElement, ctx: KernelContext): void {
  const stack = document.createElement("div");
  stack.className = "toasts";
  hud.appendChild(stack);

  ctx.on("system.notify", (e: KernelEvent) => {
    const p = e.payload as NoticePayload | undefined;
    if (!p?.text) return;
    push(p);
  });

  function push(notice: NoticePayload): void {
    const el = document.createElement("div");
    el.className = `toast is-${notice.kind ?? "info"}`;

    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = notice.text!;
    el.appendChild(text);

    let timer = 0;
    const dismiss = () => {
      window.clearTimeout(timer);
      el.classList.remove("live");
      setTimeout(() => el.remove(), 260);
    };

    if (notice.action) {
      const act = document.createElement("button");
      act.className = "toast-action";
      act.type = "button";
      act.textContent = notice.action.label;
      act.addEventListener("click", () => {
        // Dismiss first: the action may raise a notice of its own, and the
        // stack cap should not eat the new one to keep this one.
        dismiss();
        notice.action!.run(ctx);
      });
      el.appendChild(act);
    }

    const close = document.createElement("button");
    close.className = "toast-close";
    close.type = "button";
    close.textContent = "✕";
    close.title = "dismiss";
    close.setAttribute("aria-label", "Dismiss notice");
    close.addEventListener("click", dismiss);
    el.appendChild(close);

    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("live"));

    // Cap the stack so a chatty module can't wallpaper the screen. Sticky
    // notices are exempt from being pushed out: they are the ones somebody
    // asked to keep, and the cap exists to stop chatter, not to discard them.
    const spare = [...stack.children].filter(
      (c) => !(c as HTMLElement).dataset.sticky
    );
    while (spare.length > 4) spare.shift()?.remove();

    if (notice.sticky) {
      el.dataset.sticky = "1";
      return;
    }

    const start = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(dismiss, DWELL);
    };
    // Reading a notice shouldn't be a race against it.
    el.addEventListener("pointerenter", () => window.clearTimeout(timer));
    el.addEventListener("pointerleave", start);
    start();
  }
}
