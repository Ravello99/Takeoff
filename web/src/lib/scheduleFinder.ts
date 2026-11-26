// Find the partition / wall-type schedule in a project's drawings — so the
// estimator never has to screenshot it.
//
// Every page's text layer is assembled into lines, lines into blocks (a block
// is a paragraph or a table column: lines stacked close together that overlap
// horizontally), and each block is scored for "this is a wall-type schedule":
// a heading such as PARTITION TYPES / WALL TYPES, many wall-type marks (P1,
// 2A, W-3…) and drywall vocabulary (gypsum, studs, o.c., batt, F.R.R.…). The
// best page wins; its schedule blocks become the text the AI reads, so even a
// text-only model can read the schedule, and the reading costs a fraction of
// an image.
//
// Pure module — no pdf.js, no DOM. Tokens come from sheets.ts extractRegionText
// (pageRuns) in viewport px, y down.

export interface Tok { str: string; x: number; y: number; h: number; w?: number; ang?: number }

export interface ScheduleBlock { x0: number; y0: number; x1: number; y1: number; lines: string[]; score: number; tags: number; words: number }

export interface ScheduleFind {
  score: number;              // 0 = no schedule here
  text: string;               // what the AI reads
  blocks: ScheduleBlock[];    // chosen blocks, reading order
  rect: { x0: number; y0: number; x1: number; y1: number } | null;
  heading: string | null;
}

export const HEADING_RE = /\b(PARTITION|WALL)\s*(TYPES?|SCHEDULES?|LEGEND|ASSEMBL(Y|IES)|KEY)\b|\bINTERIOR\s+(MASONRY\s+)?PARTITIONS?\b|\bPARTITIONS\b/i;
const WORD_RE = /\b(GYP|GYPSUM|GWB|G\.W\.B|DRYWALL|WALLBOARD|BOARD|STUDS?|FURRING|TRACK|BATTS?|INSULATION|MINERAL|MASONRY|CMU|SHAFT|STC|F\.?R\.?R|RATED|RATING|O\.?\s?C|MTL|METAL|DEFLECTION|SOUND|ACOUSTIC|PARTITION|TYPE\s?X|ULC|UL|DECK|LAYERS?|GAUGE|GA)\b/gi;
const TAG_RE = /^[A-Z]{1,3}-?\d{1,2}[A-Z]?$|^\d{1,2}[A-Z]{1,2}$/;
const MAX_CHARS = 14000;
const NOT_WALL_RE = /\b(ROOF|FLOOR|CEILING|SOFFIT|SLAB|FOUNDATION|PAVERS?)\b/i;

const width = (t: Tok) => (t.w && t.w > 0 ? t.w : t.str.length * 0.55 * t.h);
const flat = (t: Tok) => { const a = ((t.ang ?? 0) % 360 + 360) % 360; return a < 3 || a > 357; };

interface Seg { x0: number; x1: number; y0: number; y1: number; h: number; toks: Tok[] }

/** Tokens → line segments (one baseline, no wide gaps) → blocks. */
export function buildBlocks(tokens: Tok[]): ScheduleBlock[] {
  const toks = tokens.filter((t) => t.str && t.str.trim() && t.h > 0 && flat(t)).sort((a, b) => a.y - b.y || a.x - b.x);
  // lines: same baseline within half a text height
  const lines: Tok[][] = [];
  for (const t of toks) {
    const L = lines.length ? lines[lines.length - 1] : null;
    if (L && Math.abs(L[0].y - t.y) < Math.min(L[0].h, t.h) * 0.5) L.push(t);
    else lines.push([t]);
  }
  const segs: Seg[] = [];
  for (const L of lines) {
    L.sort((a, b) => a.x - b.x);
    let cur: Seg | null = null;
    for (const t of L) {
      const x1 = t.x + width(t);
      if (cur && t.x - cur.x1 <= 2.5 * Math.max(cur.h, t.h)) { cur.toks.push(t); cur.x1 = Math.max(cur.x1, x1); cur.y0 = Math.min(cur.y0, t.y - t.h); cur.y1 = Math.max(cur.y1, t.y); cur.h = Math.max(cur.h, t.h); }
      else { cur = { x0: t.x, x1, y0: t.y - t.h, y1: t.y, h: t.h, toks: [t] }; segs.push(cur); }
    }
  }
  // blocks: a segment joins the nearest block above it that it overlaps and nearly touches
  const blocks: (ScheduleBlock & { h: number; segs: Seg[] })[] = [];
  segs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  for (const s of segs) {
    let best: (typeof blocks)[number] | null = null, bestGap = Infinity;
    for (let k = blocks.length - 1; k >= 0; k--) {
      const B = blocks[k];
      const gap = s.y0 - B.y1;
      if (gap > 2.4 * Math.max(B.h, s.h)) continue;
      if (gap < -0.5 * s.h) continue;
      const overlap = Math.min(B.x1, s.x1) - Math.max(B.x0, s.x0);
      if (overlap < -2 * s.h) continue;
      if (gap < bestGap) { bestGap = gap; best = B; }
    }
    if (best) { best.segs.push(s); best.x0 = Math.min(best.x0, s.x0); best.x1 = Math.max(best.x1, s.x1); best.y1 = Math.max(best.y1, s.y1); best.h = Math.max(best.h, s.h); }
    else blocks.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, h: s.h, lines: [], score: 0, tags: 0, words: 0, segs: [s] });
  }
  return blocks.map((B) => {
    const ordered = B.segs.sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0);
    const lines = ordered.map((s) => s.toks.map((t) => t.str.trim()).join(" ").replace(/\s+/g, " "));
    const text = lines.join("\n");
    const words = (text.match(WORD_RE) || []).length;
    // a wall-type mark: a short token that leads its line, or stands alone
    const tagSet = new Set<string>();
    for (const s of ordered) { const first = s.toks[0].str.trim(); if (TAG_RE.test(first) && (s.toks.length === 1 || s.toks.length > 2)) tagSet.add(first); }
    const heading = HEADING_RE.test(text) ? 1 : 0;
    let score = words + 3 * Math.min(tagSet.size, 20) + 12 * heading;
    if (!tagSet.size && !heading) score = words * 0.25;
    // roof, floor and ceiling assemblies share the vocabulary but aren't walls
    if (NOT_WALL_RE.test(lines.slice(0, 2).join(" ")) && !/WALL|PARTITION/i.test(lines[0] || "")) score *= 0.15;
    return { x0: B.x0, y0: B.y0, x1: B.x1, y1: B.y1, lines, score, tags: tagSet.size, words };
  });
}

/** Schedules that put the mark BESIDE its description (a WP-1 hexagon on the
 *  left, the layers to its right) come out as a bare-mark block and a
 *  description block. Join each bare mark to the description it sits beside. */
export function pairSideTags(blocks: ScheduleBlock[]): ScheduleBlock[] {
  const bare = blocks.filter((b) => b.tags > 0 && b.words < 2 && b.lines.length <= 2);
  const used = new Set<ScheduleBlock>();
  const out: ScheduleBlock[] = [];
  for (const t of bare) {
    const h = Math.max(1, (t.y1 - t.y0) / Math.max(1, t.lines.length));
    let best: ScheduleBlock | null = null, gap = 25 * h;
    for (const d of blocks) {
      if (d === t || used.has(d) || d.words < 2) continue;
      const dx = d.x0 - t.x1;
      if (dx < -h || dx > gap) continue;
      // beside it: the description's top is near the mark (it may run down below it)
      const overlap = Math.min(t.y1, d.y1) - Math.max(t.y0, d.y0);
      if (overlap < -2 * h || d.y0 > t.y1 + 2 * h || d.y1 < t.y0 - 2 * h) continue;
      gap = dx; best = d;
    }
    if (!best) continue;
    used.add(best); used.add(t);
    out.push({ x0: Math.min(t.x0, best.x0), y0: Math.min(t.y0, best.y0), x1: Math.max(t.x1, best.x1), y1: Math.max(t.y1, best.y1),
      // scored as a type block (a description alone was scored down as stray notes)
      lines: [...t.lines, ...best.lines], score: best.words + 3 * (t.tags + best.tags), tags: t.tags + best.tags, words: best.words });
  }
  return [...blocks.filter((b) => !used.has(b)), ...out];
}

/** Best schedule on one page (score 0 when nothing schedule-like is there).
 *  A schedule is laid out in columns of type blocks (mark + description), so
 *  blocks are grouped into columns and whole columns are kept: the strongest
 *  one, plus any other column at least a third as strong (exterior wall types
 *  usually sit in their own column and carry interior board too). */
export function findScheduleOnPage(tokens: Tok[]): ScheduleFind {
  const none: ScheduleFind = { score: 0, text: "", blocks: [], rect: null, heading: null };
  // a type block is a mark WITH a description in wall vocabulary — a bare mark in
  // a door or finish schedule's table column is not
  const blocks = pairSideTags(buildBlocks(tokens)).filter((b) => (b.tags > 0 && b.words >= 2) || HEADING_RE.test(b.lines[0] || ""));
  if (!blocks.length) return none;
  const xs = blocks.flatMap((b) => [b.x0, b.x1]);
  const W = Math.max(...xs) - Math.min(...xs) || 1;
  const colTol = Math.max(W * 0.02, 10);
  const cols: { x: number; bs: ScheduleBlock[]; score: number }[] = [];
  for (const b of [...blocks].sort((p, q) => p.x0 - q.x0)) {
    const c = cols.find((c) => Math.abs(c.x - b.x0) <= colTol);
    if (c) { c.bs.push(b); c.score += b.score; } else cols.push({ x: b.x0, bs: [b], score: b.score });
  }
  // a column needs more than a lone stray mark to be a schedule
  for (const c of cols) if (c.bs.filter((b) => b.tags > 0).length < 2) c.score *= 0.3;
  cols.sort((p, q) => q.score - p.score);
  const top = cols[0];
  if (!top || top.score < 30) return none;
  const keep = cols.filter((c) => c === top || c.score >= top.score * 0.33);
  const chosen: ScheduleBlock[] = [];
  let chars = 0;
  for (const c of keep.sort((p, q) => p.x - q.x)) {
    for (const b of c.bs.sort((p, q) => p.y0 - q.y0)) {
      const n = b.lines.join("\n").length;
      if (chars + n > MAX_CHARS) break;
      chosen.push(b); chars += n;
    }
  }
  const headLine = chosen.flatMap((b) => b.lines).find((l) => HEADING_RE.test(l)) || null;
  return {
    score: Math.round(keep.reduce((n, c) => n + c.score, 0)),
    text: chosen.map((b) => b.lines.join("\n")).join("\n\n"),
    blocks: chosen,
    rect: { x0: Math.min(...chosen.map((b) => b.x0)), y0: Math.min(...chosen.map((b) => b.y0)), x1: Math.max(...chosen.map((b) => b.x1)), y1: Math.max(...chosen.map((b) => b.y1)) },
    heading: headLine,
  };
}
