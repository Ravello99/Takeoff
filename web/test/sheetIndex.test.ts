import { test } from "node:test";
import assert from "node:assert/strict";
import { titleBlockText, sheetDisplayName, isOurSheet } from "../src/lib/sheetIndex.ts";

test("title block and drawing titles are what the AI is sent", () => {
  const toks = [
    { str: "PROPOSED FLOOR PLAN", x: 300, y: 900, h: 24 },
    { str: "EXAM 7", x: 200, y: 300, h: 8 },
    { str: "GREYSTONE", x: 1500, y: 100, h: 10 },
    { str: "A2.0", x: 1520, y: 1000, h: 14 },
    { str: "WELL HEALTH", x: 1500, y: 600, h: 9 },
  ];
  const t = titleBlockText(toks, 1600, 1100);
  assert.match(t, /^PROPOSED FLOOR PLAN/);
  assert.match(t, /A2\.0/);
  assert.match(t, /GREYSTONE/);
});

test("display name and our-sheet flag", () => {
  assert.equal(sheetDisplayName({ number: "A2.0", title: "Proposed Floor Plan" }), "A2.0 Proposed Floor Plan");
  assert.equal(sheetDisplayName({ title: "Cover" }), "Cover");
  assert.equal(sheetDisplayName(null), null);
  assert.equal(isOurSheet({ kind: "floor_plan", interior_partitions: true }), true);
  assert.equal(isOurSheet({ kind: "electrical" }), false);
  assert.equal(isOurSheet({ kind: "wall_types" }), true);
});
