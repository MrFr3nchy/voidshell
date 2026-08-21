import type { Compositor } from "../kernel/types";
import { DomCompositor } from "./DomCompositor";
import { ThreeCompositor } from "./ThreeCompositor";

/**
 * Which world to build.
 *
 * The README has always said swapping the render backend is one line in
 * `main.ts`, and it was — but only for whoever was holding the source. Now
 * that there are two backends, the choice is worth exposing to the person
 * actually looking at the screen, because one of them can answer a failure
 * the other cannot.
 *
 * Three sources, in this order, and the order is the interesting part:
 *
 * 1. **`?compositor=dom` in the URL.** Beats everything, sticks to nothing.
 *    An override you can send someone in a link and that a reload undoes.
 * 2. **What the user chose in Settings.** Stored in the workspace, so it
 *    follows the account rather than the machine.
 * 3. **Whether WebGL works at all.** The fallback, and the reason this file
 *    is not just a two-line switch.
 */

/** Settings key holding the chosen backend. Persisted with the dashboard. */
export const BACKEND_KEY = "compositor.backend";

export type BackendId = "three" | "dom";

/**
 * What Settings offers, including the one that isn't a backend.
 *
 * `auto` exists so the select has something honest to display before a choice
 * has been made. A seeded default of `three` would be indistinguishable from
 * the user having asked for WebGL — so a machine that cannot do WebGL would
 * fall back *and warn about overriding a preference*, every boot, about a
 * preference nobody expressed.
 */
export const AUTO = "auto";

export const BACKENDS: { value: string; label: string }[] = [
  { value: AUTO, label: "automatic \u2014 the void where WebGL works" },
  { value: "three", label: "void \u2014 WebGL, projected in 3D" },
  { value: "dom", label: "plane \u2014 flat DOM, no WebGL" },
];

function isBackend(v: unknown): v is BackendId {
  return v === "three" || v === "dom";
}

/**
 * Can this browser actually give us a 3D context?
 *
 * Asked rather than assumed, because the failure it prevents is the worst one
 * the shell has: `ThreeCompositor` constructs fine, `init` throws inside the
 * renderer, and what the user gets is a black rectangle with a stack trace in
 * a console they are not looking at. Every cause of that is environmental and
 * none of them are the user's fault — a locked-down work laptop, a VM with no
 * GPU passthrough, a remote desktop session, a blocklisted Android driver, a
 * headless browser, or simply too many contexts already open on the page.
 *
 * The probe context is released immediately. Browsers cap live WebGL contexts
 * at around sixteen and then start killing the oldest, so a probe that kept
 * one would be spending the very resource it exists to protect.
 */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!gl) return false;
    // `WEBGL_lose_context` is how you hand one back. Without it the context
    // lives until it is garbage collected, which is not a schedule anything
    // should depend on.
    (gl as WebGLRenderingContext)
      .getExtension("WEBGL_lose_context")
      ?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export interface BackendChoice {
  id: BackendId;
  /** Where the decision came from, for the journal and for the notice. */
  reason: "url" | "setting" | "fallback" | "default";
}

/**
 * Decide, without building anything.
 *
 * Separated from construction so it can be tested without a DOM and asserted
 * against — the precedence between three sources is exactly the kind of thing
 * that quietly inverts during a refactor and presents as "my setting doesn't
 * stick" months later.
 */
export function chooseBackend(
  saved: Record<string, unknown>,
  search: string,
  hasWebgl: boolean
): BackendChoice {
  const param = new URLSearchParams(search).get("compositor");
  if (isBackend(param)) return { id: param, reason: "url" };

  const chosen = saved[BACKEND_KEY];
  if (isBackend(chosen)) {
    // A saved preference for WebGL on a machine that cannot do WebGL is still
    // a black screen. The setting is honoured wherever it can be.
    if (chosen === "three" && !hasWebgl) return { id: "dom", reason: "fallback" };
    return { id: chosen, reason: "setting" };
  }

  return hasWebgl ? { id: "three", reason: "default" } : { id: "dom", reason: "fallback" };
}

export function createCompositor(id: BackendId): Compositor {
  return id === "dom" ? new DomCompositor() : new ThreeCompositor();
}
