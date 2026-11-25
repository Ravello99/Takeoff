// Scope notes (lib/notesFinder.ts): the keynote block is what gets read, and a
// note's keynote mark (via its leader) or room name finds the right walls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notesText, locateNotes } from "../src/lib/notesFinder.ts";
import type { FoundWall } from "../src/lib/findWalls.ts";

const H = 8;
const block = (x: number, y: number, lines: string[]) => lines.map((str, i) => ({ str, x, y: y + i * H * 1.3, h: H, w: str.length * 0.55 * H }));

test("the keynotes block is chosen over the title block", () => {
  const toks = [
    ...block(100, 100, ["KEYNOTES", "1. NEW GYPSUM BOARD ON EXISTING WALL, PATCH AS REQUIRED", "4. FUR OUT EXISTING EXTERIOR WALL W/ 1-5/8\" STUDS", "6. EXISTING WALL TO REMAIN — NO WORK"]),
    ...block(900, 900, ["PROJECT NO. 2207", "DRAWN BY: AB", "SCALE: 1/4\" = 1'-0\""]),
  ];
  const t = notesText(toks);
  assert.match(t, /FUR OUT EXISTING EXTERIOR WALL/);
  assert.doesNotMatch(t, /DRAWN BY/);
});

const wall = (id: number, a: [number, number], b: [number, number]): FoundWall => ({ id, a, b, thickPx: 6, thickIn: 4.9, lengthFt: 10, tag: null, tagSource: null, confidence: 0.3, features: [], existing: true });

test("a keynote mark's leader and a room name point at their walls", () => {
  // a square room 100..300 × 100..300 plus a far wall
  const walls = [wall(0, [100, 100], [300, 100]), wall(1, [300, 100], [300, 300]), wall(2, [300, 300], [100, 300]), wall(3, [100, 300], [100, 100]), wall(4, [600, 100], [600, 300])];
  // keynote "4" at (520,200) with a leader to the far wall
  const segs = [528, 200, 598, 200];
  const texts = [
    { str: "4", x0: 516, y0: 196, x1: 524, y1: 204 },
    { str: "EXAM 7", x0: 180, y0: 195, x1: 220, y1: 205 },
    { str: "4", x0: 2000, y0: 2000, x1: 2008, y1: 2008 },   // a "4" nowhere near a wall
  ];
  const r = locateNotes({ segs, texts, pxPerFt: 18 }, walls, [{ mark: "4" }, { rooms: ["EXAM 7"] }, { mark: "9" }]);
  assert.deepEqual(r[0].walls, [4]);
  assert.equal(r[0].marks, 2);
  assert.deepEqual([...r[1].walls].sort(), [0, 1, 2, 3]);
  assert.deepEqual(r[2], { walls: [], marks: 0 });
});
