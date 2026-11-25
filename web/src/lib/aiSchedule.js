// Vanguard — turn wall types read by the AI from a partition schedule into
// assemblies. Each wall type starts from the closest Vanguard default
// (shaft wall, furring, 2-layer rated, acoustic, to-deck, standard) and is
// then adjusted: tag, description, stud size/gauge/spacing, board layers,
// height, insulation. Estimators review every row before it's created.
import { DRYWALL_DEFAULTS } from "./drywallDefaults.js";

const byTag = (tag) => DRYWALL_DEFAULTS.find((t) => t.finish_tag === tag);
const clone = (v) => JSON.parse(JSON.stringify(v));
const str = (v) => (v == null ? "" : String(v).trim());
const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Clean one AI row into the fields the review table edits. */
export function normalizeWall(w) {
  const height = str(w?.height).toLowerCase();
  const layers = num(w?.layers_per_side);
  const sides = num(w?.sides);
  return {
    tag: str(w?.tag) || "?",
    description: str(w?.description),
    stud_size: str(w?.stud_size),
    stud_gauge: str(w?.stud_gauge).replace(/\s*(gauge|ga\.?)$/i, "ga"),
    stud_oc: [12, 16, 19.2, 24].includes(num(w?.stud_oc)) ? num(w?.stud_oc) : (num(w?.stud_oc) || 16),
    board: str(w?.board),
    layers_per_side: layers && layers <= 4 ? layers : null,   // null = keep the base assembly's layers
    sides: sides === 1 ? 1 : 2,
    to_deck: /deck|structure|u\/s|underside|full height/.test(height) || (w?.shaft_wall === true && !height),
    height_text: str(w?.height),
    fire_rating: str(w?.fire_rating),
    insulation: str(w?.insulation),
    stc: str(w?.stc),
    shaft_wall: w?.shaft_wall === true || /shaft/i.test(`${w?.description} ${w?.notes}`),
    furring: w?.furring === true || /furr/i.test(`${w?.description} ${w?.stud_size}`),
    notes: str(w?.notes),
  };
}

/** Which Vanguard default this wall type is closest to. */
export function baseFor(w) {
  if (w.shaft_wall) return "SW1";
  if (w.furring || w.sides === 1) return "F1";
  if ((w.layers_per_side || 1) >= 2) return "W5";
  if (w.insulation && w.to_deck) return "W4";
  if (w.insulation) return "W2";
  if (w.to_deck) return "W3";
  return "W1";
}

const describe = (w) => {
  if (w.description) return w.description;
  const parts = [
    w.stud_size && `${w.stud_size}${w.stud_gauge ? ` ${w.stud_gauge}` : ""} studs @ ${w.stud_oc}" o.c.`,
    w.board && `${w.layers_per_side || 1} layer${(w.layers_per_side || 1) > 1 ? "s" : ""} ${w.board} ${w.sides === 2 ? "each side" : "one side"}`,
    w.insulation, w.to_deck ? "to deck" : w.height_text, w.fire_rating,
  ].filter(Boolean);
  return parts.join(", ");
};

/** One reviewed wall type → an assembly (template) ready for the library or a project. */
export function wallToAssembly(w) {
  const t = clone(byTag(baseFor(w)) || byTag("W1"));
  t.finish_tag = w.tag;
  t.category = w.shaft_wall ? "Shaft walls" : w.furring || w.sides === 1 ? "Furring" : "Walls";
  t.measure = "wall";
  t.stud_oc_in = w.stud_oc;
  if (w.layers_per_side) t.board_layers = w.layers_per_side;
  t.height_ft = w.to_deck ? 14 : 10;
  t.spec = { ...(t.spec || {}), description: describe(w),
    remarks: `Read by AI from the partition schedule${w.fire_rating ? ` · ${w.fire_rating}` : ""}${w.stc ? ` · STC ${w.stc}` : ""}${w.notes ? ` · ${w.notes}` : ""}` };
  // stud / track / board names follow the schedule
  const size = w.stud_size, gauge = w.stud_gauge;
  t.materials = t.materials.map((m) => {
    let name = m.name;
    if (size && /^(Stud|Track|Deflection track|C-H stud|J-track)\b/.test(name)) {
      name = name.replace(/(\d+(-\d+\/\d+)?"|\d+-\d+\/\d+")/, size.replace(/\s*C-H$/i, ""));
      if (gauge) name = name.replace(/\b\d{2}ga\b/, gauge);
    }
    if (w.board && /^Gypsum board/.test(name)) name = `Gypsum board ${w.board}, 4×12`;
    return name === m.name ? m : { ...m, name, lib_id: undefined };
  });
  // insulation the schedule calls for but the base doesn't have (and vice versa)
  const hasBatt = t.materials.some((m) => /batt|insulation/i.test(m.name));
  if (w.insulation && !hasBatt) t.materials.push({ name: `Acoustic batt insulation ${w.insulation}`, per: 1, basis: "area", unit: "SF", note: "fills one face of wall", labor_unit: "SF", labor_sides: 1 });
  if (!w.insulation && hasBatt) t.materials = t.materials.filter((m) => !/batt|insulation|acoustic sealant/i.test(m.name));
  return t;
}

/** Make tags unique against what already exists ("1A" → "1A (2)"). */
export function uniqueTags(assemblies, existing) {
  const taken = new Set(existing.map((t) => t.finish_tag));
  return assemblies.map((a) => {
    let tag = a.finish_tag, n = 2;
    while (taken.has(tag)) tag = `${a.finish_tag} (${n++})`;
    taken.add(tag);
    return tag === a.finish_tag ? a : { ...a, finish_tag: tag };
  });
}
