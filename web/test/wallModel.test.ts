// The wall checker's browser runtime (lib/wallModel.ts) against a hand-built
// model, and the feature list kept in step with the server trainer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreRun, isWallModel, featureIndexMap, type WallModel } from "../src/lib/wallModel.ts";
import { FEATURE_NAMES } from "../src/lib/findWalls.ts";

const model: WallModel = {
  format: "gbdt-v1", feature_names: ["thick_in", "hatch_per_ft"], base: 0,
  trees: [
    [[0, 3, 1, 2], [-1, -2], [-1, 1]],          // thin → strongly not a wall
    [[1, 0.5, 1, 2], [-1, -0.5], [-1, 0.8]],    // hatched → more likely
  ],
};

test("scores follow the trees: base + leaves through a sigmoid", () => {
  assert.ok(isWallModel(model));
  const s = (thick: number, hatch: number) => scoreRun(model, [thick, hatch]);
  assert.ok(Math.abs(s(2, 0) - 1 / (1 + Math.exp(2.5))) < 1e-9);
  assert.ok(Math.abs(s(6, 3) - 1 / (1 + Math.exp(-1.8))) < 1e-9);
  assert.ok(s(6, 3) > 0.8 && s(2, 0) < 0.1);
});

test("a model's features are found by name in the current list", () => {
  const map = featureIndexMap(model, FEATURE_NAMES);
  const x = FEATURE_NAMES.map((n) => (n === "thick_in" ? 6 : n === "hatch_per_ft" ? 3 : 0));
  assert.equal(scoreRun(model, x, map), scoreRun(model, [6, 3]));
  assert.equal(isWallModel({ format: "x" }), false);
});

test("the browser and the server trainer share one feature list", () => {
  const py = readFileSync(new URL("../../backend/wallmodel.py", import.meta.url), "utf8");
  const list = py.slice(py.indexOf("FEATURE_NAMES = ["), py.indexOf("]", py.indexOf("FEATURE_NAMES = [")));
  const names = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, [...FEATURE_NAMES]);
});
