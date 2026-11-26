// Ceiling rooms (lib/ceilingRooms.ts): finding grid ceilings with nobody drawing them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findGridRooms } from "../src/lib/ceilingRooms.ts";
import { detectGrid } from "../src/lib/ceilingGrid.ts";

test("two grid rooms and a gypsum room: the grid rooms are found to their walls, the bulkhead comes back as a hole", async () => {
  const ppf = 10, segs: number[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => segs.push(x1 * ppf, y1 * ppf, x2 * ppf, y2 * ppf);
  const box = (x0: number, y0: number, x1: number, y1: number) => { line(x0, y0, x1, y0); line(x1, y0, x1, y1); line(x1, y1, x0, y1); line(x0, y1, x0, y0); };
  // three rooms side by side, 5" walls: A 20×14 (2×2 grid, with a 6'×4' bulkhead), B 16×14 (2×4 grid), C 12×14 (gypsum, no grid)
  box(1, 1, 21, 15); box(0.6, 0.6, 21.4, 15.4);
  box(21.4, 1, 37.4, 15); box(21.8, 1.4, 37, 14.6);
  box(37.4, 1, 49.4, 15); box(37.8, 1.4, 49, 14.6);
  box(7, 6, 13, 10);                                                     // bulkhead outline in A (off the grid lines)
  for (let x = 2; x < 21; x += 2) { if (x > 7 && x < 13) { line(x, 1, x, 6); line(x, 10, x, 15); } else line(x, 1, x, 15); }
  for (let y = 3; y < 15; y += 2) { if (y > 6 && y < 10) { line(1, y, 7, y); line(13, y, 21, y); } else line(1, y, 21, y); }
  for (let x = 23.4; x < 37; x += 4) line(x, 1.4, x, 14.6);
  for (let y = 2.4; y < 14.6; y += 2) line(21.8, y, 37, y);
  const r = await findGridRooms({ segs, w: 520, h: 170, pxPerFt: ppf });
  assert.equal(r.rooms.length, 2);
  const [a, b] = [...r.rooms].sort((p, q) => p.ring[0][0] - q.ring[0][0]);
  assert.ok(Math.abs(a.areaSf - 256) < 15, `A ${a.areaSf}`);         // 20×14 less the 6×4 bulkhead (enclosed, not in the fill)
  assert.ok(Math.abs(b.areaSf - 202) < 20, `B ${b.areaSf}`);         // 15.2×13.2
  assert.equal(a.holes.length, 1);
  const k = 1 / ppf, ft = (ring: [number, number][]) => ring.map(([x, y]) => [x * k, y * k] as [number, number]);
  const segsFt = segs.map((v) => v * k);
  assert.deepEqual([detectGrid(segsFt, ft(a.ring))?.tileU, detectGrid(segsFt, ft(a.ring))?.tileV], [2, 2]);
  assert.deepEqual([detectGrid(segsFt, ft(b.ring))?.tileU, detectGrid(segsFt, ft(b.ring))?.tileV], [4, 2]);
});
