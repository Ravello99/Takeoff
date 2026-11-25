// Find walls — read wall runs straight out of a CAD-exported plan's vectors.
//
// A CAD plan draws a cut wall as two (or more) parallel faces a wall-thickness
// apart, in the drawing's wall pen. This module:
//
//   1. picks the WALL PENS — the stroke weights/colours whose lines mostly come
//      in parallel pairs at wall spacing (a pen is judged by what it draws, not
//      by a width someone tuned on another office's drawings);
//   2. pairs each face with the nearest parallel face above it ("visibility"
//      pairing — every point of a line pairs with the closest overlapping line,
//      so nothing can sit between the two faces of a wall);
//   3. stacks layered faces (board / stud / board drawn as separate lines) into
//      one slab, splitting a stack at its widest internal gap when it is too
//      thick to be one wall (two partitions either side of a chase);
//   4. welds collinear pieces across drafting breaks, keeps the real breaks
//      (openings, intersections), and extends each run to meet the wall it
//      lands on so corners measure true;
//   5. reads the wall TAGS (P1, W3, B10…) from the text layer, follows each
//      tag's leader to the wall it points at, falls back to the nearest wall,
//      carries a tag along a run through its intersections, and finally learns
//      thickness → tag from the tagged walls for the walls nobody tagged.
//
// Everything is a suggestion: the canvas shows the runs for the estimator to
// accept, re-assign or delete. Pure module — no React, no DOM, no pdf.js.

export type Pt = [number, number];

export interface TextSpan { str: string; x0: number; y0: number; x1: number; y1: number; rot?: number }

export interface FindWallsInput {
  segs: ArrayLike<number>;          // flat x1,y1,x2,y2 in sheet px
  meta?: ArrayLike<number> | null;  // oneclick SEG_* bits (curve 1, clip 2)
  width?: ArrayLike<number> | null; // device stroke width per segment (px)
  lum?: ArrayLike<number> | null;   // stroke luminance 0–255 per segment
  texts?: TextSpan[] | null;
  pxPerFt: number;                  // sheet px per real foot (from the page scale)
  tags?: string[] | null;           // the project's own tags, read even when they are not tag-shaped (any tag-shaped text is read too)
}

export type TagSource = "leader" | "near" | "run" | "thickness";

export interface FoundWall {
  id: number;
  a: Pt; b: Pt;                     // centreline, sheet px
  thickPx: number;
  thickIn: number;                  // real inches
  lengthFt: number;
  tag: string | null;
  tagSource: TagSource | null;
  confidence: number;               // 0–1
}

export interface FindWallsResult {
  walls: FoundWall[];
  pens: { width: number; lum: number; yield: number; lengthFt: number }[];
  tags: { tag: string; count: number; lengthFt: number; thickIn: number | null }[];
  tagMarks: { tag: string; x: number; y: number; wall: number | null; via: TagSource | null }[];
}

// ── thresholds (real units; converted with pxPerFt) ─────────────────────────
export const WALL_MIN_IN = 2.25;       // thinner than a 1⅝" stud + one board is not a wall
export const WALL_MAX_IN = 16;         // thicker is two walls, a chase, or a masonry/curtain assembly drawn as one
export const FACE_GAP_MIN_IN = 0.2;    // layered faces closer than this are one line drawn twice
export const MIN_PIECE_FT = 0.5;       // a face shorter than this cannot be a wall face
export const MIN_WALL_FT = 1.0;        // a finished run shorter than this is a jamb return or a symbol
export const ANGLE_TOL_DEG = 1.0;
export const WELD_GAP_FT = 0.2;        // collinear pieces closer than this are one run (drafting breaks)
export const RUN_GAP_FT = 5;           // a tag carries along its run across a gap up to a door opening
export const INLINE_MAX_FT = 4;       // a piece this short sitting in a tagged run's line takes its tag...
export const INLINE_GAP_FT = 1;       // ...when it is this close to it
export const NEAR_TAG_FT = 6;          // a leaderless tag claims a wall within this distance
export const PEN_MIN_YIELD = 0.3;      // share of a pen's ink that pairs at wall spacing
export const PEN_MIN_FT = 20;          // ...and at least this much of it
export const HATCH_PEN_MIN_YIELD = 0.12; // a lighter pen is searched for hatched walls when this much of it pairs
export const TAG_RE = /^[A-Z]{1,3}-?\d{1,2}[A-Z]?$/;

const SEG_CURVE = 1, SEG_CLIP = 2;

interface Line {
  i: number;            // segment index
  g: number;            // angle group
  th: number;           // angle (rad, [0, π))
  rho: number;          // normal offset
  t0: number; t1: number;
  pen: number;
}

interface Strip { lo: number; hi: number; rlo: number; rhi: number; t0: number; t1: number; g: number }
interface Slab { g: number; th: number; rlo: number; rhi: number; t0: number; t1: number }

const penKey = (w: number, l: number) => `${Math.round(w * 20) / 20}|${Math.round(l / 16)}`;

function angleOf(dx: number, dy: number): number {
  let a = Math.atan2(dy, dx);
  if (a < 0) a += Math.PI;
  if (a >= Math.PI) a -= Math.PI;
  return a;
}

/** Build lines (face candidates) grouped by angle. */
function buildLines(inp: FindWallsInput, minPiece: number) {
  const { segs, meta, width, lum } = inp;
  const n = Math.floor(segs.length / 4);
  const pens = new Map<string, number>();
  const penInfo: { width: number; lum: number; len: number }[] = [];
  const lines: Line[] = [];
  const tol = (ANGLE_TOL_DEG * Math.PI) / 180;
  // angle groups: cluster dominant angles so a 0.3° drafting skew still pairs
  const groupAngles: number[] = [];
  const groupFor = (th: number): number => {
    for (let k = 0; k < groupAngles.length; k++) {
      let d = Math.abs(th - groupAngles[k]);
      d = Math.min(d, Math.PI - d);
      if (d <= tol) return k;
    }
    groupAngles.push(th);
    return groupAngles.length - 1;
  };
  for (let i = 0; i < n; i++) {
    const m = meta ? meta[i] : 0;
    if (m & (SEG_CURVE | SEG_CLIP)) continue;
    const x1 = segs[4 * i], y1 = segs[4 * i + 1], x2 = segs[4 * i + 2], y2 = segs[4 * i + 3];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const w = width ? width[i] : 1, l = lum ? lum[i] : 0;
    const key = penKey(w, l);
    let pen = pens.get(key);
    if (pen === undefined) { pen = penInfo.length; pens.set(key, pen); penInfo.push({ width: Math.round(w * 20) / 20, lum: l, len: 0 }); }
    if (len < minPiece) continue;
    penInfo[pen].len += len;
    const th = angleOf(dx, dy);
    const g = groupFor(th);
    lines.push({ i, g, th, rho: 0, t0: 0, t1: 0, pen });
  }
  // project every line on its group's reference direction
  for (const L of lines) {
    const th = groupAngles[L.g];
    const cx = Math.cos(th), sy = Math.sin(th);
    const x1 = segs[4 * L.i], y1 = segs[4 * L.i + 1], x2 = segs[4 * L.i + 2], y2 = segs[4 * L.i + 3];
    const ta = x1 * cx + y1 * sy, tb = x2 * cx + y2 * sy;
    L.t0 = Math.min(ta, tb); L.t1 = Math.max(ta, tb);
    L.rho = ((-sy * x1 + cx * y1) + (-sy * x2 + cx * y2)) / 2;
  }
  return { lines, groupAngles, penInfo };
}

/** Visibility pairing: for each line, the nearest overlapping parallel line above it. */
function pairStrips(lines: Line[], gapMin: number, gapMax: number, minPiece: number): Strip[] {
  const byGroup = new Map<number, Line[]>();
  for (const L of lines) { let a = byGroup.get(L.g); if (!a) byGroup.set(L.g, (a = [])); a.push(L); }
  const strips: Strip[] = [];
  for (const [g, arr] of byGroup) {
    arr.sort((p, q) => p.rho - q.rho);
    for (let a = 0; a < arr.length; a++) {
      const A = arr[a];
      // free = sub-intervals of A not yet claimed by a closer partner
      let free: [number, number][] = [[A.t0, A.t1]];
      for (let b = a + 1; b < arr.length && free.length; b++) {
        const B = arr[b];
        const gap = B.rho - A.rho;
        if (gap > gapMax) break;
        if (B.t1 <= A.t0 || B.t0 >= A.t1) continue;
        if (gap < gapMin) {
          // a line drawn on top of A (or a hair off it): it hides nothing
          continue;
        }
        const next: [number, number][] = [];
        for (const [f0, f1] of free) {
          const o0 = Math.max(f0, B.t0), o1 = Math.min(f1, B.t1);
          if (o1 - o0 <= 0) { next.push([f0, f1]); continue; }
          if (o1 - o0 >= minPiece) strips.push({ lo: A.i, hi: B.i, rlo: A.rho, rhi: B.rho, t0: o0, t1: o1, g });
          if (o0 > f0) next.push([f0, o0]);
          if (f1 > o1) next.push([o1, f1]);
        }
        free = next.filter(([f0, f1]) => f1 - f0 > 1e-6);
      }
    }
  }
  return strips;
}

/** Stack layered strips into slabs no thicker than a wall. */
function stackSlabs(strips: Strip[], groupAngles: number[], tMin: number, tMax: number, minPiece: number): Slab[] {
  // union strips that share a face line and overlap along the run
  const parent = strips.map((_, k) => k);
  const find = (k: number): number => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const byLo = new Map<number, number[]>();
  strips.forEach((s, k) => { let a = byLo.get(s.lo); if (!a) byLo.set(s.lo, (a = [])); a.push(k); });
  strips.forEach((s, k) => {
    for (const j of byLo.get(s.hi) || []) {
      const o = Math.min(s.t1, strips[j].t1) - Math.max(s.t0, strips[j].t0);
      if (o > 0) parent[find(j)] = find(k);
    }
  });
  const comps = new Map<number, number[]>();
  strips.forEach((_, k) => { const r = find(k); let a = comps.get(r); if (!a) comps.set(r, (a = [])); a.push(k); });
  const out: Slab[] = [];
  const eps = 0.5;
  for (const ks of comps.values()) {
    const g = strips[ks[0]].g;
    if (ks.length === 1) {
      const s = strips[ks[0]];
      if (s.rhi - s.rlo >= tMin && s.rhi - s.rlo <= tMax) out.push({ g, th: groupAngles[g], rlo: s.rlo, rhi: s.rhi, t0: s.t0, t1: s.t1 });
      continue;
    }
    // elementary intervals along the run
    const cuts = Array.from(new Set(ks.flatMap((k) => [strips[k].t0, strips[k].t1]))).sort((p, q) => p - q);
    const pieces: Slab[] = [];
    for (let c = 0; c + 1 < cuts.length; c++) {
      const a = cuts[c], b = cuts[c + 1];
      if (b - a < 1e-6) continue;
      const cover = ks.map((k) => strips[k]).filter((s) => s.t0 <= a + 1e-6 && s.t1 >= b - 1e-6).sort((p, q) => p.rlo - q.rlo);
      // contiguous stacks
      let run: Strip[] = [];
      const flush = () => {
        if (!run.length) return;
        for (const [lo, hi] of splitStack(run, tMax)) {
          if (hi - lo >= tMin && hi - lo <= tMax) pieces.push({ g, th: groupAngles[g], rlo: lo, rhi: hi, t0: a, t1: b });
        }
        run = [];
      };
      for (const s of cover) {
        if (run.length && Math.abs(run[run.length - 1].rhi - s.rlo) > eps) flush();
        run.push(s);
      }
      flush();
    }
    // re-join elementary pieces with the same faces
    pieces.sort((p, q) => p.rlo - q.rlo || p.t0 - q.t0);
    for (const p of pieces) {
      const last = out.length ? out[out.length - 1] : null;
      if (last && last.g === g && Math.abs(last.rlo - p.rlo) < eps && Math.abs(last.rhi - p.rhi) < eps && p.t0 - last.t1 < 1e-3) last.t1 = Math.max(last.t1, p.t1);
      else out.push({ ...p });
    }
  }
  return out.filter((s) => s.t1 - s.t0 >= minPiece);
}

/** Split a contiguous stack of strips at its widest internal gap until every piece fits a wall. */
function splitStack(run: Strip[], tMax: number): [number, number][] {
  const lo = run[0].rlo, hi = run[run.length - 1].rhi;
  if (hi - lo <= tMax || run.length === 1) return [[lo, hi]];
  let wi = 0, ww = -1;
  for (let k = 0; k < run.length; k++) { const w = run[k].rhi - run[k].rlo; if (w > ww) { ww = w; wi = k; } }
  // the widest strip is the cavity: drop it, recurse on either side
  return [...(wi > 0 ? splitStack(run.slice(0, wi), tMax) : []), ...(wi < run.length - 1 ? splitStack(run.slice(wi + 1), tMax) : [])];
}

/** Weld collinear slabs across drafting breaks; overlapping duplicates fold in. */
function weld(slabs: Slab[], weldGap: number): Slab[] {
  const eps = 0.75;
  slabs.sort((p, q) => p.g - q.g || p.rlo - q.rlo || p.t0 - q.t0);
  const out: Slab[] = [];
  for (const s of slabs) {
    let merged = false;
    for (let k = out.length - 1; k >= 0 && k >= out.length - 12; k--) {
      const o = out[k];
      if (o.g !== s.g) break;
      if (Math.abs(o.rlo - s.rlo) < eps && Math.abs(o.rhi - s.rhi) < eps && s.t0 - o.t1 <= weldGap && s.t1 >= o.t0 - weldGap) {
        o.t0 = Math.min(o.t0, s.t0); o.t1 = Math.max(o.t1, s.t1); merged = true; break;
      }
    }
    if (!merged) out.push({ ...s });
  }
  return out;
}

const toXY = (th: number, t: number, rho: number): Pt => [t * Math.cos(th) - rho * Math.sin(th), t * Math.sin(th) + rho * Math.cos(th)];

function segDist(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2));
  return Math.hypot(px - a[0] - u * dx, py - a[1] - u * dy);
}

/** Extend run ends to meet the wall they land on (corners and tees measure to the centreline). */
function extendEnds(walls: { a: Pt; b: Pt; thick: number; th: number }[]) {
  for (const w of walls) {
    for (const end of ["a", "b"] as const) {
      const p = w[end], q = end === "a" ? w.b : w.a;
      const dx = p[0] - q[0], dy = p[1] - q[1];
      const L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L;
      let best = Infinity, bestPt: Pt | null = null;
      for (const o of walls) {
        if (o === w) continue;
        let d = Math.abs(o.th - w.th); d = Math.min(d, Math.PI - d);
        if (d < 0.35) continue;                       // not across this run
        const reach = o.thick * 0.75 + w.thick * 0.5 + 1;
        // ray p + s·u against o's centreline
        const ex = o.b[0] - o.a[0], ey = o.b[1] - o.a[1];
        const den = ux * ey - uy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const s = ((o.a[0] - p[0]) * ey - (o.a[1] - p[1]) * ex) / den;
        const v = ((o.a[0] - p[0]) * uy - (o.a[1] - p[1]) * ux) / den;
        const oL = Math.hypot(ex, ey) || 1;
        const slack = (w.thick * 0.75 + 1) / oL;
        if (s < -0.5 || s > reach || v < -slack || v > 1 + slack) continue;
        if (Math.abs(s) < Math.abs(best)) { best = s; bestPt = [p[0] + s * ux, p[1] + s * uy]; }
      }
      if (bestPt && best > 0) w[end] = bestPt;
    }
  }
}

/** Does a slab's interior hold hatch — short strokes across the run, between the faces? */
function hatchTester(inp: FindWallsInput, ppf: number) {
  const segs = inp.segs, n = Math.floor(segs.length / 4);
  const cell = Math.max(8, ppf);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const m = inp.meta ? inp.meta[i] : 0;
    if (m & SEG_CLIP) continue;
    const x1 = segs[4 * i], y1 = segs[4 * i + 1], x2 = segs[4 * i + 2], y2 = segs[4 * i + 3];
    if (Math.hypot(x2 - x1, y2 - y1) > 3 * ppf) continue;
    const k = `${Math.floor((x1 + x2) / 2 / cell)},${Math.floor((y1 + y2) / 2 / cell)}`;
    let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
  }
  return (s: Slab): boolean => {
    const c = Math.cos(s.th), sn = Math.sin(s.th);
    const pts = [toXY(s.th, s.t0, s.rlo), toXY(s.th, s.t1, s.rlo), toXY(s.th, s.t0, s.rhi), toXY(s.th, s.t1, s.rhi)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const thick = s.rhi - s.rlo, len = s.t1 - s.t0;
    let hits = 0;
    const need = Math.max(3, Math.min(12, 0.25 * len / thick));
    for (let cx = Math.floor(Math.min(...xs) / cell); cx <= Math.floor(Math.max(...xs) / cell); cx++)
      for (let cy = Math.floor(Math.min(...ys) / cell); cy <= Math.floor(Math.max(...ys) / cell); cy++)
        for (const i of grid.get(`${cx},${cy}`) || []) {
          const x1 = segs[4 * i], y1 = segs[4 * i + 1], x2 = segs[4 * i + 2], y2 = segs[4 * i + 3];
          const L = Math.hypot(x2 - x1, y2 - y1);
          if (L < 0.5 || L > thick * 2.5) continue;
          const cosA = Math.abs(((x2 - x1) * c + (y2 - y1) * sn) / L);
          if (cosA > 0.98) continue;                    // runs along the wall: a face, not hatch
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          const t = mx * c + my * sn, r = -mx * sn + my * c;
          if (t < s.t0 || t > s.t1 || r < s.rlo + 0.2 || r > s.rhi - 0.2) continue;
          if (++hits >= need) return true;
        }
    return false;
  };
}

function median(a: number[]): number { if (!a.length) return 0; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; }

export function findWalls(inp: FindWallsInput): FindWallsResult {
  const ppf = inp.pxPerFt > 0 ? inp.pxPerFt : 18;
  const ppi = ppf / 12;
  const tMin = WALL_MIN_IN * ppi, tMax = WALL_MAX_IN * ppi;
  const gapMin = Math.max(0.3, FACE_GAP_MIN_IN * ppi);
  const minPiece = MIN_PIECE_FT * ppf;
  const { lines, groupAngles, penInfo } = buildLines(inp, minPiece);

  // ── 1. wall pens: judged by how much of their ink pairs at wall spacing ──
  const penLines = new Map<number, Line[]>();
  for (const L of lines) { let a = penLines.get(L.pen); if (!a) penLines.set(L.pen, (a = [])); a.push(L); }
  const penStats: { pen: number; yield: number; paired: number }[] = [];
  for (const [pen, ls] of penLines) {
    if (penInfo[pen].len < PEN_MIN_FT * ppf) continue;
    const st = pairStrips(ls, gapMin, tMax, minPiece);
    const slabs = stackSlabs(st, groupAngles, tMin, tMax, minPiece);
    const paired = slabs.reduce((n, s) => n + 2 * (s.t1 - s.t0), 0);
    penStats.push({ pen, yield: paired / penInfo[pen].len, paired });
  }
  let chosen = penStats.filter((p) => p.yield >= PEN_MIN_YIELD && p.paired >= PEN_MIN_FT * ppf);
  if (chosen.length > 1) {
    // a sheet that draws walls heavier than everything else: keep the heavy pens only
    const widest = Math.max(...chosen.map((p) => penInfo[p.pen].width));
    const inkW = median(lines.map((L) => penInfo[L.pen].width));
    if (widest > inkW * 1.3) chosen = chosen.filter((p) => penInfo[p.pen].width >= widest * 0.75 || p.yield >= 0.6);
  }
  if (!chosen.length && penStats.length) chosen = [penStats.reduce((a, b) => (b.paired > a.paired ? b : a))];
  const chosenSet = new Set(chosen.map((p) => p.pen));
  const slabsOf = (ls: Line[]) => weld(stackSlabs(pairStrips(ls, gapMin, tMax, minPiece), groupAngles, tMin, tMax, minPiece), WELD_GAP_FT * ppf);

  // ── 2–4. pair, stack, weld — the wall pens unconditionally ──
  const slabs = slabsOf(lines.filter((L) => chosenSet.has(L.pen)));
  // ...and any other pen that draws some of its walls, where the faces hold a
  // hatch (block, poché, rated-partition hatch) — offices often draw part of
  // the plan's walls in the same light pen as the casework and fixtures
  const others = penStats.filter((p) => !chosenSet.has(p.pen) && p.yield >= HATCH_PEN_MIN_YIELD);
  if (others.length) {
    const hatched = hatchTester(inp, ppf);
    for (const p of others) {
      for (const s of slabsOf(penLines.get(p.pen) || [])) {
        if (s.t1 - s.t0 < MIN_WALL_FT * ppf || !hatched(s)) continue;
        const dup = slabs.some((o) => o.g === s.g && Math.min(o.rhi, s.rhi) - Math.max(o.rlo, s.rlo) > 0 && Math.min(o.t1, s.t1) - Math.max(o.t0, s.t0) > 0.5 * (s.t1 - s.t0));
        if (!dup) slabs.push(s);
      }
    }
  }
  const raw = slabs
    .filter((s) => s.t1 - s.t0 >= MIN_WALL_FT * ppf)
    .map((s) => {
      const rm = (s.rlo + s.rhi) / 2;
      return { a: toXY(s.th, s.t0, rm), b: toXY(s.th, s.t1, rm), thick: s.rhi - s.rlo, th: s.th, g: s.g, rlo: s.rlo, rhi: s.rhi, t0: s.t0, t1: s.t1 };
    });
  extendEnds(raw);

  // ── 5. tags ──
  const tagSet = inp.tags && inp.tags.length ? new Set(inp.tags.map((t) => t.trim().toUpperCase())) : null;
  const marks: { known: boolean; tag: string; x: number; y: number; h: number }[] = [];
  for (const sp of inp.texts || []) {
    const s = (sp.str || "").trim().toUpperCase();
    if (!s) continue;
    const known = !!tagSet && tagSet.has(s);
    if (!known && !TAG_RE.test(s)) continue;
    marks.push({ known, tag: s, x: (sp.x0 + sp.x1) / 2, y: (sp.y0 + sp.y1) / 2, h: Math.max(2, Math.min(sp.x1 - sp.x0, sp.y1 - sp.y0)) });
  }
  // a tag-shaped word seen once on the sheet is a note, not a wall type —
  // unless it is one of the project's own tags
  {
    const cnt = new Map<string, number>();
    for (const m of marks) cnt.set(m.tag, (cnt.get(m.tag) || 0) + 1);
    for (let k = marks.length - 1; k >= 0; k--) if (!marks[k].known && (cnt.get(marks[k].tag) || 0) < 2) marks.splice(k, 1);
  }

  // spatial hash of all straight segment endpoints, for leader following
  const segs = inp.segs, nSeg = Math.floor(segs.length / 4);
  const cell = Math.max(8, ppf);
  const grid = new Map<string, number[]>();
  const gk = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const addEnd = (x: number, y: number, code: number) => { const k = gk(x, y); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(code); };
  if (marks.length) for (let i = 0; i < nSeg; i++) {
    const m = inp.meta ? inp.meta[i] : 0;
    if (m & SEG_CLIP) continue;
    addEnd(segs[4 * i], segs[4 * i + 1], 2 * i);
    addEnd(segs[4 * i + 2], segs[4 * i + 3], 2 * i + 1);
  }
  const endsNear = (x: number, y: number, r: number): number[] => {
    const out: number[] = [];
    const c0 = Math.floor((x - r) / cell), c1 = Math.floor((x + r) / cell), d0 = Math.floor((y - r) / cell), d1 = Math.floor((y + r) / cell);
    for (let cx = c0; cx <= c1; cx++) for (let cy = d0; cy <= d1; cy++) for (const code of grid.get(`${cx},${cy}`) || []) {
      const i = code >> 1, e = code & 1;
      const ex = segs[4 * i + 2 * e], ey = segs[4 * i + 2 * e + 1];
      if (Math.hypot(ex - x, ey - y) <= r) out.push(code);
    }
    return out;
  };
  const nearestWall = (x: number, y: number, maxD: number): number => {
    let bi = -1, bd = maxD;
    raw.forEach((w, k) => {
      const d = segDist(x, y, w.a, w.b) - w.thick / 2;
      if (d < bd) { bd = d; bi = k; }
    });
    return bi;
  };

  const votes: Map<string, number>[] = raw.map(() => new Map());
  const source: (TagSource | null)[] = raw.map(() => null);
  const tagMarks: FindWallsResult["tagMarks"] = [];
  for (const mk of marks) {
    // leader: a stroke leaving the tag's bubble radially, possibly with one elbow
    const rIn = mk.h * 0.4, rOut = mk.h * 3.2;
    let tip: Pt | null = null, tipLen = 0;
    for (const code of endsNear(mk.x, mk.y, rOut)) {
      const i = code >> 1, e = code & 1;
      const sx = segs[4 * i + 2 * e], sy = segs[4 * i + 2 * e + 1];
      const fx = segs[4 * i + 2 * (1 - e)], fy = segs[4 * i + 2 * (1 - e) + 1];
      const r0 = Math.hypot(sx - mk.x, sy - mk.y), r1 = Math.hypot(fx - mk.x, fy - mk.y);
      if (r0 < rIn || r1 <= rOut) continue;
      const L = Math.hypot(fx - sx, fy - sy);
      if (L < mk.h * 1.2) continue;
      const radial = ((fx - sx) * (sx - mk.x) + (fy - sy) * (sy - mk.y)) / (L * (r0 || 1));
      if (radial < 0.85) continue;
      let end: Pt = [fx, fy], total = L;
      // follow one elbow
      for (const c2 of endsNear(fx, fy, 1.5)) {
        const j = c2 >> 1; if (j === i) continue;
        const e2 = c2 & 1;
        const gx = segs[4 * j + 2 * (1 - e2)], gy = segs[4 * j + 2 * (1 - e2) + 1];
        const L2 = Math.hypot(gx - fx, gy - fy);
        if (L2 > mk.h && Math.hypot(gx - mk.x, gy - mk.y) > r1) { end = [gx, gy]; total += L2; break; }
      }
      if (total > tipLen) { tipLen = total; tip = end; }
    }
    let wi = -1, via: TagSource | null = null;
    if (tip) { wi = nearestWall(tip[0], tip[1], 0.75 * ppf); if (wi >= 0) via = "leader"; }
    if (wi < 0) { wi = nearestWall(mk.x, mk.y, NEAR_TAG_FT * ppf); if (wi >= 0) via = "near"; }
    tagMarks.push({ tag: mk.tag, x: mk.x, y: mk.y, wall: wi >= 0 ? wi : null, via });
    if (wi < 0) continue;
    const v = votes[wi];
    v.set(mk.tag, (v.get(mk.tag) || 0) + (via === "leader" ? 3 : 1));
    if (via === "leader" || !source[wi]) source[wi] = via;
  }
  const tagOf: (string | null)[] = votes.map((v) => {
    let best: string | null = null, bv = 0;
    for (const [t, n] of v) if (n > bv) { bv = n; best = t; }
    return best;
  });

  // carry a tag along its run: collinear, same faces, through tees and openings
  const runOrder = raw.map((_, k) => k).sort((p, q) => raw[p].g - raw[q].g || raw[p].rlo - raw[q].rlo || raw[p].t0 - raw[q].t0);
  const sameRun = (p: number, q: number) => {
    const A = raw[p], B = raw[q];
    return A.g === B.g && Math.abs(A.rlo - B.rlo) < 1 && Math.abs(A.rhi - B.rhi) < 1;
  };
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (let x = 0; x < runOrder.length; x++) {
      const p = runOrder[x];
      for (let y = x + 1; y < runOrder.length; y++) {
        const q = runOrder[y];
        if (!sameRun(p, q)) { if (raw[q].g !== raw[p].g || raw[q].rlo - raw[p].rlo > 1) break; continue; }
        const gap = Math.max(raw[q].t0 - raw[p].t1, raw[p].t0 - raw[q].t1);
        if (gap > RUN_GAP_FT * ppf) continue;
        if (tagOf[p] && !tagOf[q]) { tagOf[q] = tagOf[p]; source[q] = "run"; changed = true; }
        else if (tagOf[q] && !tagOf[p]) { tagOf[p] = tagOf[q]; source[p] = "run"; changed = true; }
      }
    }
    if (!changed) break;
  }

  // a short piece set in a tagged run — a door or window frame, a jamb, a
  // thickened stretch — belongs to that run even though its faces differ
  raw.forEach((w, k) => {
    if (tagOf[k] || w.t1 - w.t0 > INLINE_MAX_FT * ppf) return;
    const rm = (w.rlo + w.rhi) / 2;
    let best = -1, bg = INLINE_GAP_FT * ppf;
    raw.forEach((o, j) => {
      if (j === k || !tagOf[j] || o.g !== w.g) return;
      if (Math.abs((o.rlo + o.rhi) / 2 - rm) > Math.max(o.rhi - o.rlo, w.rhi - w.rlo) / 2) return;
      const gap = Math.max(o.t0 - w.t1, w.t0 - o.t1);
      if (gap <= bg) { bg = gap; best = j; }
    });
    if (best >= 0) { tagOf[k] = tagOf[best]; source[k] = "run"; }
  });

  // thickness → tag, learned from the walls that are tagged
  const thickIn = raw.map((w) => w.thick / ppi);
  const byThick = new Map<number, Map<string, number>>();
  raw.forEach((w, k) => {
    const t = tagOf[k];
    if (!t || source[k] === "run") return;
    const b = Math.round(thickIn[k] * 2) / 2;
    let m = byThick.get(b); if (!m) byThick.set(b, (m = new Map()));
    m.set(t, (m.get(t) || 0) + (w.t1 - w.t0));
  });
  raw.forEach((_, k) => {
    if (tagOf[k]) return;
    const b = Math.round(thickIn[k] * 2) / 2;
    const acc = new Map<string, number>();
    for (const d of [b - 0.5, b, b + 0.5]) for (const [t, n] of byThick.get(d) || []) acc.set(t, (acc.get(t) || 0) + n);
    let tot = 0, best: string | null = null, bv = 0;
    for (const [t, n] of acc) { tot += n; if (n > bv) { bv = n; best = t; } }
    if (best && bv / tot >= 0.7) { tagOf[k] = best; source[k] = "thickness"; }
  });

  const CONF: Record<TagSource, number> = { leader: 0.95, near: 0.8, run: 0.75, thickness: 0.55 };
  const walls: FoundWall[] = raw.map((w, k) => ({
    id: k,
    a: [+w.a[0].toFixed(2), +w.a[1].toFixed(2)], b: [+w.b[0].toFixed(2), +w.b[1].toFixed(2)],
    thickPx: +w.thick.toFixed(2),
    thickIn: +thickIn[k].toFixed(2),
    lengthFt: +(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) / ppf).toFixed(2),
    tag: tagOf[k], tagSource: source[k],
    confidence: source[k] ? CONF[source[k] as TagSource] : 0.3,
  }));

  const tagAgg = new Map<string, { count: number; lengthFt: number; th: number[] }>();
  for (const w of walls) {
    if (!w.tag) continue;
    let a = tagAgg.get(w.tag); if (!a) tagAgg.set(w.tag, (a = { count: 0, lengthFt: 0, th: [] }));
    a.count++; a.lengthFt += w.lengthFt; a.th.push(w.thickIn);
  }
  return {
    walls,
    pens: chosen.map((p) => ({ width: penInfo[p.pen].width, lum: penInfo[p.pen].lum, yield: +p.yield.toFixed(2), lengthFt: +(penInfo[p.pen].len / ppf).toFixed(1) })),
    tags: [...tagAgg].map(([tag, a]) => ({ tag, count: a.count, lengthFt: +a.lengthFt.toFixed(1), thickIn: a.th.length ? +median(a.th).toFixed(1) : null })).sort((p, q) => q.lengthFt - p.lengthFt),
    tagMarks,
  };
}
