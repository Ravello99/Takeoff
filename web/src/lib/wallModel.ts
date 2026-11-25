// The wall checker — runs the boosted-tree model the server trains from your
// team's Find walls reviews (backend/wallmodel.py) on each found run's features
// (findWalls FEATURE_NAMES) and says how likely it is to be a real wall.
//
// The model is a small JSON file, so this runs in the browser with no AI
// server and works offline once downloaded. Pure module.
//
// Format "gbdt-v1":
//   { format, feature_names, base, trees: Node[][] , n, metrics, trained_at }
//   Node = [feature, threshold, left, right]  (go left when x[feature] <= threshold)
//        | [-1, value]                         (leaf; learning rate already applied)
// Score = sigmoid(base + Σ leaf values).

export type Node = [number, number, number?, number?];
export interface WallModel {
  format: "gbdt-v1";
  feature_names: string[];
  base: number;
  trees: Node[][];
  n?: number;
  metrics?: Record<string, number>;
  trained_at?: number;
}

/** Score the checker gives a run (0–1): below DROP it starts dropped, below DOUBT it is flagged. */
export const DROP_BELOW = 0.2;
export const DOUBT_BELOW = 0.6;

export function isWallModel(m: unknown): m is WallModel {
  const x = m as WallModel;
  return !!x && x.format === "gbdt-v1" && Array.isArray(x.trees) && Array.isArray(x.feature_names) && typeof x.base === "number";
}

/** Map a model trained on feature list A onto vectors laid out by list B (append-only lists → usually identity). */
export function featureIndexMap(model: WallModel, names: readonly string[]): number[] {
  return model.feature_names.map((n) => names.indexOf(n));
}

export function scoreRun(model: WallModel, x: ArrayLike<number>, map?: number[]): number {
  let z = model.base;
  for (const tree of model.trees) {
    let i = 0;
    for (let guard = 0; guard < 64; guard++) {
      const nd = tree[i];
      if (!nd) break;
      if (nd[0] < 0) { z += nd[1]; break; }
      const fi = map ? map[nd[0]] : nd[0];
      const v = fi != null && fi >= 0 && fi < x.length ? Number(x[fi]) || 0 : 0;
      i = (v <= nd[1] ? nd[2] : nd[3]) as number;
    }
  }
  return 1 / (1 + Math.exp(-z));
}
