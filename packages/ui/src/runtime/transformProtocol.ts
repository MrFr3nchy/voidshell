/**
 * What the compile worker and its client say to each other.
 *
 * Shared by both sides of a `postMessage` boundary, and imported by neither
 * side's implementation of the other. `transform.ts` constructs the worker;
 * `tsWorker.ts` is the worker. If either imported the other, the worker bundle
 * would contain a `new Worker(…)` referring to itself.
 */

/** Extensions the compile step handles. A module is still one file. */
const COMPILED = [".ts", ".mts"];

/**
 * Does this path have to go through esbuild before it can be loaded?
 *
 * `.tsx` is deliberately absent. JSX needs a factory to compile against, and
 * modules render DOM directly — there is nothing for it to target.
 */
export function needsTransform(path: string): boolean {
  return COMPILED.some((ext) => path.endsWith(ext));
}

/**
 * The one sentence the UI owes anybody compiling TypeScript here.
 *
 * esbuild *strips* types; it does not check them. `const n: number = "no"`
 * compiles clean and fails, if it fails at all, at runtime and somewhere else.
 * Saying so plainly is the difference between a tool and a trap.
 */
export const TYPES_ARE_NOT_CHECKED = "types stripped, not checked";

export interface TransformRequest {
  type: "transform";
  id: number;
  source: string;
  path: string;
}

export type TransformReply =
  | { type: "ok"; id: number; code: string; map: string }
  | { type: "fail"; id: number; message: string; line?: number; column?: number };

/**
 * Turn whatever esbuild threw into a sentence and a place.
 *
 * esbuild reports a `location.line` that is 1-based and a `location.column`
 * that is **0-based**, which is a genuinely easy way to end up one character
 * off in a gutter forever. Normalised to 1-based here, once, rather than at
 * each of the three places that eventually render it.
 */
export function describeBuildFailure(err: unknown): {
  message: string;
  line?: number;
  column?: number;
} {
  const errors = (err as { errors?: unknown }).errors;
  const first = Array.isArray(errors) ? errors[0] : undefined;

  if (first && typeof first === "object") {
    const entry = first as {
      text?: unknown;
      location?: { line?: unknown; column?: unknown } | null;
    };
    const text = typeof entry.text === "string" ? entry.text : "could not compile";
    const line = Number(entry.location?.line);
    const column = Number(entry.location?.column);
    return {
      message: text,
      line: Number.isInteger(line) && line >= 1 ? line : undefined,
      // 0-based becomes 1-based. Guarded rather than blindly incremented so a
      // missing column doesn't quietly become column 1.
      column: Number.isInteger(column) && column >= 0 ? column + 1 : undefined,
    };
  }

  return { message: err instanceof Error ? err.message : String(err) };
}
