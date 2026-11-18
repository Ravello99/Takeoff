// Vanguard — drywall assembly parameters on a condition.
//
//   board_layers : layers of board PER SIDE (1, 2, 3)
//   stud_oc_in   : stud / channel spacing in inches (12, 16, 19.2, 24)
//
// Material lines opt in with `scale`:
//   "layers"   — board and screws: the line's `per` was written for
//                `layers_base` layers per side; more layers → proportionally
//                more material.
//   "oc_stud"  — studs per LF of wall: 12/oc studs per foot + 10% for
//                corners/openings.
//   "oc_chan"  — 12' channel pieces per SF (furring/hat channel @ oc) + 5%.
//   "oc_cross" — 4' cross tees per SF (drywall grid crosses @ oc).
// A line without `scale`, or a condition without the field, keeps its
// written `per` — so every older condition and template computes exactly as
// before.

export const STUD_OC_OPTIONS = [12, 16, 19.2, 24];
export const LAYER_OPTIONS = [1, 2, 3];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const r2 = (n) => Math.round(n * 100) / 100;

/** The `per` (basis units per 1 unit of material) after applying the
 *  condition's layers / O.C. to a scaled material line. */
export function effectivePer(m, c) {
  const per = num(m?.per);
  if (!per || !m?.scale) return per;
  if (m.scale === "layers") {
    const layers = num(c?.board_layers);
    const base = num(m.layers_base) || 1;
    return layers ? r2((per * base) / layers) : per;
  }
  const oc = num(c?.stud_oc_in);
  if (!oc) return per;
  if (m.scale === "oc_stud") return r2(oc / 13.2);          // 1 / ((12/oc) × 1.10)
  if (m.scale === "oc_chan") return r2(oc / 1.05);          // 12' pc covers oc SF at oc spacing, +5%
  if (m.scale === "oc_cross") return r2((4 * oc) / 12);     // 4' tee covers 4 × oc/12 SF
  return per;
}

const fmtOc = (oc) => `${String(oc).replace(/\.0+$/, "")}"`;

/** Name/note with the spacing and layer count the line is actually priced at. */
export function scaledText(m, c) {
  let name = m?.name || "";
  let note = m?.note || "";
  const oc = num(c?.stud_oc_in);
  if (oc && String(m?.scale || "").startsWith("oc_")) {
    name = name.replace(/@ ?[\d.]+" ?o\.c\./, `@ ${fmtOc(oc)} o.c.`);
    note = note.replace(/@ ?[\d.]+" ?o\.c\./, `@ ${fmtOc(oc)} o.c.`);
  }
  const layers = num(c?.board_layers);
  if (layers && m?.scale === "layers") {
    note = note.replace(/\b\d+ layers?\b/, `${layers} layer${layers === 1 ? "" : "s"}`);
  }
  return { name, note };
}
