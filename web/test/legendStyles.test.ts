// Wall legend matching (lib/legendStyles.ts): each legend entry's sample line
// beside its label is measured, and runs are matched to the closest sample.
import { test } from "node:test";
import assert from "node:assert/strict";
import { legendSamples, matchWallStyles } from "../src/lib/legendStyles.ts";
import type { FoundWall } from "../src/lib/findWalls.ts";

test("legend samples are measured and runs take the closest style", () => {
  const segs: number[] = [], width: number[] = [], lum: number[] = [];
  const add = (x1: number, y1: number, x2: number, y2: number, w: number, l: number) => { segs.push(x1, y1, x2, y2); width.push(w); lum.push(l); };
  // "NEW PARTITION": dark heavy sample left of the label at y≈100
  add(20, 96, 70, 96, 2, 0); add(20, 104, 70, 104, 2, 0);
  // "EXISTING WALL TO REMAIN": screened light sample at y≈140
  add(20, 136, 70, 136, 1, 170); add(20, 144, 70, 144, 1, 170);
  const texts = [
    { str: "NEW PARTITION", x0: 80, y0: 95, x1: 160, y1: 105 },
    { str: "EXISTING WALL TO REMAIN", x0: 80, y0: 135, x1: 220, y1: 145 },
  ];
  const samples = legendSamples({ segs, width, lum, texts }, [
    { label: "NEW PARTITION", meaning: "new_wall" },
    { label: "EXISTING WALL TO REMAIN", meaning: "existing_wall" },
    { label: "DOOR TAG", meaning: "door_tag", prefix: "D" },
  ]);
  assert.deepEqual(samples.map((s) => [s.meaning, s.lum, s.width]), [["new_wall", 0, 2], ["existing_wall", 170, 1]]);
  const wall = (id: number, penWidth: number, penLum: number): FoundWall => ({ id, a: [0, 0], b: [100, 0], thickPx: 6, thickIn: 5, lengthFt: 6, tag: null, tagSource: null, confidence: 0.3, features: [], existing: false, penWidth, penLum, hatchPerFt: 0 });
  const m = matchWallStyles([wall(0, 2, 10), wall(1, 1.1, 160), wall(2, 5, 90)], samples);
  assert.equal(m[0]?.meaning, "new_wall");
  assert.equal(m[1]?.meaning, "existing_wall");
  assert.equal(m[2], null);   // matches neither closely
});
