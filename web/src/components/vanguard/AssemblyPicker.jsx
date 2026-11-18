// Vanguard — pick the assembly right after choosing a measuring tool.
// Clicking Wall (or Area, Line, Count…) in the tool rail opens this beside
// the button: the matching assemblies first, the rest underneath, and a
// "New assembly" button. Esc, a click outside, or picking one closes it.
import { useEffect, useMemo, useRef, useState } from "react";
import { ColorSwatch } from "../hatches.jsx";

export const TOOL_MEASURE = { surface: "wall", area: "area", rect: "area", linear: "line", count: "count", symbol: "count" };
const MEASURE_LABEL = { wall: "Wall", area: "Area / ceiling", line: "Line", count: "Count" };

// An assembly's measure type: set explicitly, else read from its notes,
// else from the shapes already drawn with it.
export function measureOf(c, roleCounts) {
  if (c?.measure) return c.measure;
  const r = String(c?.spec?.remarks || "").toLowerCase();
  if (r.includes("wall tool")) return "wall";
  if (r.includes("area tool")) return "area";
  if (r.includes("linear tool")) return "line";
  if (r.includes("count tool")) return "count";
  const rc = roleCounts?.get(c?.id);
  if (rc) {
    const top = Object.entries(rc).sort((a, b) => b[1] - a[1])[0]?.[0];
    return { surface_area: "wall", floor_area: "area", linear: "line", count: "count" }[top] || null;
  }
  return null;
}

export default function AssemblyPicker({ tool, top, conditions, shapes, activeId, onPick, onNew, onClose }) {
  const ref = useRef(null);
  const [query, setQuery] = useState("");
  const measure = TOOL_MEASURE[tool];
  const roleCounts = useMemo(() => {
    const m = new Map();
    for (const s of shapes || []) {
      const e = m.get(s.condition_id) || {};
      e[s.measure_role] = (e[s.measure_role] || 0) + 1;
      m.set(s.condition_id, e);
    }
    return m;
  }, [shapes]);
  const q = query.trim().toLowerCase();
  const match = (c) => !q || `${c.finish_tag} ${c.spec?.description || ""}`.toLowerCase().includes(q);
  const primary = conditions.filter((c) => measureOf(c, roleCounts) === measure && match(c));
  const others = conditions.filter((c) => measureOf(c, roleCounts) !== measure && match(c));
  const [showOthers, setShowOthers] = useState(primary.length === 0);

  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    // next tick, so the click that opened the picker doesn't close it
    const t = setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key, true);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [onClose]);

  const row = (c) => (
    <button key={c.id} type="button" className={`vg-pick-row${c.id === activeId ? " is-active" : ""}`}
      onClick={() => onPick(c.id)} title={c.spec?.description || c.finish_tag}>
      <ColorSwatch color={c.color} />
      <span className="vg-pick-text"><strong>{c.finish_tag}</strong>{c.spec?.description && <small>{c.spec.description}</small>}</span>
      {c.id === activeId && <span className="vg-pick-check" aria-label="current">✓</span>}
    </button>
  );

  const maxTop = typeof window !== "undefined" ? Math.max(60, window.innerHeight - 440) : top;
  return (
    <div ref={ref} className="vg-picker" role="dialog" aria-label={`Choose a ${MEASURE_LABEL[measure] || ""} assembly`}
      style={{ top: Math.min(top, maxTop) }}>
      <header>
        <strong>{MEASURE_LABEL[measure]} assembly</strong>
        <button type="button" className="vg-pick-x" onClick={onClose} aria-label="Close">×</button>
      </header>
      {conditions.length > 6 && (
        <input className="vg-pick-search" autoFocus placeholder="Search assemblies…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search assemblies" />
      )}
      <div className="vg-pick-list">
        {primary.map(row)}
        {primary.length === 0 && !showOthers && <p className="vg-pick-empty">No {MEASURE_LABEL[measure]?.toLowerCase()} assemblies yet.</p>}
        {others.length > 0 && (
          <>
            <button type="button" className="vg-pick-more" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers}>
              {showOthers ? "▾" : "▸"} Other assemblies ({others.length})
            </button>
            {showOthers && others.map(row)}
          </>
        )}
      </div>
      <footer>
        <button type="button" className="vg-pick-new" onClick={() => onNew(measure)}>+ New {MEASURE_LABEL[measure]?.toLowerCase()} assembly</button>
      </footer>
    </div>
  );
}
