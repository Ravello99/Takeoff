// Wall legend → Find walls. The AI reads the legend's TEXT and says what each
// entry means (new wall, existing to remain, demolished, rated…); this module
// measures each entry's SAMPLE graphic on the sheet (the short wall drawn beside
// the label: its pen weight, shade and hatch) and matches every found run to
// the closest sample — so "existing" comes from the drawing's own legend, not a
// guess about pens.
//
// Pure module — no pdf.js, no DOM.
import type { FoundWall, TextSpan } from "./findWalls.ts";

export type WallStyleMeaning = "new_wall" | "existing_wall" | "demo_wall" | "rated_wall";
export interface LegendEntry { label: string; meaning: string; rating?: string; prefix?: string }
export interface LegendSample { label: string; meaning: WallStyleMeaning; rating?: string; width: number; lum: number; hatch: number; strokes: number; box: [number, number, number, number] }

const WALL_MEANINGS = new Set(["new_wall", "existing_wall", "demo_wall", "rated_wall"]);
const norm = (t: string) => t.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Measure the sample graphic beside each wall-style legend label. */
export function legendSamples(
  input: { segs: ArrayLike<number>; width?: ArrayLike<number> | null; lum?: ArrayLike<number> | null; meta?: ArrayLike<number> | null; texts: TextSpan[] },
  legend: LegendEntry[],
): LegendSample[] {
  const n = Math.floor(input.segs.length / 4);
  const out: LegendSample[] = [];
  for (const e of legend) {
    if (!WALL_MEANINGS.has(e.meaning)) continue;
    const want = norm(e.label);
    if (want.length < 3) continue;
    // the label: the text run that best matches (all of it, or its first words)
    const words = want.split(" ");
    let span: TextSpan | null = null, best = 0;
    for (const sp of input.texts) {
      const t = norm(sp.str || "");
      if (!t) continue;
      let sc = 0;
      if (t === want) sc = 3; else if (t.includes(want)) sc = 2; else if (words.length > 1 && t.startsWith(words.slice(0, 2).join(" "))) sc = 1;
      if (sc > best) { best = sc; span = sp; }
    }
    if (!span) continue;
    const h = Math.max(2, Math.min(span.y1 - span.y0, span.x1 - span.x0));
    // the sample sits beside the label, usually to its left (else right)
    const boxes: [number, number, number, number][] = [
      [span.x0 - 9 * h, span.y0 - 1.2 * h, span.x0 - 0.3 * h, span.y1 + 1.2 * h],
      [span.x1 + 0.3 * h, span.y0 - 1.2 * h, span.x1 + 9 * h, span.y1 + 1.2 * h],
    ];
    for (const box of boxes) {
      const byPen = new Map<string, { w: number; l: number; len: number }>();
      let hatch = 0, strokes = 0;
      for (let i = 0; i < n; i++) {
        if (input.meta && (input.meta[i] & 2)) continue;
        const x1 = input.segs[4 * i], y1 = input.segs[4 * i + 1], x2 = input.segs[4 * i + 2], y2 = input.segs[4 * i + 3];
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        if (mx < box[0] || mx > box[2] || my < box[1] || my > box[3]) continue;
        const L = Math.hypot(x2 - x1, y2 - y1);
        strokes++;
        const diag = Math.abs(Math.abs(x2 - x1) - Math.abs(y2 - y1)) < 0.5 * L;
        if (L < 2.5 * h && diag) { hatch++; continue; }
        if (L < 1.5 * h) continue;
        const w = input.width ? input.width[i] : 1, l = input.lum ? input.lum[i] : 0;
        const k = `${w.toFixed(2)}|${l}`;
        const a = byPen.get(k) || { w, l, len: 0 };
        a.len += L; byPen.set(k, a);
      }
      if (!byPen.size) continue;
      const pen = [...byPen.values()].sort((a, b) => b.len - a.len)[0];
      out.push({ label: e.label, meaning: e.meaning as WallStyleMeaning, rating: e.rating, width: pen.w, lum: pen.l, hatch, strokes, box });
      break;
    }
  }
  return out;
}

/** Each run → the legend style it matches (or null when no sample is close, or
 *  the samples can't be told apart). */
export function matchWallStyles(walls: FoundWall[], samples: LegendSample[]): (LegendSample | null)[] {
  if (!samples.length) return walls.map(() => null);
  // samples that look identical teach nothing about which is which
  const distinct = samples.filter((s, i) => samples.every((o, j) => j === i || o.meaning === s.meaning || Math.abs(o.lum - s.lum) > 25 || Math.abs(o.width - s.width) > 0.15 * Math.max(o.width, s.width) || (o.hatch > 2) !== (s.hatch > 2)));
  if (!distinct.length) return walls.map(() => null);
  return walls.map((w) => {
    if (w.penWidth == null || w.penLum == null) return null;
    let best: LegendSample | null = null, bd = 1.5;
    for (const s of distinct) {
      const d = Math.abs((w.penLum as number) - s.lum) / 40
        + Math.abs((w.penWidth as number) - s.width) / Math.max(0.2, 0.3 * Math.max(w.penWidth as number, s.width))
        + (((w.hatchPerFt || 0) > 1) !== (s.hatch > 2) ? 0.8 : 0);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  });
}
