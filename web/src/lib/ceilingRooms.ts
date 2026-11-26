// Ceiling rooms — find every grid ceiling on a reflected ceiling plan without
// anyone drawing it. The ceiling grid's own lines (classifyGridSegs) are lifted
// off the boundary mask, so a fill started on a tile runs to the room's walls
// instead of stopping at the tile's edge; each room is seeded from the grid
// itself, so rooms with no grid (gypsum, open to structure) are never offered.
// Islands inside a room big enough to be a bulkhead or soffit come back as holes.
//
// Pure (no DOM): segments in image px, results in image px.
import { buildMask, floodRegionSealed, sealRadiiFor, doorWedgeCapPx, minPassRadiusFor, traceRegion, MASK_MAX_DIM } from "./oneclick.ts";
import { classifyGridSegs, type Pt } from "./ceilingGrid.ts";

export interface FoundRoom { ring: Pt[]; holes: Pt[][]; areaSf: number; gridSegs: number }
export interface FindOpts {
  segs: number[]; meta?: Uint8Array | null; w: number; h: number; pxPerFt: number;
  skip?: Pt[][];              // rooms already drawn (image px): no seeds inside them
  minSf?: number; maxSf?: number; holeSf?: number; maxFloods?: number; maxMs?: number;
  onProgress?: (done: number, total: number) => void;   // seeds tried / seeds; the run yields to the page between slices
}

const MASK_PPF = 6;

const inPoly = (poly: Pt[], x: number, y: number) => {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) ins = !ins;
  }
  return ins;
};

export async function findGridRooms(o: FindOpts): Promise<{ rooms: FoundRoom[]; grid: Uint8Array; floods: number; stats?: Record<string, number>; truncated?: boolean }> {
  const { segs, w, h, pxPerFt } = o;
  const minSf = o.minSf ?? 12, maxSf = o.maxSf ?? 30000, holeSf = o.holeSf ?? 10;
  const maxFloods = o.maxFloods ?? 3000, t0 = Date.now(), maxMs = o.maxMs ?? 45000;
  const grid = classifyGridSegs(segs, pxPerFt);
  const n = segs.length >> 2;
  const keep: number[] = [];
  const meta: number[] = [];
  const mids: number[] = [];   // grid segment midpoints (px)
  for (let i = 0; i < n; i++) {
    if (grid[i]) { mids.push((segs[4 * i] + segs[4 * i + 2]) / 2, (segs[4 * i + 1] + segs[4 * i + 3]) / 2); continue; }
    keep.push(segs[4 * i], segs[4 * i + 1], segs[4 * i + 2], segs[4 * i + 3]);
    if (o.meta) meta.push(o.meta[i]);
  }
  if (mids.length < 12) return { rooms: [], grid, floods: 0 };
  // a fixed working resolution, ~6 mask px per foot, whatever the drawing's scale:
  // a 1/4" sheet at the usual cap would make every fill ~9× the work of a 1/8" one
  const maxDim = Math.min(MASK_MAX_DIM, Math.ceil((Math.max(w, h) * MASK_PPF) / pxPerFt));
  const mo = buildMask(keep, w, h, maxDim, o.meta ? Uint8Array.from(meta) : null, pxPerFt);
  const { mw, mh, ws } = mo;
  const mppf = ws * pxPerFt;                  // mask px per foot
  const taken = new Uint8Array(mw * mh);      // cells already inside a found room
  const rooms: FoundRoom[] = [];
  // seeds: just off each grid line, both sides (the middle of a tile row), in order
  const seeds: number[] = [];
  const cell = 2 * pxPerFt, seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (!grid[i]) continue;
    const x1 = segs[4 * i], y1 = segs[4 * i + 1], x2 = segs[4 * i + 2], y2 = segs[4 * i + 3];
    const L = Math.hypot(x2 - x1, y2 - y1); if (!L) continue;
    const nx = -(y2 - y1) / L, ny = (x2 - x1) / L;
    const steps = Math.max(1, Math.floor(L / cell));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps, mx = x1 + (x2 - x1) * t, my = y1 + (y2 - y1) * t;
      for (const sgn of [1, -1]) {
        const sx = mx + sgn * nx * 0.9 * pxPerFt, sy = my + sgn * ny * 0.9 * pxPerFt;
        const key = Math.round(sx / cell) * 100003 + Math.round(sy / cell);
        if (seen.has(key)) continue;
        seen.add(key); seeds.push(sx, sy);
      }
    }
  }
  // coarse first: one seed per 8' cell before any second seed, so a time-out never
  // leaves a whole part of the sheet untried
  {
    const big = 8 * pxPerFt, first: number[] = [], rest: number[] = [], got = new Set<number>();
    for (let s = 0; s + 1 < seeds.length; s += 2) {
      const k = Math.round(seeds[s] / big) * 100003 + Math.round(seeds[s + 1] / big);
      (got.has(k) ? rest : first).push(seeds[s], seeds[s + 1]); got.add(k);
    }
    seeds.length = 0; seeds.push(...first, ...rest);
  }
  const skip = o.skip || [];
  let floods = 0;
  const stats: Record<string, number> = {};
  const clear = Math.max(1, Math.round(0.35 * mppf));
  const seal = sealRadiiFor(mppf), wedge = doorWedgeCapPx(mppf), pass = minPassRadiusFor(mppf);
  let slice = Date.now(), truncated = false;
  for (let s = 0; s + 1 < seeds.length; s += 2) {
    if (floods >= maxFloods || Date.now() - t0 > maxMs) { truncated = true; break; }
    if (Date.now() - slice > 120) { o.onProgress?.(s >> 1, seeds.length >> 1); await new Promise((r) => setTimeout(r, 0)); slice = Date.now(); }
    const x = seeds[s], y = seeds[s + 1];
    const mx = Math.floor(x * ws), my = Math.floor(y * ws);
    if (mx < 0 || my < 0 || mx >= mw || my >= mh) continue;
    const mi = my * mw + mx;
    if (taken[mi] || mo.mask[mi]) continue;
    // open floor only: a seed in a wall cavity or crowded by a symbol would be nudged into a room already found
    let crowded = false;
    for (let dy = -clear; dy <= clear && !crowded; dy++) for (let dx = -clear; dx <= clear; dx++) {
      const xx = mx + dx, yy = my + dy;
      if (xx < 0 || yy < 0 || xx >= mw || yy >= mh || mo.mask[yy * mw + xx] || taken[yy * mw + xx]) { crowded = true; break; }
    }
    if (crowded) continue;
    if (skip.some((p) => inPoly(p, x, y))) continue;
    floods++;
    const f = floodRegionSealed(mo, x, y, undefined, seal, wedge, pass);
    if (f.status !== "ok") { taken[mi] = 1; stats[f.status] = (stats[f.status] || 0) + 1; continue; }
    const reg = f.region;
    const areaSf = f.count / (mppf * mppf);
    // a seed inside a fixture or symbol is nudged out into the room around it —
    // the same room again: drop it
    let over = 0;
    for (let i = 0; i < reg.length; i++) if (reg[i] && taken[i]) over++;
    const dup = over > 0.5 * f.count;
    taken[mi] = 1;
    if (dup) {
      for (let i = 0; i < reg.length; i++) if (reg[i]) taken[i] = 1; stats.dup = (stats.dup || 0) + 1; continue; }
    for (let i = 0; i < reg.length; i++) if (reg[i]) taken[i] = 1;
    if (areaSf < minSf || areaSf > maxSf) { stats.size = (stats.size || 0) + 1; continue; }
    // a grid room: grid lines run through it
    let gs = 0;
    for (let k = 0; k + 1 < mids.length; k += 2) {
      const qx = Math.floor(mids[k] * ws), qy = Math.floor(mids[k + 1] * ws);
      if (qx >= 0 && qy >= 0 && qx < mw && qy < mh && (reg[qy * mw + qx] || nearReg(reg, mw, mh, qx, qy))) gs++;
    }
    if (gs < 4) { stats.nogrid = (stats.nogrid || 0) + 1; const rr = traceRegion(f); if (rr.length >= 3) fillRing(taken, mw, mh, rr.map(([a, b]) => [a * ws, b * ws] as Pt)); continue; }
    const ring = traceRegion(f);
    if (ring.length < 3) continue;
    fillRing(taken, mw, mh, ring.map(([a, b]) => [a * ws, b * ws] as Pt));
    rooms.push({ ring, holes: islands(reg, mw, mh, ws, mppf, holeSf, taken), areaSf: +areaSf.toFixed(1), gridSegs: gs });
  }
  return { rooms, grid, floods, stats, truncated };
}

// a grid line sits ON the mask's free cells' edge after lifting: count it if a neighbour is in the room
function nearReg(reg: Uint8Array, mw: number, mh: number, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < mw && yy < mh && reg[yy * mw + xx]) return true;
  }
  return false;
}

/** Enclosed non-room patches (bulkheads, soffits, shafts) of at least minSf, as rings (image px). */
function islands(reg: Uint8Array, mw: number, mh: number, ws: number, mppf: number, minSf: number, taken?: Uint8Array): Pt[][] {
  let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (reg[y * mw + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return [];
  const bw = x1 - x0 + 3, bh = y1 - y0 + 3;               // one free ring of padding all round
  const lab = new Int32Array(bw * bh);                     // 0 unvisited, -1 room, -2 outside, k>0 island k
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const gx = x + x0 - 1, gy = y + y0 - 1;
    if (gx >= 0 && gy >= 0 && gx < mw && gy < mh && reg[gy * mw + gx]) lab[y * bw + x] = -1;
  }
  const fill = (start: number, v: number) => {
    const st = [start]; lab[start] = v; let c = 0;
    while (st.length) {
      const i = st.pop()!; c++;
      const x = i % bw, y = (i / bw) | 0;
      if (x > 0 && !lab[i - 1]) { lab[i - 1] = v; st.push(i - 1); }
      if (x < bw - 1 && !lab[i + 1]) { lab[i + 1] = v; st.push(i + 1); }
      if (y > 0 && !lab[i - bw]) { lab[i - bw] = v; st.push(i - bw); }
      if (y < bh - 1 && !lab[i + bw]) { lab[i + bw] = v; st.push(i + bw); }
    }
    return c;
  };
  fill(0, -2);
  const out: Pt[][] = [];
  let k = 0;
  for (let i = 0; i < lab.length; i++) {
    if (lab[i]) continue;
    const c = fill(i, ++k);
    // everything enclosed by the room (fixtures, symbols, bulkheads) is done with
    if (taken) for (let j = i; j < lab.length; j++) if (lab[j] === k) { const gx = (j % bw) + x0 - 1, gy = ((j / bw) | 0) + y0 - 1; if (gx >= 0 && gy >= 0 && gx < mw && gy < mh) taken[gy * mw + gx] = 1; }
    if (c / (mppf * mppf) < minSf) continue;
    const one = new Uint8Array(bw * bh);
    for (let j = 0; j < lab.length; j++) if (lab[j] === k) one[j] = 1;
    const ring = traceRegion({ region: one, mw: bw, mh: bh, ws });
    if (ring.length >= 3) out.push(ring.map(([x, y]) => [x + (x0 - 1) / ws, y + (y0 - 1) / ws] as Pt));
  }
  return out;
}

/** Mark every cell inside a ring (mask px) — even-odd scanline fill. */
function fillRing(buf: Uint8Array, mw: number, mh: number, ring: Pt[]) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of ring) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(mh - 1, Math.ceil(y1)); y++) {
    const cy = y + 0.5, xs: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > cy) !== (b[1] > cy)) xs.push(a[0] + ((cy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.floor(xs[k] - 1)); x <= Math.min(mw - 1, Math.ceil(xs[k + 1] + 1)); x++) buf[y * mw + x] = 1;
  }
}
