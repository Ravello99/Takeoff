// Ceiling grid (lib/ceilingGrid.ts): layouts, border sizes, cut tiles and
// offcut reuse, tees (two border pieces per tee), sticks, and reading the
// grid drawn on a reflected ceiling plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutRoom, planJob, planTileCuts, planTeeCuts, planSticks, detectGrid, layoutPhase, fmtFtIn, roomAngle, tileSizeFromText, bestTurn, fromGrid, type Pt } from "../src/lib/ceilingGrid.ts";

const rect = (w: number, h: number, x = 0, y = 0): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const G24 = { tileU: 4, tileV: 2, theta: 0 };

test("a 14' room in 2×4, balanced: 3' borders at both ends (≥ ½ tile), 1' of each border tile wasted", () => {
  const g = layoutRoom(rect(14, 10), { ...G24, mode: "balanced" });
  assert.deepEqual(g.lines.u, [3, 7, 11]);
  assert.equal(g.borders.uLow, 3); assert.equal(g.borders.uHigh, 3);
  assert.ok(g.centered.u && g.centered.v);
  assert.equal(g.fullTiles, 10);
  assert.equal(g.cutPieces.length, 10);
  assert.ok(g.cutPieces.every((p) => p.w === 3 && p.h === 2));
  const t = planTileCuts(g.cutPieces, 4, 2);
  assert.equal(t.bought, 10);            // a 1'×2' offcut can't make a 3'×2' border
  assert.equal(t.fromOffcuts, 0);
  assert.equal(t.wasteSf, 20);           // 10 tiles × 2 SF
  assert.deepEqual(g.slivers, []);
});

test("same room, max full tiles: 1' borders — four border pieces per tile", () => {
  const g = layoutRoom(rect(14, 10), { ...G24, mode: "max_full" });
  assert.equal(g.borders.uLow, 1); assert.equal(g.borders.uHigh, 1);
  assert.equal(g.fullTiles, 15);
  const t = planTileCuts(g.cutPieces, 4, 2);
  assert.equal(t.bought, 3);             // 10 pieces of 1'×2' from 3 tiles
  assert.equal(t.fromOffcuts, 7);
  assert.equal(g.slivers.length, 1);     // 1' borders are under ½ a 4' tile: flagged
});

test("offcuts travel between rooms: a 1'-6\" border's offcut becomes another room's 2'-6\" border", () => {
  const a = layoutRoom(rect(9, 2), { ...G24, mode: "wall" });       // 4 + 4 + 1 → one 1'×2' piece
  assert.deepEqual(a.cutPieces.map((p) => p.w), [1]);
  const job = planJob([
    { poly: rect(5.5, 2), spec: { ...G24, mode: "wall" } },          // 4 + 1.5
    { poly: rect(6.5, 2, 20, 0), spec: { ...G24, mode: "wall" } },   // 4 + 2.5
  ]);
  assert.equal(job.tiles.full, 2);
  assert.equal(job.tiles.cut, 2);
  assert.equal(job.tiles.fromOffcuts, 1);
  assert.equal(job.tiles.bought, 3);
  assert.equal(job.tiles.naiveBought, 4);
});

test("cross tees: whole 4' tees between mains, border tees pair up only when two fit one tee", () => {
  const bal = layoutRoom(rect(14, 10), { ...G24, mode: "balanced" });
  assert.equal(bal.crossFull, 8);                      // 4 v-lines × 2 bays between mains
  assert.deepEqual(bal.crossCuts, [3, 3, 3, 3, 3, 3, 3, 3]);
  assert.deepEqual(planTeeCuts(bal.crossCuts, 4), { pieces: 8, reused: 0 });
  const mf = layoutRoom(rect(14, 10), { ...G24, mode: "max_full" });
  assert.deepEqual(planTeeCuts(mf.crossCuts, 4), { pieces: 4, reused: 4 });
  assert.deepEqual(bal.mainRuns, [10, 10, 10]);
  assert.equal(bal.wires, 3 * 4);                      // ceil(10/4)+1 per 10' main
});

test("2×2 grid adds 2' cross tees between the mains", () => {
  const g = layoutRoom(rect(12, 8), { tileU: 2, tileV: 2, theta: 0, mode: "balanced" });
  assert.ok(g.lines.mains.length < g.lines.u.length);
  assert.ok(g.cross2Full > 0);
});

test("sticks: runs split into 12' pieces, remainders share sticks", () => {
  assert.deepEqual(planSticks([10, 10, 10], 12), { pieces: 3, lf: 30 });
  assert.deepEqual(planSticks([26, 4, 4], 12), { pieces: 3, lf: 34 });   // 12+12 · (2+4+4) in one stick
});

test("an L-shaped room: tiles clipped to the polygon, wall angle follows every wall", () => {
  const L: Pt[] = [[0, 0], [12, 0], [12, 6], [6, 6], [6, 10], [0, 10]];
  const g = layoutRoom(L, { ...G24, mode: "balanced" });
  assert.equal(Math.round(g.areaSf), 96);
  assert.equal(Math.round(g.perimeterLf), 44);
  assert.equal(g.wallEdges.length, 6);
  const covered = g.fullTiles * 8 + g.cutPieces.reduce((n, p) => n + p.w * p.h, 0);
  // a cut piece is bought as its bounding rectangle: never less than the floor, at most a tile more here
  assert.ok(covered >= 96 - 0.5 && covered <= 96 + 8, `covered ${covered}`);
});

test("reading a drawn 2×4 grid off the reflected ceiling plan", () => {
  const segs: number[] = [];
  for (const y of [2, 4, 6, 8]) segs.push(0, y, 14, y);       // tile long side along x: lines every 2' across
  for (const x of [3, 7, 11]) segs.push(x, 0, x, 10);         // and every 4' along
  const d = detectGrid(segs, rect(14, 10));
  assert.ok(d);
  assert.equal(d!.tileU, 4); assert.equal(d!.tileV, 2);
  assert.ok(Math.abs(d!.theta) < 1e-9);
  const g = layoutRoom(rect(14, 10), { tileU: d!.tileU, tileV: d!.tileV, theta: d!.theta, mode: "designed", phaseU: d!.phaseU, phaseV: d!.phaseV });
  assert.deepEqual(g.lines.u, [3, 7, 11]);
  assert.deepEqual(g.lines.v, [2, 4, 6, 8]);
  assert.equal(detectGrid([0, 0, 1, 0], rect(14, 10)), null);
});

test("phases and formatting", () => {
  assert.equal(layoutPhase(0, 16, 4, "balanced"), 0);        // fits exactly: no borders
  assert.equal(layoutPhase(0, 13, 4, "balanced"), 2.5);      // rem 1 → (1+4)/2
  assert.equal(fmtFtIn(3.5), "3'-6\"");
  assert.equal(fmtFtIn(1 / 3), "4\"");
});

test("canvas helpers: room angle, tile size from words, the better turn, frame round trip", () => {
  const a = 30 * Math.PI / 180;
  const tilted = rect(14, 10).map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] as Pt);
  assert.ok(Math.abs(roomAngle(tilted) - a) < 0.01);
  assert.deepEqual(tileSizeFromText('ACT ceiling, 2×4 tile, 15/16" grid'), { tileU: 4, tileV: 2 });
  assert.deepEqual(tileSizeFromText("24\" x 24\" lay-in"), { tileU: 2, tileV: 2 });
  assert.deepEqual(tileSizeFromText("600 x 1200 mineral fibre"), { tileU: 4, tileV: 2 });
  assert.equal(tileSizeFromText("GWB ceiling on drywall grid"), null);
  // 10' × 14' with 2×4: running the 4' side along the 10' side gives 2'-6" borders… along 14' gives 3' — the tool picks the cheaper
  const th = bestTurn(rect(10, 14), { tileU: 4, tileV: 2, theta: 0 });
  const g = layoutRoom(rect(10, 14), { tileU: 4, tileV: 2, theta: th });
  const other = layoutRoom(rect(10, 14), { tileU: 4, tileV: 2, theta: th + Math.PI / 2 });
  const cost = (r: typeof g) => r.fullTiles + planTileCuts(r.cutPieces, 4, 2).bought;
  assert.ok(cost(g) <= cost(other));
  const [x, y] = fromGrid(3, 4, a);
  const back = [x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a)];
  assert.ok(Math.abs(back[0] - 3) < 1e-9 && Math.abs(back[1] - 4) < 1e-9);
});

test("job cut list: border pieces grouped by size, offcuts traced back to their room", () => {
  // room 0: 14' (3' borders → 1'×2' offcuts) · room 1: 13' (max_full → ½' borders that fit those offcuts)
  const job = planJob([
    { poly: rect(14, 10), spec: { ...G24, mode: "balanced" } },
    { poly: rect(13, 10, 20), spec: { ...G24, mode: "max_full" } },
  ]);
  const three = job.cutList.find((c) => c.w === 3 && c.h === 2);
  assert.ok(three && three.n === 10 && three.fromOffcuts === 0 && three.rooms.join() === "0");
  const reused = job.cutList.reduce((n, c) => n + c.fromOffcuts, 0);
  assert.equal(reused, job.tiles.fromOffcuts);
  assert.ok(reused > 0);
  assert.ok(job.tiles.bought < job.tiles.naiveBought);
  assert.ok(job.rooms[0].extent.u1 - job.rooms[0].extent.u0 === 14);
});
