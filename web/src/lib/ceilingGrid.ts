// Ceiling grid — lay a suspended (T-bar) grid into each room and count what it
// really takes: full tiles, the cut border tiles (and which offcuts can be
// reused in other borders, across the whole job), main tees, 4' and 2' cross
// tees (whose offcuts also pair up), wall angle, hanger wires.
//
// Frame: the tile's LONG side runs along u. A 2×4 grid has mains every 4' along
// u (main runs follow v), 4' cross tees spanning between mains every 2' along v.
// A 2×2 grid is the same plus 2' cross tees halfway between the mains.
//
// Layout (where the grid lines fall, i.e. the border sizes):
//   "balanced"  — borders equal on opposite walls and at least ½ a tile (the
//                 architectural default: no slivers)
//   "max_full"  — borders equal, as many full tiles as fit (borders < ½ tile:
//                 two borders come out of one tile → least waste)
//   "wall"      — a full tile against the first wall, the whole remainder at the other
//   "designed"  — the grid as drawn on the reflected ceiling plan (detectGrid)
//
// Pure module: polygons in FEET, any shape (rooms needn't be rectangles).

export type Pt = [number, number];
export type LayoutMode = "balanced" | "max_full" | "wall" | "designed";

export interface GridSpec {
  tileU: number;            // ft along u (the long side: 4 for 2×4, 2 for 2×2)
  tileV: number;            // ft along v (2)
  theta: number;            // radians: direction of u on the sheet
  mainSpacing?: number;     // ft between mains (4)
  mode?: LayoutMode;
  phaseU?: number;          // "designed": a grid line's u (ft, in the rotated frame)
  phaseV?: number;
}

export interface Piece { w: number; h: number; room: number }          // a cut tile piece, w along u, h along v
export interface RoomGrid {
  room: number;
  areaSf: number;
  perimeterLf: number;
  fullTiles: number;
  cutPieces: Piece[];
  borders: { uLow: number; uHigh: number; vLow: number; vHigh: number };   // ft, at the room's extremes
  centered: { u: boolean; v: boolean };
  slivers: string[];                                                       // borders under ½ tile ("4\" border along north wall")
  mainRuns: number[];                                                      // ft, each main run's length
  crossFull: number;                                                       // 4' cross tees used whole
  crossCuts: number[];                                                     // ft, border cross-tee pieces
  cross2Full: number;                                                      // 2' cross tees (2×2) whole
  cross2Cuts: number[];
  wallEdges: number[];                                                     // ft, each wall's length (wall angle)
  wires: number;
  lines: { u: number[]; v: number[]; mains: number[] };                    // grid line positions (rotated frame), for drawing
  extent: { u0: number; u1: number; v0: number; v1: number };              // the room's bounds in the grid frame
  frame: { theta: number };
}

/** One border piece and where it came from. */
export interface CutEntry { w: number; h: number; room: number; from: "tile" | "offcut"; fromRoom?: number }

export interface JobGrid {
  rooms: RoomGrid[];
  tiles: { full: number; cut: number; fromOffcuts: number; bought: number; wasteSf: number; naiveBought: number };
  cutList: { size: string; w: number; h: number; tile: string; n: number; fromOffcuts: number; rooms: number[] }[];   // border pieces by size
  mains: { pieces: number; lf: number };
  cross4: { pieces: number; whole: number; cuts: number; reusedCuts: number };
  cross2: { pieces: number; whole: number; cuts: number; reusedCuts: number };
  wallAngle: { pieces: number; lf: number };
  wires: number;
}

// ── geometry ────────────────────────────────────────────────────────────────
const rot = (p: Pt, c: number, s: number): Pt => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];   // sheet → grid frame

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}

/** Sutherland–Hodgman: polygon ∩ axis-aligned rectangle. */
function clipRect(poly: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  let out = poly;
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [inside, cut] of edges) {
    if (!out.length) break;
    const next: Pt[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      const ia = inside(a), ib = inside(b);
      if (ia) next.push(a);
      if (ia !== ib) next.push(cut(a, b));
    }
    out = next;
  }
  return out;
}

/** Lengths of the pieces of the line {axis = c} that lie inside the polygon (axis 0: x = c, 1: y = c). */
function chords(poly: Pt[], axis: 0 | 1, c: number): number[] {
  const o = 1 - axis;
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[axis] <= c && b[axis] > c) || (b[axis] <= c && a[axis] > c)) xs.push(a[o] + ((b[o] - a[o]) * (c - a[axis])) / (b[axis] - a[axis]));
  }
  xs.sort((p, q) => p - q);
  const out: number[] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push(xs[i + 1] - xs[i]);
  return out;
}
/** Same, as intervals. */
function intervals(poly: Pt[], axis: 0 | 1, c: number): [number, number][] {
  const o = 1 - axis;
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[axis] <= c && b[axis] > c) || (b[axis] <= c && a[axis] > c)) xs.push(a[o] + ((b[o] - a[o]) * (c - a[axis])) / (b[axis] - a[axis]));
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

const EPS = 1e-6;

/** Grid line phase for one axis of a span [lo, hi] with module T. */
export function layoutPhase(lo: number, hi: number, T: number, mode: LayoutMode, designed?: number): number {
  const W = hi - lo;
  if (mode === "designed" && designed != null && isFinite(designed)) return designed;
  if (mode === "wall") return lo;
  const n = Math.floor(W / T + EPS);
  const rem = W - n * T;
  if (rem < EPS) return lo;
  // balanced: borders ≥ ½ tile → (rem + T)/2 each; max_full: rem/2 each
  const b = mode === "max_full" ? rem / 2 : rem / 2 >= T / 2 - EPS ? rem / 2 : (rem + T) / 2;
  return lo + b;
}

/** Lay out one room. */
export function layoutRoom(polyFt: Pt[], spec: GridSpec, room = 0, holesFt: Pt[][] = []): RoomGrid {
  const c = Math.cos(spec.theta), s = Math.sin(spec.theta);
  const P = polyFt.map((p) => rot(p, c, s));
  const H = holesFt.filter((h) => h.length >= 3).map((h) => h.map((p) => rot(p, c, s)));
  // pieces of a line inside the room and outside every hole (bulkheads, soffits, cut-outs)
  const ivs = (axis: 0 | 1, at: number): [number, number][] => {
    let out = intervals(P, axis, at);
    for (const h of H) for (const [a, b] of intervals(h, axis, at)) out = out.flatMap(([x, y]) => (b <= x || a >= y ? [[x, y] as [number, number]] : [[x, Math.min(y, a)], [Math.max(x, b), y]].filter(([p, q]) => q - p > 1e-6) as [number, number][]));
    return out;
  };
  const chordsH = (axis: 0 | 1, at: number) => ivs(axis, at).map(([a, b]) => b - a);
  const T = spec.tileU, V = spec.tileV, M = spec.mainSpacing || 4;
  const mode = spec.mode || "balanced";
  const us = P.map((p) => p[0]), vs = P.map((p) => p[1]);
  const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
  // phases: grid lines at ou + kT (u) and ov + kV (v); mains at om + kM
  const ou = layoutPhase(u0, u1, T, mode, spec.phaseU);
  const ov = layoutPhase(v0, v1, V, mode, spec.phaseV);
  const firstU = ou - Math.ceil((ou - u0) / T - EPS) * T, firstV = ov - Math.ceil((ov - v0) / V - EPS) * V;
  const uLines: number[] = [], vLines: number[] = [];
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;   // grid positions to a millionth of a foot (no 2.9999999)
  for (let k = 0, x = firstU; x <= u1 + EPS; k++, x = firstU + k * T) if (x > u0 + EPS && x < u1 - EPS) uLines.push(r6(x));
  for (let k = 0, y = firstV; y <= v1 + EPS; k++, y = firstV + k * V) if (y > v0 + EPS && y < v1 - EPS) vLines.push(r6(y));
  // mains: every M along u, on grid lines (2×4: every u line; 2×2: every other)
  const step = Math.max(1, Math.round(M / T));
  // choose which u lines are mains so the borders between wall and first main are balanced too
  let best = 0, bestScore = -Infinity;
  for (let k = 0; k < step; k++) {
    const ml = uLines.filter((_, i) => i % step === k);
    if (!ml.length) continue;
    const score = -Math.abs((ml[0] - u0) - (u1 - ml[ml.length - 1]));
    if (score > bestScore) { bestScore = score; best = k; }
  }
  const mains = uLines.filter((_, i) => i % step === best);

  // tiles: every grid cell clipped to the room
  let full = 0;
  const cutPieces: Piece[] = [];
  const cellsU = [u0, ...uLines, u1], cellsV = [v0, ...vLines, v1];
  for (let i = 0; i + 1 < cellsU.length; i++) for (let j = 0; j + 1 < cellsV.length; j++) {
    const x0 = cellsU[i], x1 = cellsU[i + 1], y0 = cellsV[j], y1 = cellsV[j + 1];
    const piece = clipRect(P, x0, y0, x1, y1);
    let a = piece.length >= 3 ? polygonArea(piece) : 0;
    let holed = false;
    for (const h of H) { const hp = clipRect(h, x0, y0, x1, y1); const ha = hp.length >= 3 ? polygonArea(hp) : 0; if (ha > 1e-4) { a -= ha; holed = true; } }
    if (a < 0.01) continue;
    const px = piece.map((p) => p[0]), py = piece.map((p) => p[1]);
    const w = Math.max(...px) - Math.min(...px), h = Math.max(...py) - Math.min(...py);
    if (!holed && Math.abs(w - T) < 0.01 && Math.abs(h - V) < 0.01 && Math.abs(a - T * V) < 0.02) full++;
    else cutPieces.push({ w: Math.min(T, +w.toFixed(4)), h: Math.min(V, +h.toFixed(4)), room });
  }
  // mains: runs along v at each main line
  const mainRuns = mains.flatMap((x) => chordsH(0, x)).filter((l) => l > 0.05);
  // cross tees: along u at each v line, between neighbouring mains (whole) or wall–main (cut)
  let crossFull = 0, cross2Full = 0;
  const crossCuts: number[] = [], cross2Cuts: number[] = [];
  for (const y of vLines) {
    for (const [a, b] of ivs(1, y)) {
      const inside = mains.filter((x) => x > a + EPS && x < b - EPS);
      const stops = [a, ...inside, b];
      for (let k = 0; k + 1 < stops.length; k++) {
        const len = stops[k + 1] - stops[k];
        if (len < 0.05) continue;
        if (Math.abs(len - M) < 0.02) crossFull++; else crossCuts.push(+Math.min(M, len).toFixed(4));
      }
    }
  }
  if (step > 1) {
    // 2×2: 2' cross tees on the u lines between mains, spanning between v lines
    const mids = uLines.filter((x) => !mains.includes(x));
    for (const x of mids) for (const [a, b] of ivs(0, x)) {
      const stops = [a, ...vLines.filter((y) => y > a + EPS && y < b - EPS), b];
      for (let k = 0; k + 1 < stops.length; k++) {
        const len = stops[k + 1] - stops[k];
        if (len < 0.05) continue;
        if (Math.abs(len - V) < 0.02) cross2Full++; else cross2Cuts.push(+Math.min(V, len).toFixed(4));
      }
    }
  }
  const edges = (r: Pt[]) => r.map((p, i) => { const q = r[(i + 1) % r.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]); });
  // wall angle runs round the room and round every bulkhead/soffit inside it
  const wallEdges = [...edges(polyFt), ...holesFt.filter((h) => h.length >= 3).flatMap(edges)].filter((l) => l > 0.05);
  const holeArea = holesFt.reduce((n, h) => n + (h.length >= 3 ? polygonArea(h) : 0), 0);
  // hanger wires: along each main at ≤ 4' o.c., one within 8" of each end
  const wires = mainRuns.reduce((n, L) => n + Math.max(2, Math.ceil(L / 4) + 1), 0);
  const borders = {
    uLow: uLines.length ? uLines[0] - u0 : u1 - u0, uHigh: uLines.length ? u1 - uLines[uLines.length - 1] : 0,
    vLow: vLines.length ? vLines[0] - v0 : v1 - v0, vHigh: vLines.length ? v1 - vLines[vLines.length - 1] : 0,
  };
  const slivers: string[] = [];
  const fmt = (ft: number) => fmtFtIn(ft);
  if (uLines.length && borders.uLow < T / 2 - 0.01) slivers.push(`${fmt(borders.uLow)} border at one end of the ${fmt(u1 - u0)} run`);
  if (uLines.length && borders.uHigh < T / 2 - 0.01 && Math.abs(borders.uHigh - borders.uLow) > 0.01) slivers.push(`${fmt(borders.uHigh)} border at the other end of the ${fmt(u1 - u0)} run`);
  if (vLines.length && borders.vLow < V / 2 - 0.01) slivers.push(`${fmt(borders.vLow)} border along one side (${fmt(v1 - v0)} across)`);
  if (vLines.length && borders.vHigh < V / 2 - 0.01 && Math.abs(borders.vHigh - borders.vLow) > 0.01) slivers.push(`${fmt(borders.vHigh)} border along the other side`);
  return {
    room, areaSf: Math.max(0, polygonArea(polyFt) - holeArea), perimeterLf: wallEdges.reduce((a, b) => a + b, 0),
    fullTiles: full, cutPieces, borders,
    centered: { u: Math.abs(borders.uLow - borders.uHigh) < 0.05, v: Math.abs(borders.vLow - borders.vHigh) < 0.05 },
    slivers, mainRuns, crossFull, crossCuts, cross2Full, cross2Cuts, wallEdges, wires,
    lines: { u: uLines, v: vLines, mains }, extent: { u0, u1, v0, v1 }, frame: { theta: spec.theta },
  };
}

// ── cutting: tiles from tiles and offcuts, tees from tees ──────────────────
const MIN_OFFCUT = 0.25;   // ft — anything smaller is scrap

/** Border tile pieces → tiles to buy. A piece is cut from the smallest offcut it
 *  fits (guillotine: the leftover strip(s) go back in the pool), else from a new
 *  tile. reuse=false cuts every piece from its own tile (the naive count). */
export function planTileCuts(pieces: Piece[], T: number, V: number, reuse = true): { bought: number; fromOffcuts: number; wasteSf: number; log: CutEntry[] } {
  const pool: { w: number; h: number; room: number }[] = [];
  const log: CutEntry[] = [];
  let bought = 0, fromOffcuts = 0, usedSf = 0;
  const sorted = [...pieces].sort((a, b) => b.w * b.h - a.w * a.h);
  for (const p of sorted) {
    usedSf += p.w * p.h;
    let k = -1;
    if (reuse) {
      let best = Infinity;
      pool.forEach((o, i) => { if (o.w + 1e-6 >= p.w && o.h + 1e-6 >= p.h && o.w * o.h < best) { best = o.w * o.h; k = i; } });
    }
    let src: { w: number; h: number; room: number };
    if (k >= 0) { src = pool.splice(k, 1)[0]; fromOffcuts++; log.push({ w: p.w, h: p.h, room: p.room, from: "offcut", fromRoom: src.room }); }
    else { src = { w: T, h: V, room: p.room }; bought++; log.push({ w: p.w, h: p.h, room: p.room, from: "tile" }); }
    if (!reuse) continue;
    // guillotine: keep the larger leftover whole
    const R = src.room;
    const a = { w: src.w - p.w, h: src.h, room: R }, b = { w: p.w, h: src.h - p.h, room: R };   // cut across u first
    const c2 = { w: src.w, h: src.h - p.h, room: R }, d = { w: src.w - p.w, h: p.h, room: R };   // or across v first
    const opt1 = [a, b], opt2 = [c2, d];
    const big = (o: { w: number; h: number }[]) => Math.max(...o.map((x) => x.w * x.h));
    for (const o of big(opt1) >= big(opt2) ? opt1 : opt2) if (o.w >= MIN_OFFCUT && o.h >= MIN_OFFCUT) pool.push(o);
  }
  return { bought, fromOffcuts, wasteSf: Math.max(0, bought * T * V - usedSf), log };
}

/** Border tee pieces → tees: a tee has a connector at each end, so one tee yields
 *  at most TWO border pieces (one per end), when they fit its length together. */
export function planTeeCuts(cuts: number[], L: number): { pieces: number; reused: number } {
  const open: number[] = [];   // tees with one end used: remaining length
  let pieces = 0, reused = 0;
  for (const c of [...cuts].sort((a, b) => b - a)) {
    let k = -1, best = Infinity;
    open.forEach((r, i) => { if (r + 1e-6 >= c && r < best) { best = r; k = i; } });
    if (k >= 0) { open.splice(k, 1); reused++; }   // the second end of a tee already cut
    else { pieces++; open.push(L - c); }
  }
  return { pieces, reused };
}

/** Lengths into stock pieces (first-fit decreasing), each run split into whole sticks + a remainder. */
export function planSticks(lengths: number[], stick: number): { pieces: number; lf: number } {
  let pieces = 0;
  const rems: number[] = [];
  for (const L of lengths) { const n = Math.floor(L / stick + 1e-6); pieces += n; const r = L - n * stick; if (r > 0.05) rems.push(r); }
  const bins: number[] = [];
  for (const r of rems.sort((a, b) => b - a)) {
    const k = bins.findIndex((left) => left + 1e-6 >= r);
    if (k >= 0) bins[k] -= r; else { bins.push(stick - r); pieces++; }
  }
  return { pieces, lf: lengths.reduce((a, b) => a + b, 0) };
}

/** A whole job: rooms laid out, offcuts and tee ends shared across rooms. */
export function planJob(rooms: { poly: Pt[]; spec: GridSpec; holes?: Pt[][] }[], opts: { reuse?: boolean; mainStick?: number; angleStick?: number } = {}): JobGrid {
  const reuse = opts.reuse !== false;
  const laid = rooms.map((r, i) => layoutRoom(r.poly, r.spec, i, r.holes || []));
  // tiles grouped by tile size (2×2 and 2×4 offcuts don't mix)
  const bySize = new Map<string, { T: number; V: number; pieces: Piece[]; full: number }>();
  laid.forEach((g, i) => {
    const sp = rooms[i].spec, k = `${sp.tileU}x${sp.tileV}`;
    let e = bySize.get(k); if (!e) bySize.set(k, (e = { T: sp.tileU, V: sp.tileV, pieces: [], full: 0 }));
    e.pieces.push(...g.cutPieces); e.full += g.fullTiles;
  });
  let full = 0, cut = 0, fromOffcuts = 0, bought = 0, wasteSf = 0, naive = 0;
  const groups = new Map<string, JobGrid["cutList"][number]>();
  for (const e of bySize.values()) {
    const pr = planTileCuts(e.pieces, e.T, e.V, reuse);
    for (const c of pr.log) {
      const w = Math.round(c.w * 24) / 24, h = Math.round(c.h * 24) / 24;   // to the half inch
      const tile = `${e.V}×${e.T}`, k = `${tile}|${w}|${h}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { size: `${fmtFtIn(w)} × ${fmtFtIn(h)}`, w, h, tile, n: 0, fromOffcuts: 0, rooms: [] }));
      g.n++; if (c.from === "offcut") g.fromOffcuts++;
      if (!g.rooms.includes(c.room)) g.rooms.push(c.room);
    }
    const nv = planTileCuts(e.pieces, e.T, e.V, false);
    full += e.full; cut += e.pieces.length; fromOffcuts += pr.fromOffcuts; bought += e.full + pr.bought; wasteSf += pr.wasteSf; naive += e.full + nv.bought;
  }
  const c4 = planTeeCuts(laid.flatMap((g) => g.crossCuts), 4);
  const c2 = planTeeCuts(laid.flatMap((g) => g.cross2Cuts), 2);
  const mains = planSticks(laid.flatMap((g) => g.mainRuns), opts.mainStick || 12);
  const angle = planSticks(laid.flatMap((g) => g.wallEdges), opts.angleStick || 12);
  return {
    rooms: laid,
    tiles: { full, cut, fromOffcuts, bought, wasteSf: +wasteSf.toFixed(1), naiveBought: naive },
    cutList: [...groups.values()].sort((a, b) => b.n - a.n || b.w * b.h - a.w * a.h),
    mains,
    cross4: { pieces: laid.reduce((n, g) => n + g.crossFull, 0) + c4.pieces, whole: laid.reduce((n, g) => n + g.crossFull, 0), cuts: c4.pieces + c4.reused, reusedCuts: c4.reused },
    cross2: { pieces: laid.reduce((n, g) => n + g.cross2Full, 0) + c2.pieces, whole: laid.reduce((n, g) => n + g.cross2Full, 0), cuts: c2.pieces + c2.reused, reusedCuts: c2.reused },
    wallAngle: angle,
    wires: laid.reduce((n, g) => n + g.wires, 0),
  };
}

// ── reading the grid drawn on a reflected ceiling plan ──────────────────────
/** From the RCP's linework inside a room: the grid's direction, module and
 *  phase, or null when no regular grid is drawn there. segs in FEET. */
export function detectGrid(segsFt: number[], polyFt: Pt[]): { theta: number; tileU: number; tileV: number; phaseU: number; phaseV: number; fit: number } | null {
  const inside = (x: number, y: number) => {
    let ins = false;
    for (let i = 0, j = polyFt.length - 1; i < polyFt.length; j = i++) {
      const a = polyFt[i], b = polyFt[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) ins = !ins;
    }
    return ins;
  };
  // the room's box: segments are clipped to it (a grid line drawn once across
  // several rooms still counts here), then kept when their middle is in the room
  const bx0 = Math.min(...polyFt.map((p) => p[0])), bx1 = Math.max(...polyFt.map((p) => p[0]));
  const by0 = Math.min(...polyFt.map((p) => p[1])), by1 = Math.max(...polyFt.map((p) => p[1]));
  const lines: { th: number; x1: number; y1: number; x2: number; y2: number; len: number }[] = [];
  for (let i = 0; i + 3 < segsFt.length; i += 4) {
    let x1 = segsFt[i], y1 = segsFt[i + 1], x2 = segsFt[i + 2], y2 = segsFt[i + 3];
    if (Math.max(x1, x2) < bx0 || Math.min(x1, x2) > bx1 || Math.max(y1, y2) < by0 || Math.min(y1, y2) > by1) continue;
    // Liang–Barsky against the box
    const dx = x2 - x1, dy = y2 - y1;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x1 - bx0], [dx, bx1 - x1], [-dy, y1 - by0], [dy, by1 - y1]] as [number, number][]) {
      if (Math.abs(p) < 1e-12) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) continue;
    [x1, y1, x2, y2] = [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1.5 || !inside((x1 + x2) / 2, (y1 + y2) / 2)) continue;
    let th = Math.atan2(y2 - y1, x2 - x1); if (th < 0) th += Math.PI; if (th >= Math.PI) th -= Math.PI;
    lines.push({ th, x1, y1, x2, y2, len });
  }
  if (lines.length < 6) return null;
  // dominant direction (length-weighted, 1° bins, folded to 90°)
  const bins = new Array(90).fill(0);
  for (const l of lines) bins[Math.round((l.th * 180) / Math.PI) % 90] += l.len;
  const d0 = bins.indexOf(Math.max(...bins));
  const theta = (d0 * Math.PI) / 180;
  // a family's grid lines: offsets along its normal, merged when they coincide,
  // kept only when they run a good part of the room (fixtures, diffusers, tags
  // and leaders are short; a grid line crosses the room)
  const fam = (ang: number) => {
    const nx = -Math.sin(ang), ny = Math.cos(ang), tx = Math.cos(ang), ty = Math.sin(ang);
    const along = polyFt.map((p) => p[0] * tx + p[1] * ty);
    const span = Math.max(...along) - Math.min(...along);
    const raw = lines.filter((l) => { let d = Math.abs(l.th - ang) % Math.PI; d = Math.min(d, Math.PI - d); return d < 0.03; })
      .map((l) => ({ o: ((l.x1 + l.x2) / 2) * nx + ((l.y1 + l.y2) / 2) * ny, len: l.len }))
      .sort((a, b) => a.o - b.o);
    const merged: { o: number; len: number }[] = [];
    for (const r of raw) {
      const m = merged[merged.length - 1];
      if (m && r.o - m.o < 0.05) { m.o = (m.o * m.len + r.o * r.len) / (m.len + r.len); m.len += r.len; }
      else merged.push({ ...r });
    }
    const need = Math.max(1.5, Math.min(0.35 * span, 8));
    return merged.filter((m) => m.len >= need).map((m) => m.o);
  };
  return fitFamilies(theta, fam(theta), fam(theta + Math.PI / 2));
}

const MODULES = [2, 4, 600 / 304.8, 1200 / 304.8];
/** Best module and phase for one family's line offsets (ft), or null. */
function fitModule(offs: number[], minHits = 3): { pitch: number; phase: number; fit: number; err: number; n: number } | null {
  if (offs.length < minHits) return null;
  let bestFit = null as null | { pitch: number; phase: number; fit: number; err: number; n: number };
  const span = Math.max(...offs) - Math.min(...offs);
  for (const pitch of MODULES) {
    if (span < pitch * (minHits >= 3 ? 1.5 : 0.9)) continue;
    // phase: the offset most others agree with
    for (const ref of offs) {
      const hits = new Set<number>();
      let err = 0, n = 0;
      for (const o of offs) { const k = Math.round((o - ref) / pitch); const r = Math.abs(o - ref - k * pitch); if (r < 0.08) { hits.add(k); err += r; n++; } }
      const expected = Math.floor(span / pitch) + 1;
      const fit = hits.size / expected;
      if (hits.size < minHits || fit < 0.6) continue;   // most of the module's positions carry a line
      err /= Math.max(1, n);
      // the module that explains the most lines (a 4' reading of a 2' grid explains
      // only half of them); then the one whose positions are all filled (a 2' reading
      // of a 4' grid leaves gaps); then the most exact (4' vs 1200 mm); then the finer
      const better = !bestFit || n > bestFit.n
        || (n === bestFit.n && (fit > bestFit.fit + 1e-9
          || (Math.abs(fit - bestFit.fit) <= 1e-9 && (err < bestFit.err - 0.005 || (Math.abs(err - bestFit.err) <= 0.005 && pitch < bestFit.pitch)))));
      if (better) bestFit = { pitch, phase: ref, fit, err, n };
    }
  }
  return bestFit;
}
type GridRead = { theta: number; tileU: number; tileV: number; phaseU: number; phaseV: number; fit: number };
/** Two families (A along θ, offsets along (−sinθ, cosθ); B along θ+90°) → the grid. */
function fitFamilies(theta: number, offsA: number[], offsB: number[]): GridRead | null {
  // a narrow room (a corridor) has only two lines across: one family may settle
  // for two once the other has read cleanly
  let A = fitModule(offsA), B = fitModule(offsB);
  if (A && !B) B = fitModule(offsB, 2);
  else if (B && !A) A = fitModule(offsA, 2);
  if (!A || !B) return null;
  // u runs along the tile's long side: the direction in which lines are spaced further apart.
  if (B.pitch >= A.pitch) {
    // u along θ: the u-lines are family B (offsets along −u), the v-lines family A (offsets along v)
    return { theta, tileU: +B.pitch.toFixed(3), tileV: +A.pitch.toFixed(3), phaseU: -B.phase, phaseV: A.phase, fit: Math.min(A.fit, B.fit) };
  }
  return { theta: theta + Math.PI / 2, tileU: +A.pitch.toFixed(3), tileV: +B.pitch.toFixed(3), phaseU: A.phase, phaseV: B.phase, fit: Math.min(A.fit, B.fit) };
}

/** The same reading from PIXELS: the room drawn from the PDF, dark pixels as
 *  (x, y) pairs in sheet feet (already inside the room, walls trimmed). Works
 *  whatever the PDF made the grid of — lines, a pattern fill, a scan. */
export function detectGridRaster(dark: ArrayLike<number>, polyFt: Pt[], ftPerPx: number, theta0?: number): GridRead | null {
  const n = dark.length >> 1;
  if (n < 50) return null;
  const bin = ftPerPx;
  const profile = (ang: number) => {
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    let lo = Infinity, hi = -Infinity;
    for (const p of polyFt) { const o = p[0] * nx + p[1] * ny; if (o < lo) lo = o; if (o > hi) hi = o; }
    const m = Math.ceil((hi - lo) / bin) + 3;
    const h = new Float64Array(m);
    for (let i = 0; i < n; i++) { const k = Math.floor((dark[2 * i] * nx + dark[2 * i + 1] * ny - lo) / bin) + 1; if (k >= 0 && k < m) h[k] += bin; }
    return { h, lo };
  };
  const sharp = (ang: number) => { const { h } = profile(ang); let q = 0; for (let i = 0; i < h.length; i++) q += h[i] * h[i]; return q; };
  // direction: a line family makes the profile peaky (sum of squares), checked
  // at both families; walls already trimmed, so the grid dominates
  const score = (a: number) => sharp(a) + sharp(a + Math.PI / 2);
  let theta = theta0 ?? 0, bestS = -1;
  const tryA = (a: number) => { const sc = score(a); if (sc > bestS) { bestS = sc; theta = a; } };
  if (theta0 != null) tryA(theta0);
  for (let d = 0; d < 90; d += 3) tryA((d * Math.PI) / 180);
  const t1 = theta;
  for (let d = -3; d <= 3; d += 0.5) tryA(t1 + (d * Math.PI) / 180);
  theta = ((theta % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  const peaks = (ang: number) => {
    const tx = Math.cos(ang), ty = Math.sin(ang);
    const along = polyFt.map((p) => p[0] * tx + p[1] * ty);
    const span = Math.max(...along) - Math.min(...along);
    const need = Math.max(1.5, Math.min(0.35 * span, 8));
    const { h, lo } = profile(ang);
    const out: number[] = [];
    for (let i = 1; i + 1 < h.length; i++) {
      const v = h[i - 1] + h[i] + h[i + 1];   // a line 1–3 px wide
      if (v < need) continue;
      const l = h[i - 2 >= 0 ? i - 2 : 0] + h[i - 1] + h[i], r = h[i] + h[i + 1] + (h[i + 2] || 0);
      if (v >= l && v > r) out.push(lo + (i - 0.5) * bin);
    }
    return out;
  };
  return fitFamilies(theta, peaks(theta), peaks(theta + Math.PI / 2));
}

/** Which segments are ceiling-grid lines: members of a lattice of parallel lines
 *  at a ceiling module (2', 4', 600, 1200) — a neighbour at ±1 module on both
 *  sides, or at +1 and +2 one way. segs in px; pxPerFt the sheet scale. Lifting
 *  them off the boundary mask lets a room fill cross the tiles to the walls. */
export function classifyGridSegs(segs: ArrayLike<number>, pxPerFt: number): Uint8Array {
  const n = segs.length >> 2;
  const out = new Uint8Array(n);
  const minLen = 1.2 * pxPerFt, tol = 0.07 * pxPerFt, ob = 0.05 * pxPerFt;
  const key = (a: number, o: number) => a * 1e7 + o;
  const idx = new Map<number, number[]>();   // angle bin (½°) × offset bin → seg ids
  const A = new Int16Array(n), O = new Float64Array(n), L0 = new Float64Array(n), L1 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x1 = segs[4 * i], y1 = segs[4 * i + 1], x2 = segs[4 * i + 2], y2 = segs[4 * i + 3];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < minLen) { A[i] = -1; continue; }
    let th = Math.atan2(y2 - y1, x2 - x1); if (th < 0) th += Math.PI; if (th >= Math.PI) th -= Math.PI;
    const ab = Math.round((th * 360) / Math.PI) % 360;    // ½° bins over 180°
    const tA = (ab * Math.PI) / 360, nx = -Math.sin(tA), ny = Math.cos(tA), tx = Math.cos(tA), ty = Math.sin(tA);
    A[i] = ab; O[i] = ((x1 + x2) / 2) * nx + ((y1 + y2) / 2) * ny;
    const p = x1 * tx + y1 * ty, q = x2 * tx + y2 * ty;
    L0[i] = Math.min(p, q); L1[i] = Math.max(p, q);
    const k = key(ab, Math.round(O[i] / ob));
    let l = idx.get(k); if (!l) idx.set(k, (l = [])); l.push(i);
  }
  const near = (i: number, off: number) => {
    const want = O[i] + off, reach = 4 * pxPerFt;
    for (let da = -1; da <= 1; da++) {
      const ab = (A[i] + da + 360) % 360;
      const b0 = Math.round((want - tol) / ob), b1 = Math.round((want + tol) / ob);
      for (let b = b0; b <= b1; b++) {
        const l = idx.get(key(ab, b)); if (!l) continue;
        for (const j of l) if (j !== i && Math.abs(O[j] - want) <= tol && L1[j] > L0[i] - reach && L0[j] < L1[i] + reach) return true;
      }
    }
    return false;
  };
  // a wall face has its other face close by, running with it (grid lines never do;
  // a fixture's inset lines are too short to count)
  const wallPair = (i: number) => {
    const len = L1[i] - L0[i];
    for (let da = -1; da <= 1; da++) {
      const ab = (A[i] + da + 360) % 360;
      const b0 = Math.floor((O[i] - 0.9 * pxPerFt) / ob), b1 = Math.ceil((O[i] + 0.9 * pxPerFt) / ob);
      for (let b = b0; b <= b1; b++) {
        const l = idx.get(key(ab, b)); if (!l) continue;
        for (const j of l) {
          const d = Math.abs(O[j] - O[i]);
          if (j === i || d < 0.15 * pxPerFt || d > 0.9 * pxPerFt || L1[j] - L0[j] < 4.5 * pxPerFt) continue;   // 2×4 fixtures are 4′
          const ov = Math.min(L1[i], L1[j]) - Math.max(L0[i], L0[j]);
          if (ov >= 0.6 * Math.min(len, L1[j] - L0[j])) return true;
        }
      }
    }
    return false;
  };
  for (let i = 0; i < n; i++) {
    if (A[i] < 0 || wallPair(i)) continue;
    for (const m of MODULES) {
      const P = m * pxPerFt;
      const up = near(i, P), dn = near(i, -P);
      if ((up && dn) || (up && near(i, 2 * P)) || (dn && near(i, -2 * P))) { out[i] = 1; break; }
    }
  }
  return out;
}

// ── helpers for the canvas tool ─────────────────────────────────────────────
/** The room's main direction: its walls' length-weighted angle, folded to 90°. */
export function roomAngle(poly: Pt[]): number {
  const bins = new Array(180).fill(0);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.05) continue;
    let d = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    d = ((d % 90) + 90) % 90;
    bins[Math.round(d * 2) % 180] += L;   // ½° bins
  }
  return ((bins.indexOf(Math.max(...bins)) / 2) * Math.PI) / 180;
}

/** Tile size from an assembly's words: "2×4", "24x48", "600 x 1200" → { tileU: 4, tileV: 2 }. */
export function tileSizeFromText(text: string): { tileU: number; tileV: number } | null {
  const t = String(text || "").replace(/["'”″’]/g, "").replace(/(\d)\s*-\s*0\b/g, "$1").replace(/\s*by\s*/gi, " x ").toLowerCase();
  if (/\b(2\s*[x×]\s*4|4\s*[x×]\s*2|24\s*[x×]\s*48|48\s*[x×]\s*24|600\s*[x×]\s*1200|1200\s*[x×]\s*600)\b/.test(t)) return { tileU: 4, tileV: 2 };
  if (/\b(2\s*[x×]\s*2|24\s*[x×]\s*24|600\s*[x×]\s*600)\b/.test(t)) return { tileU: 2, tileV: 2 };
  return null;
}

/** Of the two orientations, the one that buys fewer tiles (then fewer cut pieces). */
export function bestTurn(poly: Pt[], spec: GridSpec, holes: Pt[][] = []): number {
  const score = (theta: number) => {
    const g = layoutRoom(poly, { ...spec, theta }, 0, holes);
    const t = planTileCuts(g.cutPieces, spec.tileU, spec.tileV);
    return (g.fullTiles + t.bought) * 1000 + g.cutPieces.length;
  };
  return score(spec.theta + Math.PI / 2) < score(spec.theta) ? spec.theta + Math.PI / 2 : spec.theta;
}

/** Grid frame (u, v) in feet → sheet feet. */
export function fromGrid(u: number, v: number, theta: number): Pt {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [u * c - v * s, u * s + v * c];
}

/** 3.5 → 3'-6"  ·  0.333 → 4" */
export function fmtFtIn(ft: number): string {
  const tot = Math.round(ft * 12 * 2) / 2;
  const f = Math.floor(tot / 12), i = tot - f * 12;
  if (!f) return `${i}"`;
  return i ? `${f}'-${i}"` : `${f}'-0"`;
}
