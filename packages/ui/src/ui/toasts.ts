import type { KernelContext, KernelEvent, NotifyKind } from "../kernel/types";

/**
 * The void talks back. Anything on the bus can raise a notice via
 * ctx.notify(), which keeps modules from inventing their own alert UI and
 * gives the shell one place to decide how loud the OS is allowed to be.
 */
export function createToasts(hud: HTMLElement, ctx: KernelContext): void {
  const stack = document.createElement("div");
  stack.className = "toasts";
  hud.appendChild(stack);

  ctx.on("system.notify", (e: KernelEvent) => {
    const payload = e.payload as { text?: string; kind?: NotifyKind } | undefined;
    if (!payload?.text) return;
    push(payload.text, payload.kind ?? "info");
  });

  function push(text: string, kind: NotifyKind): void {
    const el = document.createElement("div");
    el.className = `toast is-${kind}`;
    el.textContent = text;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("live"));

    // Cap the stack so a chatty module can't wallpaper the screen.
    while (stack.children.length > 4) stack.firstElementChild?.remove();

    setTimeout(() => {
      el.classList.remove("live");
      setTimeout(() => el.remove(), 260);
    }, 2600);
  }
}
