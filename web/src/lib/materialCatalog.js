// Vanguard — the material catalog: structured product data on each entry of
// the company material library, prices, price history, and the price-list
// import pipeline.
//
// Catalog fields (all optional, on top of name/unit/per/basis/note/scale/
// labor_* that assemblies use):
//   category, product, size, gauge, flange, length, manufacturer, supplier,
//   sku, unit_cost (number, $ per purchase unit), cost_updated (ISO date),
//   price_history [{ date, cost, source }] (newest first, capped)
//
// Price-list import is a pipeline built so AI can join it later:
//   rows (from a CSV today — from an AI read of a supplier's PDF booklet
//   tomorrow) → matchRows() → a reviewable list of changes → applyChanges().
// Nothing is written until someone approves the review.

export const MATERIAL_CATEGORIES = [
  "Steel framing", "Board", "Finishing", "Insulation", "Ceilings",
  "Fasteners", "Accessories & trims", "Firestopping & sealants", "Doors & frames", "Labor & misc",
];

const GUESS = [
  [/stud|track|channel|furring|c-h|j-track|deflection|header|angle iron/i, "Steel framing"],
  [/gypsum|board|shaftliner|sheathing|cement board/i, "Board"],
  [/tape|compound|mud|primer|corner bead|bead\b/i, "Finishing"],
  [/batt|insulation|mineral wool/i, "Insulation"],
  [/tile|tee|grid|wall angle|hanger|tie wire/i, "Ceilings"],
  [/screw|fastener|anchor|pin|nail/i, "Fasteners"],
  [/control joint|trim|l-bead|j-trim|reveal|backing|blocking/i, "Accessories & trims"],
  [/firestop|caulk|sealant|fire spray/i, "Firestopping & sealants"],
  [/door|frame|access panel/i, "Doors & frames"],
];
export function guessCategory(m) {
  if (m?.category) return m.category;
  const n = String(m?.name || m?.product || "");
  for (const [re, c] of GUESS) if (re.test(n)) return c;
  return "Labor & misc";
}

/** "Steel stud 3-5/8" 20ga, 1-1/4" flange, 10'" — the name assemblies show. */
export function buildName(m) {
  const head = [m.product, m.size, m.gauge].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
  const tail = [m.flange && `${String(m.flange).trim()} flange`, m.length].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
  return [head, tail].filter(Boolean).join(", ");
}

const r2 = (n) => Math.round(n * 100) / 100;
export const money = (n) => (n == null || n === "" || !Number.isFinite(Number(n)) ? "" : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** Set a new price, keeping a short history of what it was and where it came from. */
export function withPrice(m, cost, source, date = new Date().toISOString().slice(0, 10)) {
  const c = r2(Number(cost));
  if (!Number.isFinite(c) || c < 0) return m;
  if (Number(m.unit_cost) === c) return m;
  const history = [{ date, cost: c, source: source || "edited" }, ...(Array.isArray(m.price_history) ? m.price_history : [])].slice(0, 24);
  return { ...m, unit_cost: c, cost_updated: date, price_history: history };
}

// ── CSV (export / price-list import) ────────────────────────────────────────
export const CSV_COLUMNS = [
  ["sku", "SKU"], ["category", "Category"], ["product", "Product"], ["size", "Size"], ["gauge", "Gauge"],
  ["flange", "Flange"], ["length", "Length"], ["manufacturer", "Manufacturer"], ["supplier", "Supplier"],
  ["name", "Name"], ["unit", "Unit"], ["unit_cost", "Cost"], ["per", "Coverage per"], ["basis", "Coverage basis"],
  ["labor_rate", "Labor rate"], ["labor_unit", "Labor unit"], ["note", "Note"], ["cost_updated", "Price date"],
];

const esc = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(library) {
  const lines = [CSV_COLUMNS.map(([, h]) => h).join(",")];
  for (const m of library) lines.push(CSV_COLUMNS.map(([k]) => esc(k === "category" ? guessCategory(m) : m[k])).join(","));
  return lines.join("\n") + "\n";
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const t = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  if (!rows.length) return [];
  // header → field: accepts our headers and common supplier spellings
  const ALIAS = {
    sku: /^(sku|item ?#?|item ?(no|number|code)|product ?(code|#|no)|part ?(#|no|number)|code)$/i,
    unit_cost: /^(cost|price|unit ?(cost|price)|net ?price|your ?price)$/i,
    name: /^(name|description|item ?description|product ?description)$/i,
    unit: /^(unit|uom|u\/m|per)$/i,
  };
  const head = rows[0].map((h) => h.trim());
  const map = head.map((h) => {
    const own = CSV_COLUMNS.find(([, label]) => label.toLowerCase() === h.toLowerCase());
    if (own) return own[0];
    for (const [k, re] of Object.entries(ALIAS)) if (re.test(h)) return k;
    return null;
  });
  return rows.slice(1).map((r) => {
    const o = {};
    map.forEach((k, i) => { if (k && r[i] != null && String(r[i]).trim() !== "") o[k] = String(r[i]).trim(); });
    if (o.unit_cost != null) {
      const n = Number(String(o.unit_cost).replace(/[$,\s]/g, ""));
      o.unit_cost = Number.isFinite(n) ? n : undefined;
    }
    for (const k of ["per", "labor_rate"]) if (o[k] != null) { const n = Number(o[k]); o[k] = Number.isFinite(n) ? n : undefined; }
    return o;
  }).filter((o) => Object.keys(o).length);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Match imported rows to the library. Returns
 *   { changes: [{ id, name, sku, old, new }], added: [row], unmatched: [row] }
 * Matching: SKU first, then exact (normalised) name. `addNew` turns
 * unmatched rows that have a name into new catalog entries.
 */
export function matchRows(library, rows, { addNew = false } = {}) {
  const bySku = new Map(), byName = new Map();
  for (const m of library) {
    if (m.sku) bySku.set(norm(m.sku), m);
    byName.set(norm(m.name), m);
  }
  const changes = [], added = [], unmatched = [], seen = new Set();
  for (const r of rows) {
    const m = (r.sku && bySku.get(norm(r.sku))) || (r.name && byName.get(norm(r.name)));
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      if (r.unit_cost != null && Number(r.unit_cost) !== Number(m.unit_cost)) {
        changes.push({ id: m.id, name: m.name, sku: m.sku || r.sku || "", old: m.unit_cost ?? null, new: r.unit_cost });
      }
    } else if (!m && addNew && (r.name || r.product)) added.push(r);
    else if (!m) unmatched.push(r);
  }
  return { changes, added, unmatched };
}

/** Apply approved price changes (+ optional new entries) to the library. */
export function applyChanges(library, { changes = [], added = [] }, source, newId) {
  const byId = new Map(changes.map((c) => [c.id, c]));
  const next = library.map((m) => (byId.has(m.id) ? withPrice(m, byId.get(m.id).new, source) : m));
  for (const r of added) {
    const base = { id: newId(), name: r.name || buildName(r), unit: r.unit || "ea", per: r.per || 1, basis: r.basis || "area", round: true, note: r.note || "",
      ...Object.fromEntries(["category", "product", "size", "gauge", "flange", "length", "manufacturer", "supplier", "sku", "labor_unit"].filter((k) => r[k]).map((k) => [k, r[k]])),
      ...(r.labor_rate ? { labor_rate: r.labor_rate } : {}) };
    next.push(r.unit_cost != null ? withPrice(base, r.unit_cost, source) : base);
  }
  return next;
}

/** Push catalog prices/product data into assembly lines linked to them. */
export const CATALOG_SYNC_FIELDS = ["unit_cost", "sku", "manufacturer", "supplier"];
export function syncAssemblies(templates, library) {
  const byId = new Map(library.map((m) => [m.id, m]));
  let changed = false;
  const next = templates.map((t) => {
    let touched = false;
    const materials = (t.materials || []).map((line) => {
      const lm = line.lib_id && byId.get(line.lib_id);
      if (!lm) return line;
      const patch = {};
      for (const k of CATALOG_SYNC_FIELDS) if (lm[k] !== undefined && lm[k] !== line[k]) patch[k] = lm[k];
      if (!Object.keys(patch).length) return line;
      touched = true;
      return { ...line, ...patch };
    });
    if (!touched) return t;
    changed = true;
    return { ...t, materials };
  });
  return changed ? next : templates;
}
