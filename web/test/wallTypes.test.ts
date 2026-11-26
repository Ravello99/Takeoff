// Typical walls by geometry (lib/wallTypes.ts): untagged runs take the type
// whose finished thickness they measure, else the typical type; plan tags,
// existing walls and masonry are left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { typeThickness, typeUntaggedWalls, type WallTypeRule } from "../src/lib/wallTypes.ts";
import type { FoundWall } from "../src/lib/findWalls.ts";

const types: WallTypeRule[] = [
  { tag: "WP-1", typical: true, condition: "none", stud_in: 3.625, board_in: 0.5, layers_per_side: 1, sides: 2 },
  { tag: "WP-2", typical: false, condition: "pocket_door", stud_in: 6, board_in: 0.5 },
  { tag: "WP-3", typical: false, condition: "rated", stud_in: 3.625, board_in: 0.625, layers_per_side: 2, sides: 2 },
];
const wall = (id: number, thickIn: number, extra: Partial<FoundWall> = {}): FoundWall => ({ id, a: [0, 0], b: [100, 0], thickPx: 8, thickIn, lengthFt: 10, tag: null, tagSource: null, confidence: 0.3, features: [], existing: false, ...extra });

test("finished thickness from the build-up", () => {
  assert.equal(typeThickness(types[0]), 4.625);
  assert.equal(typeThickness(types[1]), 7);
  assert.equal(typeThickness(types[2]), 6.125);
});

test("untagged runs typed by thickness, else typical; tags, existing and masonry untouched", () => {
  const walls = [
    wall(1, 4.7),                                         // ≈ 4⅝" → WP-1 (thickness)
    wall(2, 7.1),                                         // ≈ 7" → WP-2 pocket door
    wall(3, 6.0),                                         // ≈ 6⅛" → WP-3
    wall(4, 5.4),                                         // between types → typical WP-1
    wall(5, 12),                                          // masonry/exterior → left untagged
    wall(6, 4.6, { tag: "WP-3", tagSource: "leader" }),  // a real plan tag stands
    wall(7, 4.6, { existing: true }),                     // existing stays out
    wall(8, 7.0, { tag: "P1", tagSource: "thickness" }),  // a learned-thickness guess yields to the schedule
  ];
  const r = typeUntaggedWalls(walls, types);
  assert.deepEqual(r.get(1), { tag: "WP-1", via: "schedule_thickness" });
  assert.deepEqual(r.get(2), { tag: "WP-2", via: "schedule_thickness" });
  assert.deepEqual(r.get(3), { tag: "WP-3", via: "schedule_thickness" });
  assert.deepEqual(r.get(4), { tag: "WP-1", via: "typical" });
  assert.equal(r.has(5), false);
  assert.equal(r.has(6), false);
  assert.equal(r.has(7), false);
  assert.deepEqual(r.get(8), { tag: "WP-2", via: "schedule_thickness" });
});
