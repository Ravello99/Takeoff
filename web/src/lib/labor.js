// Vanguard — labor rates on assembly material lines.
//
// Each material line can carry a labor rate in the unit that suits it:
//   LF   — per linear foot: studs/track (LF of wall), bead, caulking, trims,
//          backing; perimeter-based lines (wall angle) use the perimeter
//   SF   — per square foot: hanging board, taping, insulation, ACT. For walls
//          SF = wall SF (one face) × sides, and lines that scale with board
//          layers also × layers per side — so "hang 5/8 X, $0.55/SF" on a
//          2-sided wall prices the board actually hung
//   EA   — per each: access panels, door frames (count assemblies)
//   unit — per purchased unit (per sheet, per stud, per tube)
// A "labor-only" line (kind: "labor") has no material to buy — it exists to
// carry an install rate (e.g. "Install HM frame — $85/EA") and is left out
// of the buy list.
//
// Fields on a material line: labor_rate (number, $), labor_unit (LF/SF/EA/
// unit, "" = no labor), labor_sides (walls, SF only; default 1).

export const LABOR_UNITS = [
  { id: "", label: "No labor" },
  { id: "LF", label: "per LF" },
  { id: "SF", label: "per SF" },
  { id: "EA", label: "per EA" },
  { id: "unit", label: "per unit bought" },
];

const RULES = [
  [/\b(screw|fastener|tie wire|hanger|cross tee|compound|mud|sealant \(tube\)|acoustic sealant)\b/i, ""],
  [/\b(stud|track|channel|furring|c-h|j-track|deflection|bead|control joint|trim|l-bead|j-trim|caulk|firestop|fire stop|backing|blocking|wall angle)\b/i, "LF"],
  [/\b(gypsum|board|shaftliner|batt|insulation|tape|tile|main tee|grid)\b/i, "SF"],
  [/\b(panel|frame|door)\b/i, "EA"],
];

/** A sensible labor unit for a material, from its name ("" = usually no labor). */
export function guessLaborUnit(m) {
  if (m?.kind === "labor") return m.basis === "count" ? "EA" : m.basis === "linear" ? "LF" : "SF";
  const name = String(m?.name || "");
  for (const [re, unit] of RULES) if (re.test(name)) return unit;
  return "";
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Labor for one material line.
 * ctx = the assembly's measured quantities (after multiplier):
 *   { sf, lf, ea, perim, qty (material qty), layers (board layers per side) }
 */
export function laborFor(m, ctx) {
  const unit = m?.labor_unit || "";
  const rate = num(m?.labor_rate);
  if (!unit) return null;
  let qty = 0;
  if (unit === "LF") qty = m.basis === "perimeter" ? ctx.perim : ctx.lf;
  else if (unit === "SF") qty = ctx.sf * (num(m.labor_sides) || 1) * (m.scale === "layers" ? (num(ctx.layers) || num(m.layers_base) || 1) : 1);
  else if (unit === "EA") qty = ctx.ea;
  else if (unit === "unit") qty = ctx.qty;
  qty = r2(qty);
  return { labor_unit: unit, labor_rate: rate, labor_qty: qty, labor_cost: r2(qty * rate) };
}

/** Every priced labor line across the report rows, plus the total. */
export function laborSummary(rows) {
  const lines = [];
  for (const r of rows || []) for (const m of r.materials || []) {
    if (!m.labor_unit || !(m.labor_rate > 0)) continue;
    lines.push({ finish_tag: r.finish_tag, name: m.name, qty: m.labor_qty, unit: m.labor_unit === "unit" ? (m.unit || "unit") : m.labor_unit, rate: m.labor_rate, cost: m.labor_cost });
  }
  return { lines, total: r2(lines.reduce((n, l) => n + l.cost, 0)) };
}
