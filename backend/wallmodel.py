"""Vanguard Takeoff — the wall checker's trainer.

Learns "is this Find-walls run a real wall?" from the team's reviews (every run
an estimator kept or dropped), as a small gradient-boosted decision-tree model.
Plain Python on purpose: it runs on the Takeoff server with nothing to install
and no GPU, in seconds for the first thousands of reviews. The model is saved
as JSON (format "gbdt-v1") and runs in the browser (web/src/lib/wallModel.ts).

    model = train(rows)        # rows: [{"f": [...features], "y": 0|1, "sheet": "..."}]
    model["metrics"]           # accuracy / AUC on sheets held out from training
"""
from __future__ import annotations

import hashlib
import math
import random
import time

FORMAT = "gbdt-v1"
# Mirrors web/src/lib/findWalls.ts FEATURE_NAMES (append-only on both sides).
FEATURE_NAMES = [
    "thick_in", "log_len_ft", "off_axis_deg", "main_pen", "pen_width_rel", "pen_lum", "hatch_per_ft",
    "tag_leader", "tag_near", "tag_run", "tag_thickness", "tag_none",
    "junctions", "free_ends", "text_near", "pos_x", "pos_y", "parallel_runs", "thick_vs_tag_in", "thick_share",
]
FEATURE_VERSION = 1
MIN_ROWS = 40            # fewer reviews than this can't teach anything yet
MAX_ROWS = 25000         # most recent reviews kept for one training run
MAX_BINS = 32


def _sigmoid(z: float) -> float:
    if z < -35:
        return 0.0
    if z > 35:
        return 1.0
    return 1.0 / (1.0 + math.exp(-z))


def _bin_edges(col: list[float]) -> list[float]:
    vals = sorted(set(col))
    if len(vals) <= MAX_BINS:
        # split points between neighbouring distinct values
        return [(vals[i] + vals[i + 1]) / 2 for i in range(len(vals) - 1)]
    s = sorted(col)
    edges = []
    for k in range(1, MAX_BINS):
        v = s[min(len(s) - 1, (k * len(s)) // MAX_BINS)]
        if not edges or v > edges[-1]:
            edges.append(v)
    return edges


def _bin_index(v: float, edges: list[float]) -> int:
    lo, hi = 0, len(edges)
    while lo < hi:                  # first edge >= v
        mid = (lo + hi) // 2
        if edges[mid] < v:
            lo = mid + 1
        else:
            hi = mid
    return lo                       # bin b holds values <= edges[b] (b < len(edges)), else the top bin


def _build_tree(rows: list[int], B: list[list[int]], edges: list[list[float]], g: list[float], h: list[float],
                depth: int, min_leaf: int, lam: float, lr: float) -> list[list]:
    """Greedy histogram tree on gradients g / hessians h. Returns flat node list."""
    nodes: list[list] = []

    def leaf_value(idx):
        G = sum(g[i] for i in idx)
        H = sum(h[i] for i in idx)
        return -lr * G / (H + lam)

    def grow(idx: list[int], d: int) -> int:
        me = len(nodes)
        nodes.append([-1, 0.0])
        if d >= depth or len(idx) < 2 * min_leaf:
            nodes[me] = [-1, round(leaf_value(idx), 6)]
            return me
        G = sum(g[i] for i in idx)
        H = sum(h[i] for i in idx)
        parent = G * G / (H + lam)
        best = (0.0, -1, -1)
        for f in range(len(edges)):
            nb = len(edges[f]) + 1
            if nb < 2:
                continue
            hg = [0.0] * nb
            hh = [0.0] * nb
            hc = [0] * nb
            col = B[f]
            for i in idx:
                b = col[i]
                hg[b] += g[i]; hh[b] += h[i]; hc[b] += 1
            gl = hl = 0.0
            cl = 0
            for b in range(nb - 1):
                gl += hg[b]; hl += hh[b]; cl += hc[b]
                cr = len(idx) - cl
                if cl < min_leaf or cr < min_leaf:
                    continue
                gr, hr = G - gl, H - hl
                gain = gl * gl / (hl + lam) + gr * gr / (hr + lam) - parent
                if gain > best[0]:
                    best = (gain, f, b)
        gain, f, b = best
        if f < 0 or gain <= 1e-9:
            nodes[me] = [-1, round(leaf_value(idx), 6)]
            return me
        left = [i for i in idx if B[f][i] <= b]
        right = [i for i in idx if B[f][i] > b]
        li = grow(left, d + 1)
        ri = grow(right, d + 1)
        nodes[me] = [f, edges[f][b], li, ri, b]   # b (the bin) is for training only; stripped on save
        return me

    grow(rows, 0)
    return nodes


def predict(model: dict, x: list[float]) -> float:
    z = model["base"]
    for tree in model["trees"]:
        i = 0
        for _ in range(64):
            nd = tree[i]
            if nd[0] < 0:
                z += nd[1]
                break
            v = x[nd[0]] if nd[0] < len(x) else 0.0
            i = nd[2] if v <= nd[1] else nd[3]
    return _sigmoid(z)


def _auc(scores: list[float], ys: list[int]) -> float | None:
    pos = sum(ys)
    neg = len(ys) - pos
    if not pos or not neg:
        return None
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    rank_sum, k = 0.0, 0
    while k < len(order):           # average ranks over ties
        j = k
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[k]]:
            j += 1
        r = (k + j) / 2 + 1
        for t in range(k, j + 1):
            if ys[order[t]]:
                rank_sum += r
        k = j + 1
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


def _holdout(rows: list[dict]) -> tuple[list[int], list[int]]:
    """Hold out whole SHEETS (runs on one sheet look alike, so a random split
    would grade the model on near-copies of what it trained on)."""
    sheets = sorted({r.get("sheet") or "" for r in rows})
    if len(sheets) >= 5:
        valid_sheets = {s for s in sheets if int(hashlib.sha1(s.encode()).hexdigest(), 16) % 5 == 0}
        if not valid_sheets:
            valid_sheets = {sheets[-1]}
        tr = [i for i, r in enumerate(rows) if (r.get("sheet") or "") not in valid_sheets]
        va = [i for i, r in enumerate(rows) if (r.get("sheet") or "") in valid_sheets]
        if tr and va:
            return tr, va
    idx = list(range(len(rows)))
    random.Random(7).shuffle(idx)
    cut = max(1, len(idx) // 5)
    return idx[cut:], idx[:cut]


def train(rows: list[dict], feature_names: list[str], rounds: int = 80, depth: int = 3, lr: float = 0.15, lam: float = 1.0) -> dict:
    rows = [r for r in rows if isinstance(r.get("f"), list) and r.get("y") in (0, 1)][-MAX_ROWS:]
    n = len(rows)
    ys_all = [int(r["y"]) for r in rows]
    if n < MIN_ROWS or sum(ys_all) in (0, n):
        raise ValueError(f"Need at least {MIN_ROWS} reviewed runs with both kept and dropped ones (have {n}, {n - sum(ys_all)} dropped).")
    nf = len(feature_names)
    X = [[float(v) if isinstance(v, (int, float)) and math.isfinite(v) else 0.0 for v in (list(r["f"]) + [0.0] * nf)[:nf]] for r in rows]
    t0 = time.time()
    tr, va = _holdout(rows)

    def fit(train_idx: list[int], valid_idx: list[int] | None, rounds: int = rounds):
        cols = [[X[i][f] for i in train_idx] for f in range(nf)]
        edges = [_bin_edges(c) for c in cols]
        B = [[_bin_index(X[i][f], edges[f]) for i in range(n)] for f in range(nf)]
        y = ys_all
        p0 = min(0.99, max(0.01, sum(y[i] for i in train_idx) / len(train_idx)))
        base = math.log(p0 / (1 - p0))
        z = [base] * n
        min_leaf = max(5, len(train_idx) // 200)
        trees, best, best_k, since = [], float("inf"), 0, 0
        for k in range(rounds):
            g = [0.0] * n
            h = [0.0] * n
            for i in train_idx:
                p = _sigmoid(z[i])
                g[i] = p - y[i]
                h[i] = max(p * (1 - p), 1e-6)
            tree = _build_tree(train_idx, B, edges, g, h, depth, min_leaf, lam, lr)
            trees.append(tree)
            # update every row's margin (train and valid) with this tree
            for i in range(n):
                j = 0
                while True:
                    nd = tree[j]
                    if nd[0] < 0:
                        z[i] += nd[1]
                        break
                    j = nd[2] if B[nd[0]][i] <= nd[4] else nd[3]
            if valid_idx:
                loss = -sum(math.log(max(1e-9, _sigmoid(z[i]) if y[i] else 1 - _sigmoid(z[i]))) for i in valid_idx) / len(valid_idx)
                if loss < best - 1e-5:
                    best, best_k, since = loss, k + 1, 0
                else:
                    since += 1
                    if since >= 12:
                        break
        if valid_idx and best_k:
            trees = trees[:best_k]
        clean = [[nd[:4] if nd[0] >= 0 else nd for nd in t] for t in trees]
        return {"format": FORMAT, "feature_names": list(feature_names), "base": round(base, 6), "trees": clean}

    model = fit(tr, va)
    sv = [predict(model, X[i]) for i in va]
    yv = [ys_all[i] for i in va]
    acc = sum(1 for s, t in zip(sv, yv) if (s >= 0.5) == bool(t)) / len(va)
    dropped = [i for i, t in enumerate(yv) if not t]
    caught = sum(1 for i in dropped if sv[i] < 0.5)
    wrongly = sum(1 for i, t in enumerate(yv) if t and sv[i] < 0.2)
    metrics = {
        "rows": n, "train_rows": len(tr), "check_rows": len(va),
        "accuracy": round(acc, 4), "auc": None if (a := _auc(sv, yv)) is None else round(a, 4),
        "kept_share": round(sum(ys_all) / n, 4),
        "junk_caught": round(caught / len(dropped), 4) if dropped else None,     # dropped runs the model would flag
        "walls_lost": round(wrongly / max(1, sum(yv)), 4),                        # real walls it would pre-drop (score < 0.2)
        "trees": len(model["trees"]),
    }
    # the model that ships learns from every review, with as many trees as the check settled on
    final = fit(list(range(n)), None, rounds=max(1, len(model["trees"])))
    final["n"] = n
    final["metrics"] = metrics
    final["trained_at"] = time.time()
    final["seconds"] = round(time.time() - t0, 2)
    return final
