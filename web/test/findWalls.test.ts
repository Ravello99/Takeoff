// Find walls (lib/findWalls.ts) on a small synthetic plan at 18 px/ft:
//   - a 4⅞" partition drawn in the heavy wall pen, broken by a 3' door,
//     tagged P1 by a leader to one half;
//   - a second partition that tees into it and an isolated one, both untagged;
//   - a 7½" block wall drawn in the LIGHT pen, hatched, tagged B10 with no leader;
//   - casework double lines (24" apart) and a dimension string in the light pen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findWalls } from "../src/lib/findWalls.ts";

const PPF = 18, PPI = PPF / 12;
function scene() {
  const segs: number[] = [], width: number[] = [], lum: number[] = [];
  const add = (x1: number, y1: number, x2: number, y2: number, w: number) => { segs.push(x1, y1, x2, y2); width.push(w); lum.push(128); };
  const P1 = 4.875 * PPI;
  // partition A (heavy pen), door gap 300..354
  for (const [a, b] of [[100, 300], [354, 640]]) { add(a, 100, b, 100, 1.7); add(a, 100 + P1, b, 100 + P1, 1.7); }
  // partition B tees into A from below
  add(400, 100 + P1, 400, 400, 1.7); add(400 + P1, 100 + P1, 400 + P1, 400, 1.7);
  // partition D, alone
  add(800, 300, 800, 500, 1.7); add(800 + P1, 300, 800 + P1, 500, 1.7);
  // block wall C (light pen) with 45° hatch
  const B = 7.5 * PPI;
  add(100, 600, 500, 600, 0.7); add(100, 600 + B, 500, 600 + B, 0.7);
  for (let x = 104; x < 496; x += 6) add(x, 600 + B, x + B, 600, 0.5);
  // casework (light pen): two lines 24" apart — too far apart to be a wall
  add(100, 800, 500, 800, 0.7); add(100, 800 + 24 * PPI, 500, 800 + 24 * PPI, 0.7);
  // dimension string (light pen)
  add(100, 40, 640, 40, 0.7);
  // P1 leader from the tag bubble down to partition A's face
  add(250, 154, 250, 101, 0.5);
  const texts = [
    { str: "P1", x0: 245, y0: 155, x1: 255, y1: 165 },
    { str: "P1", x0: 900, y0: 900, x1: 910, y1: 910 },     // a second P1 elsewhere (tags must repeat to count)
    { str: "B10", x0: 290, y0: 650, x1: 306, y1: 660 },
    { str: "B10", x0: 900, y0: 1000, x1: 916, y1: 1010 },
  ];
  return { segs, width, lum, texts };
}

test("finds the partitions, splits at the door, tags by leader / run / thickness", () => {
  const r = findWalls({ ...scene(), pxPerFt: PPF });
  const horiz = r.walls.filter((w) => Math.abs(w.a[1] - w.b[1]) < 1 && w.a[1] < 200).sort((p, q) => p.a[0] - q.a[0]);
  assert.equal(horiz.length, 2, "partition A splits at its door");
  assert.ok(Math.abs(horiz[0].thickIn - 4.875) < 0.1);
  assert.equal(horiz[0].tag, "P1"); assert.equal(horiz[0].tagSource, "leader");
  assert.equal(horiz[1].tag, "P1"); assert.equal(horiz[1].tagSource, "run");
  const tee = r.walls.find((w) => Math.abs(w.a[0] - w.b[0]) < 1 && w.a[0] > 395 && w.a[0] < 410);
  assert.ok(tee, "the tee partition is found");
  assert.ok(Math.min(tee!.a[1], tee!.b[1]) < 100 + 2.5 * PPI, "its end extends to the centreline of the wall it lands on");
  assert.equal(tee!.tag, "P1"); assert.equal(tee!.tagSource, "thickness");
  const lone = r.walls.find((w) => w.a[0] > 790);
  assert.equal(lone?.tag, "P1");
});

test("a light-pen wall counts only when hatched; casework and dimensions do not", () => {
  const r = findWalls({ ...scene(), pxPerFt: PPF });
  const block = r.walls.find((w) => w.a[1] > 590 && w.a[1] < 620);
  assert.ok(block, "hatched block wall found");
  assert.ok(Math.abs(block!.thickIn - 7.5) < 0.1);
  assert.equal(block!.tag, "B10"); assert.equal(block!.tagSource, "near");
  assert.ok(!r.walls.some((w) => w.a[1] > 780), "casework is not a wall");
  assert.ok(!r.walls.some((w) => w.a[1] < 60), "a dimension string is not a wall");
  assert.equal(r.pens.length, 1);
  assert.equal(r.pens[0].width, 1.7);
});

test("layered faces stack into one wall; a chase splits into two", () => {
  const segs: number[] = [], width: number[] = [];
  const add = (y: number) => { segs.push(0, y, 400, y); width.push(1); };
  // board | stud | board drawn as four lines: one 4⅞" wall
  for (const yi of [0, 0.625, 4.25, 4.875]) add(100 + yi * PPI);
  // two 3⅝" stud walls either side of a 10" chase (total 17¼" — too thick for one wall)
  for (const yi of [0, 3.625, 13.625, 17.25]) add(300 + yi * PPI);
  const r = findWalls({ segs, width, pxPerFt: PPF });
  const near = (y: number) => r.walls.filter((w) => Math.abs(w.a[1] - y) < 4 * PPI);
  assert.equal(near(100 + 2.44 * PPI).length, 1);
  assert.ok(Math.abs(near(100 + 2.44 * PPI)[0].thickIn - 4.875) < 0.1);
  const chase = r.walls.filter((w) => w.a[1] > 290 && w.a[1] < 340).map((w) => w.thickIn).sort();
  assert.deepEqual(chase.map((t) => Math.round(t * 8) / 8), [3.625, 3.625]);
});

test("empty and scaleless input are harmless", () => {
  assert.equal(findWalls({ segs: [], pxPerFt: 18 }).walls.length, 0);
  assert.ok(Array.isArray(findWalls({ segs: [0, 0, 10, 0], pxPerFt: 0 }).walls));
});
