// Typical walls by geometry. Simple drawing sets often tag only the exceptions:
// the schedule says WP-1 is "TYPICAL PARTITION, UNLESS OTHERWISE NOTED" and WP-2
// is the partition "AT POCKET DOOR LOCATIONS" (6" studs). The AI reads each
// type's build-up; this module turns it into a finished thickness and gives
// every untagged run the type whose thickness it measures — falling back to the
// typical type for ordinary partitions. A real plan tag is never overridden.
//
// Pure module.
import type { FoundWall } from "./findWalls.ts";

export interface WallTypeRule {
  tag: string; typical: boolean; condition?: string; condition_text?: string;
  stud_in?: number | null; board_in?: number | null; layers_per_side?: number | null; sides?: number | null; overall_in?: number | null;
}
export type TypeVia = "schedule_thickness" | "typical";

/** Finished thickness of a type, in inches (stated, or studs + every layer of board). */
export function typeThickness(t: WallTypeRule): number | null {
  if (t.overall_in && t.overall_in > 0) return t.overall_in;
  if (t.stud_in && t.stud_in > 0) return t.stud_in + (t.board_in || 0.625) * (t.layers_per_side || 1) * (t.sides || 2);
  return null;
}

/** Which untagged runs take which type. Returns id → { tag, via }. */
export function typeUntaggedWalls(walls: (FoundWall & { inScope?: boolean; noteKey?: string; groupOverride?: string })[], types: WallTypeRule[]): Map<number, { tag: string; via: TypeVia }> {
  const out = new Map<number, { tag: string; via: TypeVia }>();
  const sized = types.map((t) => ({ t, th: typeThickness(t) })).filter((x) => x.th != null) as { t: WallTypeRule; th: number }[];
  const typical = types.find((t) => t.typical) || null;
  const typicalTh = typical ? typeThickness(typical) : null;
  const maxTh = sized.length ? Math.max(...sized.map((x) => x.th)) : null;
  for (const w of walls) {
    if (w.groupOverride || w.noteKey) continue;                       // the estimator or a note already decided
    if (w.existing && !w.inScope) continue;                           // existing walls stay out of scope
    if (w.tag && w.tagSource && w.tagSource !== "thickness") continue; // a real plan tag (leader / near / run) stands
    // 1. a type whose finished thickness this run measures (drafting is ±½")
    let best: { t: WallTypeRule; th: number } | null = null, bd = Infinity;
    for (const x of sized) {
      const d = Math.abs(w.thickIn - x.th);
      const tol = Math.max(0.45, 0.08 * x.th);
      if (d > tol) continue;
      // same thickness, several types: the typical one, then the unconditional one
      const rank = d - (x.t.typical ? 0.2 : 0) - ((x.t.condition || "none") === "none" ? 0.1 : 0);
      if (rank < bd) { bd = rank; best = x; }
    }
    if (best) { out.set(w.id, { tag: best.t.tag, via: "schedule_thickness" }); continue; }
    // 2. an ordinary partition no type matches exactly: the typical type — but not
    //    masonry, exterior assemblies or anything far off the stud walls listed
    if (typical && typicalTh != null && maxTh != null && w.thickIn <= maxTh + 1 && Math.abs(w.thickIn - typicalTh) <= 2.5) {
      out.set(w.id, { tag: typical.tag, via: "typical" });
    }
  }
  return out;
}
