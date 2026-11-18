// Vanguard Takeoff — default conditions for commercial interior drywall.
//
// A fresh workspace is seeded with these when the browser's template library
// is empty (lib/canvasUtil.js seedConditions). Each condition is a template:
// a short tag (rename it to match the wall/ceiling tags on your drawings),
// a colour/hatch, a default height for wall types, a waste %, and the
// material lines that turn the measured quantity into an order list.
//
// HOW EACH ONE IS MEASURED (spec.remarks repeats this on the condition):
//   Wall types   → Wall tool (surface area): trace the wall line, the height
//                  gives wall SF (one face) and the traced length gives LF.
//   Ceilings     → Area tool: trace the ceiling area; its perimeter feeds the
//                  "perimeter" basis (wall angle / edge trim).
//   Bulkheads    → Wall tool with height = girth (drop + soffit width).
//   Trims/backing→ Linear tool.     Frames/panels → Count tool.
//
// LAYERS / O.C.: board_layers (per side) and stud_oc_in on a condition
// re-scale material lines tagged `scale` (see lib/assembly.js), so the
// top-bar Layers and O.C. inputs change board, screw, stud and channel counts.
//
// MATERIAL RATES: `per` = one unit of material per X of the basis
//   area      = the condition's measured SF (walls: ONE face of wall)
//   linear    = LF (walls: length of wall; linear items: run length)
//   perimeter = perimeter LF of the condition's areas
//   count     = EA
// Board rates include 10% waste (the condition's waste % only adjusts the
// SF/LF columns, not material lines). Every rate is a STARTING POINT based
// on common commercial practice; replace them with Vanguard's own production
// numbers in the Materials editor or the Library tab.

const BOARD_4x12_SF = 48;
const BOARD_WASTE = 1.10;
const r2 = (n) => Math.round(n * 100) / 100;
// wall SF (one face) per 4×12 sheet, for `faces` total board layers
const boardPer = (layers) => r2(BOARD_4x12_SF / (layers * BOARD_WASTE));

// layersBase = board layers per side the screw rate is written for; the
// condition's Layers input scales screws with board (lib/assembly.js).
const finishLines = (facesFinished, layersBase = 1) => [
  { name: "Screws, 1-1/4\" Type S (box of 1,000)", per: r2(1000 / (facesFinished * layersBase)), basis: "area", unit: "box", note: "≈1 screw per SF of board", scale: "layers", layers_base: layersBase },
  { name: "Joint tape, paper (500' roll)", per: r2(1350 / facesFinished), basis: "area", unit: "roll", note: "≈0.37 LF tape per SF of finished face" },
  { name: "Joint compound, all-purpose (4.5 gal box)", per: r2(490 / facesFinished), basis: "area", unit: "box", note: "Level 4 finish" },
];

const studs = (size, gauge, oc = 16) => ({
  name: `Stud ${size} ${gauge} @ ${oc}" o.c.`, per: r2(oc / 13.2), basis: "linear", unit: "stud", scale: "oc_stud",
  note: "per LF of wall, incl. ~10% for corners/openings — cut to wall height",
});
const track = (size, gauge) => ({
  name: `Track ${size} ${gauge}, top & bottom (10' pc)`, per: 4.75, basis: "linear", unit: "pc", note: "2 LF track per LF of wall + 5%",
});
const deckTrack = (size, gauge) => [
  { name: `Track ${size} ${gauge}, bottom (10' pc)`, per: 9.5, basis: "linear", unit: "pc", note: "1 LF per LF of wall + 5%" },
  { name: `Deflection track ${size}, slotted top (10' pc)`, per: 9.5, basis: "linear", unit: "pc", note: "head of wall at deck" },
];
const batts = (thk) => ({ name: `Acoustic batt insulation ${thk}`, per: 1, basis: "area", unit: "SF", note: "fills one face of wall" });

const WALL = "Measure: Wall tool — trace the wall line; set height to top of wall";
const CEIL = "Measure: Area tool — trace the ceiling area";

export const DRYWALL_DEFAULTS = [
  // ── Partitions ────────────────────────────────────────────────────────────
  { finish_tag: "W1", measure: "wall", board_layers: 1, stud_oc_in: 16, color: "#0B2556", hatch: "solid", waste_pct: 10, height_ft: 10,
    spec: { description: "Non-rated partition: 3-5/8\" 25ga studs @ 16\" o.c., 1 layer 5/8\" Type X each side, to 6\" above ceiling", remarks: WALL },
    materials: [studs("3-5/8\"", "25ga"), track("3-5/8\"", "25ga"),
      { name: "Gypsum board 5/8\" Type X, 4×12", per: boardPer(2), basis: "area", unit: "sheet", scale: "layers", layers_base: 1, note: "1 layer each side, incl. 10% waste" },
      ...finishLines(2)] },
  { finish_tag: "W2", measure: "wall", board_layers: 1, stud_oc_in: 16, color: "#1E3A70", hatch: "horiz", waste_pct: 10, height_ft: 10,
    spec: { description: "Acoustic partition: 3-5/8\" 25ga studs @ 16\" o.c., 1 layer 5/8\" Type X each side, 3-1/2\" sound batts, to 6\" above ceiling", remarks: WALL },
    materials: [studs("3-5/8\"", "25ga"), track("3-5/8\"", "25ga"),
      { name: "Gypsum board 5/8\" Type X, 4×12", per: boardPer(2), basis: "area", unit: "sheet", scale: "layers", layers_base: 1, note: "1 layer each side, incl. 10% waste" },
      batts("3-1/2\""), { name: "Acoustic sealant (tube)", per: 30, basis: "linear", unit: "tube", note: "top & bottom beads, both sides" },
      ...finishLines(2)] },
  { finish_tag: "W3", measure: "wall", board_layers: 1, stud_oc_in: 16, color: "#B4973A", hatch: "vert", waste_pct: 10, height_ft: 14,
    spec: { description: "1-hr rated partition to deck: 3-5/8\" 20ga studs @ 16\" o.c., 1 layer 5/8\" Type X each side, slotted deflection head", remarks: WALL + " (deck)" },
    materials: [studs("3-5/8\"", "20ga"), ...deckTrack("3-5/8\"", "20ga"),
      { name: "Gypsum board 5/8\" Type X, 4×12", per: boardPer(2), basis: "area", unit: "sheet", scale: "layers", layers_base: 1, note: "1 layer each side, incl. 10% waste" },
      ...finishLines(2)] },
  { finish_tag: "W4", measure: "wall", board_layers: 1, stud_oc_in: 16, color: "#8C7428", hatch: "grid", waste_pct: 10, height_ft: 14,
    spec: { description: "1-hr rated acoustic partition to deck: 6\" 20ga studs @ 16\" o.c., 1 layer 5/8\" Type X each side, 6\" sound batts, slotted deflection head", remarks: WALL + " (deck)" },
    materials: [studs("6\"", "20ga"), ...deckTrack("6\"", "20ga"),
      { name: "Gypsum board 5/8\" Type X, 4×12", per: boardPer(2), basis: "area", unit: "sheet", scale: "layers", layers_base: 1, note: "1 layer each side, incl. 10% waste" },
      batts("6\""), { name: "Acoustic sealant (tube)", per: 30, basis: "linear", unit: "tube", note: "top & bottom beads, both sides" },
      ...finishLines(2)] },
  { finish_tag: "W5", measure: "wall", board_layers: 2, stud_oc_in: 16, color: "#7a1f2b", hatch: "checker", waste_pct: 10, height_ft: 14,
    spec: { description: "2-hr rated partition to deck: 3-5/8\" 20ga studs @ 16\" o.c., 2 layers 5/8\" Type X each side, slotted deflection head", remarks: WALL + " (deck)" },
    materials: [studs("3-5/8\"", "20ga"), ...deckTrack("3-5/8\"", "20ga"),
      { name: "Gypsum board 5/8\" Type X, 4×12", per: boardPer(4), basis: "area", unit: "sheet", scale: "layers", layers_base: 2, note: "2 layers each side, incl. 10% waste" },
      ...finishLines(2, 2)] },
  { finish_tag: "W6", measure: "wall", board_layers: 1, stud_oc_in: 16, color: "#2f7d54", hatch: "dots", waste_pct: 10, height_ft: 10,
    spec: { description: "Moisture-resistant partition: 3-5/8\" 20ga studs @ 16\" o.c., 1 layer 5/8\" Type X moisture/mould-resistant each side (washrooms, janitor rooms)", remarks: WALL },
    materials: [studs("3-5/8\"", "20ga"), track("3-5/8\"", "20ga"),
      { name: "Gypsum board 5/8\" Type X moisture-resistant, 4×12", per: boardPer(2), basis: "area", unit: "sheet", scale: "layers", layers_base: 1, note: "1 layer each side, incl. 10% waste" },
      ...finishLines(2)] },
  { finish_tag: "F1", measure: "wall", board_layers: 1, stud_oc_in: 16, color: "#475569", hatch: "plank", waste_pct: 10, height_ft: 10,
    spec: { description: "Furring on CMU/concrete: 7/8\" hat channel @ 16\" o.c., 1 layer 5/8\" Type X one side", remarks: WALL },
    materials: [
      { name: "Furring (hat) channel 7/8\" 25ga (12' pc)", per: 15.24, basis: "area", unit: "pc", note: "@ 16\" o.c. + 5%", scale: "oc_chan" },
      { name: "Gypsum board 5/8\" Type X, 4×12", per: boardPer(1), basis: "area", unit: "sheet", scale: "layers", layers_base: 1, note: "1 layer one side, incl. 10% waste" },
      { name: "Concrete fasteners (box of 100)", per: 150, basis: "area", unit: "box", note: "channel to substrate @ 24\" o.c." },
      ...finishLines(1)] },
  { finish_tag: "SW1", measure: "wall", board_layers: 2, stud_oc_in: 24, color: "#9333ea", hatch: "speckle", waste_pct: 10, height_ft: 14,
    spec: { description: "2-hr shaft wall: 2-1/2\" C-H studs @ 24\" o.c., 1\" shaftliner, 2 layers 5/8\" Type X corridor side", remarks: WALL + " (deck)" },
    materials: [
      { name: "C-H stud 2-1/2\" 20ga @ 24\" o.c.", per: 1.82, basis: "linear", unit: "stud", scale: "oc_stud", note: "per LF of wall — cut to height" },
      { name: "J-track 2-1/2\", top & bottom (10' pc)", per: 4.75, basis: "linear", unit: "pc", note: "2 LF per LF of wall + 5%" },
      { name: "Shaftliner 1\" Type X, 2×10", per: r2(20 / BOARD_WASTE), basis: "area", unit: "panel", note: "incl. 10% waste" },
      { name: "Gypsum board 5/8\" Type X, 4×12", per: boardPer(2), basis: "area", unit: "sheet", scale: "layers", layers_base: 2, note: "2 layers one side, incl. 10% waste" },
      ...finishLines(1, 2)] },

  // ── Ceilings ──────────────────────────────────────────────────────────────
  { finish_tag: "C1", measure: "area", color: "#0d9488", hatch: "grid", waste_pct: 5,
    spec: { description: "ACT ceiling, 2×2 tile, 15/16\" exposed tee grid", remarks: CEIL },
    materials: [
      { name: "Main tee 12' (@ 4' o.c.)", per: 48, basis: "area", unit: "pc" },
      { name: "Cross tee 4' (@ 2' o.c.)", per: 8, basis: "area", unit: "pc" },
      { name: "Cross tee 2' (2×2 layout)", per: 8, basis: "area", unit: "pc" },
      { name: "Ceiling tile 2×2", per: 3.8, basis: "area", unit: "tile", note: "incl. ~5% cuts/attic stock" },
      { name: "Hanger wire 12ga + anchor", per: 16, basis: "area", unit: "ea", note: "@ 4' × 4'" },
      { name: "Wall angle (12' pc)", per: 11.5, basis: "perimeter", unit: "pc" },
    ] },
  { finish_tag: "C2", measure: "area", color: "#14b8a6", hatch: "checker", waste_pct: 5,
    spec: { description: "ACT ceiling, 2×4 tile, 15/16\" exposed tee grid", remarks: CEIL },
    materials: [
      { name: "Main tee 12' (@ 4' o.c.)", per: 48, basis: "area", unit: "pc" },
      { name: "Cross tee 4' (@ 2' o.c.)", per: 8, basis: "area", unit: "pc" },
      { name: "Ceiling tile 2×4", per: 7.6, basis: "area", unit: "tile", note: "incl. ~5% cuts/attic stock" },
      { name: "Hanger wire 12ga + anchor", per: 16, basis: "area", unit: "ea", note: "@ 4' × 4'" },
      { name: "Wall angle (12' pc)", per: 11.5, basis: "perimeter", unit: "pc" },
    ] },
  { finish_tag: "C3", measure: "area", board_layers: 1, stud_oc_in: 16, color: "#2563eb", hatch: "solid", waste_pct: 10,
    spec: { description: "Gypsum board ceiling on drywall suspension grid, 1 layer 5/8\" Type X", remarks: CEIL },
    materials: [
      { name: "Drywall grid main tee 12' (@ 4' o.c.)", per: 48, basis: "area", unit: "pc" },
      { name: "Drywall grid cross tee 4' (@ 16\" o.c.)", per: 5.33, basis: "area", unit: "pc", scale: "oc_cross" },
      { name: "Hanger wire 12ga + anchor", per: 16, basis: "area", unit: "ea", note: "@ 4' × 4'" },
      { name: "Drywall grid wall angle (12' pc)", per: 11.5, basis: "perimeter", unit: "pc" },
      { name: "Gypsum board 5/8\" Type X ceiling, 4×12", per: boardPer(1), basis: "area", unit: "sheet", scale: "layers", layers_base: 1, note: "incl. 10% waste" },
      { name: "Screws, 1-1/4\" Type S (box of 1,000)", per: 750, basis: "area", unit: "box", note: "≈1.3 screws per SF" },
      { name: "Joint tape, paper (500' roll)", per: 1350, basis: "area", unit: "roll" },
      { name: "Joint compound, all-purpose (4.5 gal box)", per: 490, basis: "area", unit: "box", note: "Level 4 finish" },
    ] },
  { finish_tag: "C4", measure: "area", board_layers: 1, stud_oc_in: 16, color: "#1d4ed8", hatch: "horiz", waste_pct: 10,
    spec: { description: "Gypsum board ceiling on black iron: 1-1/2\" carrying channel @ 4' o.c., 7/8\" furring channel @ 16\" o.c., 1 layer 5/8\" Type X", remarks: CEIL },
    materials: [
      { name: "Carrying channel 1-1/2\" (12' pc)", per: 48, basis: "area", unit: "pc", note: "@ 4' o.c." },
      { name: "Furring (hat) channel 7/8\" (12' pc)", per: 15.24, basis: "area", unit: "pc", note: "@ 16\" o.c. + 5%", scale: "oc_chan" },
      { name: "Hanger wire 8ga + anchor", per: 16, basis: "area", unit: "ea", note: "@ 4' × 4'" },
      { name: "Tie wire 18ga (roll)", per: 1000, basis: "area", unit: "roll" },
      { name: "Gypsum board 5/8\" Type X ceiling, 4×12", per: boardPer(1), basis: "area", unit: "sheet", scale: "layers", layers_base: 1, note: "incl. 10% waste" },
      { name: "Screws, 1-1/4\" Type S (box of 1,000)", per: 750, basis: "area", unit: "box", note: "≈1.3 screws per SF" },
      { name: "Joint tape, paper (500' roll)", per: 1350, basis: "area", unit: "roll" },
      { name: "Joint compound, all-purpose (4.5 gal box)", per: 490, basis: "area", unit: "box", note: "Level 4 finish" },
    ] },
  { finish_tag: "BH1", measure: "wall", board_layers: 1, stud_oc_in: 16, color: "#c96442", hatch: "vert", waste_pct: 10, height_ft: 4,
    spec: { description: "Gypsum board bulkhead/soffit: 3-5/8\" 25ga framing, 1 layer 5/8\" Type X", remarks: "Measure: Wall tool — trace the bulkhead run; set height to the girth (drop + soffit width)" },
    materials: [
      { name: "Stud 3-5/8\" 25ga (framing members)", per: 1.21, basis: "linear", unit: "stud", scale: "oc_stud", note: "per LF of bulkhead, @ 16\" o.c." },
      { name: "Track 3-5/8\" 25ga (10' pc)", per: 3.3, basis: "linear", unit: "pc", note: "3 runs per LF of bulkhead" },
      { name: "Gypsum board 5/8\" Type X, 4×12", per: boardPer(1), basis: "area", unit: "sheet", scale: "layers", layers_base: 1, note: "girth SF, incl. 10% waste" },
      { name: "Outside corner bead (10' pc)", per: 5, basis: "linear", unit: "pc", note: "2 corners per LF of bulkhead" },
      ...finishLines(1.25)] },

  // ── Linear items ──────────────────────────────────────────────────────────
  { finish_tag: "CB", measure: "line", color: "#64748b", hatch: "solid", waste_pct: 5,
    spec: { description: "Outside corner bead", remarks: "Measure: Linear tool" },
    materials: [{ name: "Corner bead, metal (10' pc)", per: 10, basis: "linear", unit: "pc" }] },
  { finish_tag: "CJ", measure: "line", color: "#be185d", hatch: "solid", waste_pct: 5,
    spec: { description: "Control joint", remarks: "Measure: Linear tool" },
    materials: [{ name: "Control joint #093 (10' pc)", per: 10, basis: "linear", unit: "pc" }] },
  { finish_tag: "TRIM", measure: "line", color: "#a16207", hatch: "solid", waste_pct: 5,
    spec: { description: "L-bead / J-trim at dissimilar materials", remarks: "Measure: Linear tool" },
    materials: [{ name: "L-bead / J-trim (10' pc)", per: 10, basis: "linear", unit: "pc" }] },
  { finish_tag: "HOW", measure: "line", color: "#dc2626", hatch: "solid", waste_pct: 0,
    spec: { description: "Fire-rated head-of-wall joint (to listed system)", remarks: "Measure: Linear tool along rated walls at deck" },
    materials: [{ name: "Firestop sealant/spray (tube)", per: 15, basis: "linear", unit: "tube", note: "verify against the listed system" }] },
  { finish_tag: "BLK", measure: "line", color: "#92400e", hatch: "solid", waste_pct: 10,
    spec: { description: "Backing/blocking for millwork, grab bars, wall-mounted equipment", remarks: "Measure: Linear tool" },
    materials: [{ name: "Backing plate / blocking (10' pc)", per: 10, basis: "linear", unit: "pc" }] },

  // ── Counts ────────────────────────────────────────────────────────────────
  { finish_tag: "AP", measure: "count", color: "#0891b2", hatch: "solid", waste_pct: 0,
    spec: { description: "Access panel (supply/install)", remarks: "Measure: Count tool" }, materials: [] },
  { finish_tag: "DF", measure: "count", color: "#4f46e5", hatch: "solid", waste_pct: 0,
    spec: { description: "Hollow metal door frame (install in stud wall)", remarks: "Measure: Count tool" }, materials: [] },
];
