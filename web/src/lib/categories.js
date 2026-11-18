// Vanguard — assembly categories, so lists read the way an estimator thinks:
// walls, ceilings, bulkheads… An assembly's `category` is set explicitly
// (Assembly builder, defaults); older ones get a sensible guess from their
// measure type or tag. Typing a new category name anywhere creates it.

export const CATEGORIES = [
  "Walls", "Shaft walls", "Furring", "Ceilings", "Bulkheads & soffits",
  "Trims & accessories", "Backing & blocking", "Fire stopping", "Doors & panels",
];
export const OTHER = "Other";

const BY_MEASURE = { wall: "Walls", area: "Ceilings", line: "Trims & accessories", count: "Doors & panels" };

export function categoryOf(c) {
  const explicit = typeof c?.category === "string" ? c.category.trim() : "";
  if (explicit) return explicit;
  const tag = String(c?.finish_tag || "").toUpperCase();
  if (/^(BH|SOF)/.test(tag)) return "Bulkheads & soffits";
  if (/^SW/.test(tag)) return "Shaft walls";
  if (/^F\d/.test(tag)) return "Furring";
  if (c?.measure && BY_MEASURE[c.measure]) return BY_MEASURE[c.measure];
  if (/^(W|P)\d/.test(tag)) return "Walls";
  if (/^(C|ACT|GWB)\d/.test(tag)) return "Ceilings";
  return OTHER;
}

// Category display order: the standard list first, custom names after
// (alphabetical), "Other" last.
export function categoryRank(name) {
  const i = CATEGORIES.indexOf(name);
  if (i >= 0) return i;
  return name === OTHER ? 1000 : 500;
}
export const compareCategories = (a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b);

/** Group items into [{ name, items }] by category, in display order. */
export function groupByCategory(items, getCond = (x) => x) {
  const by = new Map();
  for (const it of items) {
    const k = categoryOf(getCond(it));
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(it);
  }
  return [...by.entries()].sort((a, b) => compareCategories(a[0], b[0])).map(([name, list]) => ({ name, items: list }));
}
