// The schedule finder (lib/scheduleFinder.ts) on synthetic text layers: a
// partition schedule laid out as columns of type blocks must outscore a door
// schedule's table of bare marks and a page of general notes, and its text
// must carry every wall type in reading order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findScheduleOnPage, type Tok } from "../src/lib/scheduleFinder.ts";

const H = 8;
function block(x: number, y: number, lines: string[]): Tok[] {
  return lines.map((str, i) => ({ str, x, y: y + i * H * 1.3, h: H, w: str.length * 0.55 * H }));
}
function partitionSheet(): Tok[] {
  const t: Tok[] = [...block(100, 50, ["INTERIOR PARTITIONS"])];
  const types = [
    ["INTERIOR PARTITION", "P1", "· 16mm GYPSUM WALL BOARD", "· 92mm METAL STUDS AT 400mm O.C", "· 16mm GYPSUM WALL BOARD"],
    ["INTERIOR PARTITION - W/ INSULATION", "P2", "· 16mm GYPSUM WALL BOARD", "· 92mm METAL STUDS AT 600mm O.C", "· 92mm MINERAL-WOOL SOUND ATTENUATION BATTS", "· 16mm GYPSUM WALL BOARD"],
    ["INTERIOR PARTITION - FURRING", "P4", "· 16mm GYPSUM WALL BOARD", "· 41mm METAL STUDS AT 400 mm O.C"],
  ];
  let y = 80;
  for (const ty of types) { t.push(...block(100, y, ty)); y += ty.length * H * 1.3 + 30; }
  t.push(...block(600, 80, ["ROOF - STEEL STRUCTURE", "R1", "· 13mm COVER BOARD", "· RIGID INSULATION", "· STEEL DECK"]));
  return t;
}
function doorSheet(): Tok[] {
  const t: Tok[] = [];
  for (let r = 0; r < 20; r++) t.push(...block(100, 50 + r * 14, [`D${r + 1}`]), ...block(160, 50 + r * 14, ["HM"]), ...block(220, 50 + r * 14, ["900"]));
  return t;
}
function notesSheet(): Tok[] {
  return block(100, 50, ["GENERAL NOTES", "1. ALL GYPSUM BOARD TO BE 16mm TYPE X UNLESS NOTED.", "2. METAL STUDS TO BE 25GA AT 400mm O.C.", "3. PROVIDE ACOUSTIC SEALANT AT ALL RATED PARTITIONS.", "4. REFER TO SPECIFICATIONS FOR INSULATION."]);
}

test("the partition schedule is found and read in order; roofs are left out", () => {
  const r = findScheduleOnPage(partitionSheet());
  assert.ok(r.score > 30);
  const marks = [...r.text.matchAll(/^(P\d)$/gm)].map((m) => m[1]);
  assert.deepEqual(marks, ["P1", "P2", "P4"]);
  assert.match(r.text, /MINERAL-WOOL SOUND ATTENUATION BATTS/);
  assert.doesNotMatch(r.text, /ROOF - STEEL/);
  assert.match(r.heading || "", /PARTITION/);
});

test("door tables and general notes are not schedules", () => {
  const sched = findScheduleOnPage(partitionSheet()).score;
  assert.equal(findScheduleOnPage(doorSheet()).score, 0);
  assert.ok(findScheduleOnPage(notesSheet()).score < sched / 2);
  assert.equal(findScheduleOnPage([]).score, 0);
});

test("a schedule with each mark beside its description (hexagon left, layers right) is found", () => {
  const t: Tok[] = [...block(400, 40, ["WALL SCHEDULE"])];
  const rows: [string, string[]][] = [
    ["WP-1", ["5/8\" TYPE X GYPSUM BOARD EACH SIDE", "3-5/8\" 20 GA METAL STUDS @ 16\" O.C.", "SOUND BATT INSULATION"]],
    ["WP-2", ["5/8\" GYPSUM BOARD ONE SIDE", "3-5/8\" METAL STUDS @ 16\" O.C."]],
    ["WP-3", ["2 LAYERS 5/8\" TYPE X GYPSUM BOARD", "6\" METAL STUDS @ 16\" O.C.", "1 HR RATED, UL U419"]],
  ];
  let y = 90;
  for (const [mark, desc] of rows) { t.push(...block(400, y + 10, [mark]), ...block(520, y, desc)); y += desc.length * H * 1.3 + 40; }
  const r = findScheduleOnPage(t);
  assert.ok(r.score > 30, `score ${r.score}`);
  for (const m of ["WP-1", "WP-2", "WP-3"]) assert.match(r.text, new RegExp(`^${m}$`, "m"));
  assert.match(r.text, /UL U419/);
});
