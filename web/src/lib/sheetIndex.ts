// The AI sheet index — what to send the AI about each sheet so it can name and
// classify it, and how a classified sheet is shown. Pure module.
import type { Tok } from "./scheduleFinder.ts";

/** Title-block and headline text of a page: the right and bottom strips (where
 *  title blocks live) plus the largest lettering anywhere (drawing titles). */
export function titleBlockText(tokens: Tok[], width: number, height: number, budget = 900): string {
  const flat = tokens.filter((t) => t.str && t.str.trim());
  const inBlock = flat.filter((t) => t.x > width * 0.72 || t.y > height * 0.86);
  const big = [...flat].sort((a, b) => b.h - a.h).slice(0, 12);
  const seen = new Set<string>();
  const out: string[] = [];
  let n = 0;
  // biggest first (titles), then the title block, top to bottom
  for (const t of [...big, ...inBlock.sort((a, b) => a.y - b.y || a.x - b.x)]) {
    const s = t.str.trim().replace(/\s+/g, " ");
    if (s.length < 2 || seen.has(s)) continue;
    seen.add(s);
    if (n + s.length + 1 > budget) break;
    out.push(s); n += s.length + 1;
  }
  return out.join(" | ");
}

export interface SheetInfo { number?: string; title?: string; kind?: string; interior_partitions?: boolean; exterior?: boolean; ceilings?: boolean; why?: string; renamed?: boolean }

/** "A2.0 Proposed Floor Plan" — the sheet's display name from the index, or null. */
export function sheetDisplayName(info: SheetInfo | undefined | null): string | null {
  if (!info) return null;
  const num = (info.number || "").trim(), title = (info.title || "").trim();
  if (!num && !title) return null;
  return num && title ? `${num} ${title}` : num || title;
}

/** Does this sheet matter to an interior/exterior partitions contractor? */
export function isOurSheet(info: SheetInfo | undefined | null): boolean {
  return !!info && !!(info.interior_partitions || info.exterior || info.kind === "wall_types");
}

export const KIND_LABELS: Record<string, string> = {
  floor_plan: "Floor plan", reflected_ceiling_plan: "Ceiling plan", wall_types: "Wall types", demolition_plan: "Demolition",
  details: "Details", sections: "Sections", elevations: "Elevations", door_schedule: "Door schedule", finish_plan: "Finishes",
  roof_plan: "Roof", cover: "Cover", site: "Site", structural: "Structural", mechanical: "Mechanical", electrical: "Electrical",
  plumbing: "Plumbing", fire_protection: "Fire protection", specifications: "Specs", other: "Other",
};
