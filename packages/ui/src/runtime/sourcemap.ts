/**
 * Just enough source map to answer one question: a runtime error happened at
 * this position in the generated code — where was that in the source the
 * author actually wrote?
 *
 * This exists because stripping types is **not** line-preserving, which is easy
 * to assume and wrong. esbuild collapses what it removes:
 *
 *     interface Big { … }            // 7 lines of types
 *     type Pair<T> = …
 *     function pick<T>(p: Pair<T>) …
 *     throw new Error("boom")        // line 16 of the .ts
 *
 * comes out with the throw on line **5**. Reporting line 5 against the author's
 * editor would underline the middle of an interface they wrote — exactly the
 * confidently-wrong location the loader goes out of its way to refuse. So a
 * compiled module carries its map, and positions come back through here.
 *
 * Only the `mappings` field is read, and only generated→original. No `sources`,
 * no names, no content — a module is one file, and the question is never "which
 * file", only "which line".
 */

/** A position in a file. Both 1-based, the way an editor gutter counts. */
export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceMapping {
  /** Where a generated position came from, or null if the map doesn't say. */
  originalAt(line: number, column: number): SourcePosition | null;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decode one comma-separated segment: base64 VLQ, little-endian, five bits at a
 * time, continuation in bit 6, and the sign of the *first* value in its lowest
 * bit rather than as a leading minus.
 */
function decodeSegment(text: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of text) {
    const digit = BASE64.indexOf(ch);
    if (digit < 0) return out; // not a map we understand; take what we have
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    value >>= 1;
    out.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  return out;
}

/** One decoded mapping: where a generated column came from. All 0-based. */
type Segment = [generatedColumn: number, originalLine: number, originalColumn: number];

/**
 * Build a lookup from a source map's JSON.
 *
 * Returns null rather than throwing on anything unparseable: a missing map
 * means positions are unknown, which every caller already has to handle, and a
 * throw here would turn "we can't tell you the line" into "the module failed
 * to load".
 */
export function createMapping(mapJson: string): SourceMapping | null {
  let mappings: unknown;
  try {
    mappings = (JSON.parse(mapJson) as { mappings?: unknown }).mappings;
  } catch {
    return null;
  }
  if (typeof mappings !== "string" || !mappings) return null;

  // The original line and column are *continuous* deltas — they carry across
  // line boundaries — while the generated column resets on every one. Getting
  // that backwards produces a map that is subtly wrong further down the file
  // and perfectly right at the top, which is the worst way to be wrong.
  const lines: Segment[][] = [];
  let originalLine = 0;
  let originalColumn = 0;

  for (const lineText of mappings.split(";")) {
    const segments: Segment[] = [];
    let generatedColumn = 0;
    if (lineText) {
      for (const segmentText of lineText.split(",")) {
        const fields = decodeSegment(segmentText);
        if (!fields.length) continue;
        generatedColumn += fields[0];
        // One field is a generated column with no origin — a real position in
        // the output that came from nowhere in particular. Skip it.
        if (fields.length < 4) continue;
        originalLine += fields[2];
        originalColumn += fields[3];
        segments.push([generatedColumn, originalLine, originalColumn]);
      }
    }
    lines.push(segments);
  }

  return {
    originalAt(line, column) {
      const segments = lines[line - 1];
      if (!segments?.length) return null;

      // The last segment starting at or before this column owns it. Falling
      // back to the first segment on the line matters more than it looks: a
      // stack frame's column can point past the end of everything mapped, and
      // the right line with an approximate column is worth far more than
      // nothing at all.
      let best = segments[0];
      for (const segment of segments) {
        if (segment[0] > column - 1) break;
        best = segment;
      }
      return { line: best[1] + 1, column: best[2] + 1 };
    },
  };
}
