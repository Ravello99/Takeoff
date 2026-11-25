// Scope notes for Find walls — the drawing text the AI reads to decide which
// walls are in Vanguard's scope (existing walls to fur out, patch, re-board…),
// and locating what a note points at back on the plan.
//
//   notesText(tokens)            the notes / legend / keynote blocks of a sheet, ready for the AI
//   notesScore(tokens)           how much scope-relevant note text a sheet holds (to pick general-notes sheets)
//   locateNotes(input, walls, notes)   note → the walls its keynote mark or room points at
//
// Pure module — no pdf.js, no DOM.
import { buildBlocks, type Tok } from "./scheduleFinder.ts";
import { makeLeaderFinder, type FoundWall, type TextSpan } from "./findWalls.ts";

const NOTE_HEAD = /\b(GENERAL\s+NOTES|KEY\s*NOTES?|SHEET\s+NOTES|PLAN\s+NOTES|NOTES|LEGEND|SCOPE\s+OF\s+WORK|WALL\s+LEGEND)\b/i;
const SCOPE_WORDS = /\b(EXIST(ING)?|EX\.|\(E\)|DEMO(LISH|LITION)?|REMAIN|REMOVE|PATCH|REPAIR|FUR(R|RING)?|FUR\s+OUT|NEW|N\.?I\.?C|NOT\s+IN\s+CONTRACT|BY\s+OTHERS|BY\s+OWNER|SCOPE|GYP|GYPSUM|GWB|DRYWALL|BOARD|STUD|PARTITION|WALL|CEILING|SOFFIT|BULKHEAD|FINISH|PAINT|PREP)\b/gi;
const MAX_CHARS = 9000;

/** The scope-relevant note blocks of one sheet (empty when it has none). */
export function notesText(tokens: Tok[], budget = MAX_CHARS): string {
  const blocks = buildBlocks(tokens)
    .map((b) => {
      const text = b.lines.join("\n");
      const words = (text.match(SCOPE_WORDS) || []).length;
      const head = NOTE_HEAD.test(b.lines[0] || "") || NOTE_HEAD.test(b.lines[1] || "");
      const exist = /\bEXIST|\(E\)|\bEX\./i.test(text);
      return { b, text, score: words + (head ? 15 : 0) + (exist ? 10 : 0), lines: b.lines.length };
    })
    .filter((x) => x.lines >= 2 && x.score >= 6)
    .sort((p, q) => q.score - p.score);
  const out: string[] = [];
  let n = 0;
  for (const x of blocks) {
    if (n + x.text.length > budget) continue;
    out.push(x.text); n += x.text.length;
  }
  return out.join("\n\n");
}

export function notesScore(tokens: Tok[]): number {
  const t = notesText(tokens, 4000);
  if (!t) return 0;
  return (t.match(SCOPE_WORDS) || []).length + (/\bEXIST|\(E\)/i.test(t) ? 20 : 0) + (NOTE_HEAD.test(t) ? 10 : 0);
}

export interface ScopeNote { mark?: string | null; rooms?: string[] | null }

/** For each note: ids of the walls its keynote mark (via its leader, else the
 *  nearest wall) or its rooms (the walls around the room's name) point at. */
export function locateNotes(
  input: { segs: ArrayLike<number>; meta?: ArrayLike<number> | null; texts: TextSpan[]; pxPerFt: number },
  walls: FoundWall[],
  notes: ScopeNote[],
): { walls: number[]; marks: number }[] {
  const ppf = input.pxPerFt > 0 ? input.pxPerFt : 18;
  const leaderTip = makeLeaderFinder(input.segs, input.meta, ppf);
  const dist = (x: number, y: number, w: FoundWall) => {
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], L2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - w.a[0]) * dx + (y - w.a[1]) * dy) / L2));
    return Math.hypot(x - w.a[0] - u * dx, y - w.a[1] - u * dy) - w.thickPx / 2;
  };
  const nearest = (x: number, y: number, maxD: number) => {
    let best: FoundWall | null = null, bd = maxD;
    for (const w of walls) { const d = dist(x, y, w); if (d < bd) { bd = d; best = w; } }
    return best;
  };
  // from a point, the first wall hit in each of four directions: a room's walls
  const around = (x: number, y: number, reach: number): number[] => {
    const ids: number[] = [];
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let best: FoundWall | null = null, bt = reach;
      for (const w of walls) {
        const ex = w.b[0] - w.a[0], ey = w.b[1] - w.a[1];
        const den = ux * ey - uy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((w.a[0] - x) * ey - (w.a[1] - y) * ex) / den;
        const v = ((w.a[0] - x) * uy - (w.a[1] - y) * ux) / den;
        if (t > 0 && t < bt && v >= -0.02 && v <= 1.02) { bt = t; best = w; }
      }
      if (best && !ids.includes(best.id)) ids.push(best.id);
    }
    return ids;
  };
  const spans = input.texts.map((sp) => ({ str: (sp.str || "").trim().toUpperCase(), x: (sp.x0 + sp.x1) / 2, y: (sp.y0 + sp.y1) / 2, h: Math.max(2, Math.min(sp.x1 - sp.x0, sp.y1 - sp.y0)) }));
  return notes.map((n) => {
    const hit = new Set<number>();
    let marks = 0;
    const mark = (n.mark || "").trim().toUpperCase();
    if (mark && mark.length <= 4) {
      for (const sp of spans) {
        if (sp.str !== mark) continue;
        marks++;
        const tip = leaderTip(sp);
        // a long "leader" is a grid line or a dimension, not a keynote's
        const w = tip && Math.hypot(tip[0] - sp.x, tip[1] - sp.y) < 20 * ppf ? nearest(tip[0], tip[1], 0.75 * ppf) : null;
        const w2 = w || nearest(sp.x, sp.y, 4 * ppf);
        if (w2) hit.add(w2.id);
      }
    }
    for (const room of n.rooms || []) {
      const r = String(room || "").trim().toUpperCase();
      if (r.length < 2) continue;
      const first = r.split(/\s+/)[0];
      for (const sp of spans) {
        if (!(sp.str === r || (sp.str.includes(r) && sp.str.length <= r.length + 12) || (r.includes(" ") && sp.str === first))) continue;
        marks++;
        for (const id of around(sp.x, sp.y, 40 * ppf)) hit.add(id);
      }
    }
    return { walls: [...hit], marks };
  });
}
