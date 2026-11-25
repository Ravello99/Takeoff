// Vanguard — full-page Assembly builder (server mode, /assemblies).
//
// The company's assemblies (the template library every new project starts
// with) on the left, the selected assembly in the middle, and the material
// library on the right. Drag a material onto the assembly to add it, drag
// rows to reorder, edit rates inline. A live preview shows what the assembly
// orders for a sample quantity. Changes save automatically.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/vanguardApi.js";
import { sanitizeTemplates } from "../../lib/templates.js";
import { sanitizeMaterialLibrary, libFields } from "../../lib/materials.js";
import { conditionTotals } from "../../lib/totals.js";
import { DRYWALL_DEFAULTS } from "../../lib/drywallDefaults.js";
import { LAYER_OPTIONS, STUD_OC_OPTIONS } from "../../lib/assembly.js";
import { ColorSwatch, PALETTE } from "../hatches.jsx";
import { LABOR_UNITS, guessLaborUnit, laborSummary } from "../../lib/labor.js";
import { money } from "../../lib/materialCatalog.js";
import { uniqueTags } from "../../lib/aiSchedule.js";
import ScheduleReader from "./ScheduleReader.jsx";
import { CATEGORIES, categoryOf, groupByCategory } from "../../lib/categories.js";
import "../../styles/vanguardAssemblies.css";

const TYPES = [
  { id: "wall", label: "Walls", one: "Wall", tool: "Wall tool: trace the wall line" },
  { id: "area", label: "Ceilings & areas", one: "Ceiling / area", tool: "Area tool: trace the area" },
  { id: "line", label: "Lines", one: "Line", tool: "Line tool: trims, bead, backing" },
  { id: "count", label: "Counts", one: "Count", tool: "Count tool: frames, panels" },
];
const BASES = [
  { id: "area", label: "SF" }, { id: "linear", label: "LF" },
  { id: "perimeter", label: "perimeter LF" }, { id: "count", label: "EA" },
];
const SCALES = [
  { id: "", label: "Fixed rate" }, { id: "layers", label: "Board layers" },
  { id: "oc_stud", label: "Stud O.C. (studs per LF)" }, { id: "oc_chan", label: "O.C. (12' channel per SF)" },
  { id: "oc_cross", label: "O.C. (4' cross tee per SF)" },
];
const newId = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

// starter material library: every distinct material in the Vanguard defaults
function starterMaterials() {
  const seen = new Map();
  for (const t of DRYWALL_DEFAULTS) for (const m of t.materials || []) {
    if (!seen.has(m.name)) seen.set(m.name, { id: newId("lib"), ...libFields(m) });
  }
  return [...seen.values()];
}

// What the assembly orders for a sample takeoff — the Report's own math.
function preview(t) {
  const sample = {
    wall: { measure_role: "surface_area", computed: { area_sf: 100 * (Number(t.height_ft) || 10), perimeter_lf: 100 } },
    area: { measure_role: "floor_area", computed: { area_sf: 1000, perimeter_lf: 130 } },
    line: { measure_role: "linear", computed: { perimeter_lf: 100 } },
    count: { measure_role: "count", computed: { count: 10 } },
  }[t.measure] || { measure_role: "floor_area", computed: { area_sf: 1000, perimeter_lf: 130 } };
  const label = {
    wall: `100 LF of wall at ${Number(t.height_ft) || 10} ft`, area: "1,000 SF (130 LF perimeter)",
    line: "100 LF", count: "10 EA",
  }[t.measure] || "1,000 SF";
  const cond = { ...t, id: "p", multiplier: 1 };
  const [row] = conditionTotals([cond], [{ id: "s", condition_id: "p", ...sample }]);
  const labor = laborSummary(row ? [row] : []);
  const unitDiv = { wall: [100, "LF of wall"], area: [1000, "SF"], line: [100, "LF"], count: [10, "EA"] }[t.measure];
  const per = unitDiv && labor.total ? `$${(labor.total / unitDiv[0]).toFixed(2)} per ${unitDiv[1]}` : "";
  const matCost = Math.round((row?.materials || []).reduce((n, m) => n + (m.cost || 0), 0) * 100) / 100;
  const totalPer = unitDiv && (matCost + labor.total) ? `$${((matCost + labor.total) / unitDiv[0]).toFixed(2)} per ${unitDiv[1]}` : "";
  return { label, materials: row?.materials || [], labor, per, matCost, totalPer };
}

export default function AssembliesPage() {
  const [templates, setTemplates] = useState(null);
  const [library, setLibrary] = useState(null);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [libQuery, setLibQuery] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [rowDrag, setRowDrag] = useState(null);
  const [newMat, setNewMat] = useState(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [reading, setReading] = useState(false);
  useEffect(() => { api("GET", "/api/status").then((st) => setAiEnabled(!!st.ai_enabled), () => {}); }, []);
  const saveTimer = useRef({});

  useEffect(() => {
    Promise.all([api("GET", "/api/library/templates"), api("GET", "/api/library/materials")]).then(([t, m]) => {
      setTemplates(sanitizeTemplates(t.value || []));
      setLibrary(sanitizeMaterialLibrary(m.value || []));
    }, (e) => setError(e.message));
  }, []);

  // autosave (debounced per library)
  const persist = useCallback((kind, value) => {
    clearTimeout(saveTimer.current[kind]);
    setStatus("Saving…");
    saveTimer.current[kind] = setTimeout(() => {
      api("PUT", `/api/library/${kind}`, { json: { value } })
        .then(() => setStatus("All changes saved"), (e) => { setStatus(""); setError(e.message); });
    }, 600);
  }, []);
  const updateTemplates = (next) => { setTemplates(next); persist("templates", next); };
  const updateLibrary = (next) => { setLibrary(next); persist("materials", next); };

  const t = templates?.[selected];
  const patch = (p) => updateTemplates(templates.map((x, i) => (i === selected ? { ...x, ...p } : x)));
  const patchMat = (mi, p) => patch({ materials: t.materials.map((m, i) => (i === mi ? { ...m, ...p } : m)) });
  const wallSides = () => (t.materials.some((m) => Number(m.labor_sides) === 2 || /each side/i.test(m.note || "")) ? 2 : 1);
  const withLabor = (line) => {
    const unit = line.labor_unit ?? guessLaborUnit(line);
    return { ...line, labor_unit: unit, ...(unit === "SF" && t.measure === "wall" && !line.labor_sides ? { labor_sides: wallSides() } : {}) };
  };
  const addLaborItem = () => {
    const basis = t.measure === "count" ? "count" : t.measure === "line" ? "linear" : "area";
    const unit = basis === "count" ? "EA" : basis === "linear" ? "LF" : "SF";
    patch({ materials: [...t.materials, { name: t.measure === "count" ? "Install" : "Labor", kind: "labor", per: 1, basis, unit: "", round: false, note: "",
      labor_unit: unit, labor_rate: 0, ...(unit === "SF" && t.measure === "wall" ? { labor_sides: wallSides() } : {}) }] });
  };
  const addMat = (lm, at = t.materials.length) => {
    const line = withLabor({ ...libFields(lm), round: true, lib_id: lm.id });
    const mats = [...t.materials]; mats.splice(at, 0, line);
    patch({ materials: mats });
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (templates || []).map((x, i) => ({ x, i })).filter(({ x }) => !q || `${x.finish_tag} ${x.spec?.description || ""}`.toLowerCase().includes(q));
    return groupByCategory(list, ({ x }) => x).map((g) => ({ id: g.name, label: g.name, items: g.items }));
  }, [templates, query]);

  const libShown = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    return (library || []).filter((m) => !q || `${m.name} ${m.note || ""}`.toLowerCase().includes(q));
  }, [library, libQuery]);

  if (error && !templates) return <main className="va-page"><p className="vp-error">{error}</p></main>;
  if (!templates || !library) return <main className="va-page"><p className="vp-muted">Loading assemblies…</p></main>;

  const createAssembly = (measure) => {
    const n = templates.length;
    const base = { finish_tag: `NEW-${n + 1}`, measure, category: categoryOf({ measure }), color: PALETTE[n % PALETTE.length], fill: PALETTE[n % PALETTE.length], hatch: "solid", waste_pct: measure === "area" ? 5 : 10, materials: [],
      spec: { description: "", remarks: TYPES.find((x) => x.id === measure)?.tool || "" },
      ...(measure === "wall" ? { height_ft: 10, board_layers: 1, stud_oc_in: 16 } : {}) };
    updateTemplates([...templates, base]);
    setSelected(n);
  };

  return (
    <main className="va-page">
      <div className="va-head">
        <div>
          <h1>Assemblies</h1>
          <p className="vp-muted">Build your wall, ceiling and trim assemblies once. Every new project starts with these. <span className="va-status">{status}</span></p>
        </div>
        <div className="vp-row">
          {aiEnabled
            ? <button className="vp-btn vp-primary" onClick={() => setReading(true)}>✨ Read schedule with AI</button>
            : <span className="vp-muted vp-small">Connect AI on the Team page to read wall schedules automatically.</span>}
        </div>
        {error && <p className="vp-error">{error}</p>}
      </div>
      {reading && <ScheduleReader onClose={() => setReading(false)}
        onAdd={(list) => { const added = uniqueTags(list, templates); updateTemplates([...templates, ...added]); setSelected(templates.length); setReading(false); setStatus(`Added ${added.length} assemblies from the schedule`); }} />}

      {templates.length === 0 && (
        <div className="va-banner">
          <div><strong>Start from Vanguard's commercial drywall set?</strong><p className="vp-muted">20 assemblies (partitions, shaft wall, ceilings, bulkheads, trims) with their materials. You can change everything afterwards.</p></div>
          <button className="vp-btn vp-primary" onClick={() => { updateTemplates(DRYWALL_DEFAULTS.map((x) => JSON.parse(JSON.stringify(x)))); setSelected(0); if (!library.length) updateLibrary(starterMaterials()); }}>Load the Vanguard set</button>
        </div>
      )}

      <div className="va-grid">
        {/* ── assembly list ─────────────────────────────────────────────── */}
        <aside className="va-col va-list">
          <input className="va-search" placeholder="Search assemblies…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search assemblies" />
          <div className="va-scroll">
            {groups.map((g) => (
              <section key={g.id}>
                <h3>{g.label}</h3>
                {g.items.map(({ x, i }) => (
                  <button key={i} className={`va-item${i === selected ? " is-on" : ""}`} onClick={() => setSelected(i)}>
                    <ColorSwatch color={x.color} />
                    <span><strong>{x.finish_tag}</strong><small>{x.spec?.description || `${x.materials.length} material${x.materials.length === 1 ? "" : "s"}`}</small></span>
                  </button>
                ))}
              </section>
            ))}
          </div>
          <div className="va-new">
            <span className="vp-muted vp-small">New assembly</span>
            <div className="va-new-row">{TYPES.map((ty) => <button key={ty.id} className="vp-btn" onClick={() => createAssembly(ty.id)}>+ {ty.one}</button>)}</div>
          </div>
        </aside>

        {/* ── selected assembly ─────────────────────────────────────────── */}
        <section className="va-col va-editor">
          {!t ? <p className="vp-muted">Choose an assembly on the left, or create one.</p> : (<>
            <div className="va-editor-head">
              <div className="va-colors" role="group" aria-label="Colour on the plan">
                {PALETTE.map((p) => <button key={p} className={`va-color${t.color === p ? " is-on" : ""}`} style={{ background: p }} title={p} onClick={() => patch({ color: p, fill: p })} aria-label={`Colour ${p}`} />)}
              </div>
              <div className="va-editor-actions">
                <button className="vp-btn vp-ghost" onClick={() => { const copy = JSON.parse(JSON.stringify(t)); copy.finish_tag = `${t.finish_tag} copy`; updateTemplates([...templates, copy]); setSelected(templates.length); }}>Duplicate</button>
                <button className="vp-btn vp-ghost vp-danger" onClick={() => { if (window.confirm(`Delete assembly “${t.finish_tag}”? Projects already using it keep their copy.`)) { updateTemplates(templates.filter((_, i) => i !== selected)); setSelected(Math.max(0, selected - 1)); } }}>Delete</button>
              </div>
            </div>
            <div className="va-fields">
              <label className="va-f va-tag"><span>Tag / name</span><input value={t.finish_tag} onChange={(e) => patch({ finish_tag: e.target.value })} /></label>
              <label className="va-f"><span>Type</span>
                <select value={t.measure || ""} onChange={(e) => patch({ measure: e.target.value || undefined })}>
                  <option value="">—</option>{TYPES.map((ty) => <option key={ty.id} value={ty.id}>{ty.one}</option>)}
                </select></label>
              <label className="va-f"><span>Category</span>
                <input list="va-categories" value={t.category ?? ""} placeholder={categoryOf(t)} onChange={(e) => patch({ category: e.target.value || undefined })} />
                <datalist id="va-categories">{CATEGORIES.map((n) => <option key={n} value={n} />)}</datalist></label>
              <label className="va-f"><span>Waste %</span><input type="number" min="0" value={t.waste_pct ?? 0} onChange={(e) => patch({ waste_pct: Math.max(0, Number(e.target.value) || 0) })} /></label>
              {t.measure === "wall" && <>
                <label className="va-f"><span>Height (ft)</span><input type="number" min="0" step="0.5" value={t.height_ft ?? ""} onChange={(e) => patch({ height_ft: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
                <label className="va-f"><span>Layers / side</span><select value={t.board_layers ?? ""} onChange={(e) => patch({ board_layers: e.target.value === "" ? undefined : Number(e.target.value) })}><option value="">—</option>{LAYER_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
                <label className="va-f"><span>Stud O.C.</span><select value={t.stud_oc_in ?? ""} onChange={(e) => patch({ stud_oc_in: e.target.value === "" ? undefined : Number(e.target.value) })}><option value="">—</option>{STUD_OC_OPTIONS.map((n) => <option key={n} value={n}>{n}"</option>)}</select></label>
              </>}
              {t.measure === "area" && (
                <label className="va-f"><span>Grid / channel O.C.</span><select value={t.stud_oc_in ?? ""} onChange={(e) => patch({ stud_oc_in: e.target.value === "" ? undefined : Number(e.target.value) })}><option value="">—</option>{STUD_OC_OPTIONS.map((n) => <option key={n} value={n}>{n}"</option>)}</select></label>
              )}
              <label className="va-f va-desc"><span>Description</span><textarea rows={2} value={t.spec?.description || ""} placeholder='e.g. 3-5/8" 20ga studs @ 16" o.c., 1 layer 5/8" Type X each side, to deck' onChange={(e) => patch({ spec: { ...(t.spec || {}), description: e.target.value } })} /></label>
            </div>

            <h2 className="va-h2">Materials <span className="vp-muted vp-small">— drag from the library on the right, or drag rows to reorder</span></h2>
            <div className={`va-drop${dragOver ? " is-over" : ""}`}
              onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-vg-mat") || rowDrag != null) { e.preventDefault(); setDragOver(true); } }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault(); setDragOver(false);
                const id = e.dataTransfer.getData("application/x-vg-mat");
                const lm = id && library.find((m) => m.id === id);
                if (lm) addMat(lm);
              }}>
              {t.materials.length === 0 && <p className="va-drop-hint">Drag materials here</p>}
              {t.materials.map((m, mi) => (
                <div key={mi} className={`va-mat${rowDrag === mi ? " is-dragging" : ""}`} draggable
                  onDragStart={(e) => { setRowDrag(mi); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", m.name); }}
                  onDragEnd={() => setRowDrag(null)}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={(e) => {
                    e.preventDefault(); e.stopPropagation(); setDragOver(false);
                    const id = e.dataTransfer.getData("application/x-vg-mat");
                    const lm = id && library.find((x) => x.id === id);
                    if (lm) { addMat(lm, mi); return; }
                    if (rowDrag == null || rowDrag === mi) return;
                    const mats = [...t.materials]; const [moved] = mats.splice(rowDrag, 1); mats.splice(mi, 0, moved);
                    patch({ materials: mats }); setRowDrag(null);
                  }}>
                  <span className="va-grip" aria-hidden>⠿</span>
                  <input className="va-mat-name" value={m.name} onChange={(e) => patchMat(mi, { name: e.target.value })} aria-label="Material name" />
                  {m.kind === "labor" ? <span className="va-laboronly">Labor only, nothing to buy</span> : <span className="va-rate">1
                    <input className="va-unit" value={m.unit || ""} onChange={(e) => patchMat(mi, { unit: e.target.value })} aria-label="Unit" placeholder="unit" />
                    per<input className="va-per" type="number" min="0" step="0.01" value={m.per ?? 0} onChange={(e) => patchMat(mi, { per: Number(e.target.value) || 0 })} aria-label="Coverage" />
                    <select value={m.basis || "area"} onChange={(e) => patchMat(mi, { basis: e.target.value })} aria-label="Measured in">{BASES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
                  </span>}
                  {m.kind === "labor" ? <span /> : <select className="va-scale" value={m.scale || ""} onChange={(e) => patchMat(mi, { scale: e.target.value || undefined, ...(e.target.value === "layers" && !m.layers_base ? { layers_base: 1 } : {}) })} aria-label="Adjusts with">
                    {SCALES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>}
                  <button className="va-remove" onClick={() => patch({ materials: t.materials.filter((_, i) => i !== mi) })} title="Remove from this assembly" aria-label="Remove">×</button>
                  <div className="va-subrow">
                    <span className={`va-labor${m.labor_unit && m.labor_rate > 0 ? " is-priced" : ""}`}>
                      Labor $<input className="va-lrate" type="number" min="0" step="0.01" value={m.labor_rate ?? ""} placeholder="0.00"
                        onChange={(e) => patchMat(mi, { labor_rate: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value) || 0), ...(m.labor_unit ? {} : { labor_unit: guessLaborUnit(m) || "SF" }) })} aria-label="Labor rate" />
                      <select value={m.labor_unit || ""} onChange={(e) => patchMat(mi, { labor_unit: e.target.value, ...(e.target.value === "SF" && t.measure === "wall" && !m.labor_sides ? { labor_sides: wallSides() } : {}) })} aria-label="Labor unit">
                        {LABOR_UNITS.map((u) => <option key={u.id} value={u.id}>{u.id === "unit" ? `per ${m.unit || "unit"} bought` : u.label}</option>)}
                      </select>
                      {m.labor_unit === "SF" && t.measure === "wall" && (
                        <select value={m.labor_sides || 1} onChange={(e) => patchMat(mi, { labor_sides: Number(e.target.value) })} aria-label="Wall sides" title="Sides of the wall this applies to">
                          <option value={1}>× 1 side</option><option value={2}>× 2 sides</option>
                        </select>)}
                    </span>
                    <input className="va-note" value={m.note || ""} placeholder="note" onChange={(e) => patchMat(mi, { note: e.target.value })} aria-label="Note" />
                  </div>
                </div>
              ))}
            </div>

            <button className="vp-btn va-laborbtn" onClick={addLaborItem}>+ Labor-only item</button>

            {t.materials.length > 0 && (() => {
              const pv = preview(t);
              return (
                <div className="va-preview">
                  <h3>For {pv.label} this orders:</h3>
                  <ul>{pv.materials.filter((m) => m.kind !== "labor").map((m, i) => <li key={i}><strong>{m.qty}</strong> {m.unit} <span className="vp-muted">{m.name}</span>{m.cost != null ? <span className="va-cost"> {money(m.cost)}</span> : null}</li>)}</ul>
                  {pv.matCost > 0 && <p className="va-costline">Material cost <strong>{money(pv.matCost)}</strong>{pv.labor.total > 0 && <> · labor <strong>{money(pv.labor.total)}</strong> · total <strong>{money(pv.matCost + pv.labor.total)}</strong>{pv.totalPer ? ` (${pv.totalPer})` : ""}</>}</p>}
                  {pv.labor.lines.length > 0 && (<>
                    <h3 className="va-labor-h">Labor</h3>
                    <table className="va-labor-table"><tbody>
                      {pv.labor.lines.map((l, i) => <tr key={i}><td>{l.name}</td><td>{l.qty.toLocaleString()} {l.unit}</td><td>@ ${l.rate.toFixed(2)}</td><td><strong>${l.cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td></tr>)}
                      <tr className="va-labor-total"><td colSpan={3}>Labor total{pv.per ? ` (${pv.per})` : ""}</td><td><strong>${pv.labor.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td></tr>
                    </tbody></table>
                  </>)}
                </div>
              );
            })()}
          </>)}
        </section>

        {/* ── material library ──────────────────────────────────────────── */}
        <aside className="va-col va-lib">
          <h2 className="va-h2">Material library <a className="va-manage" href="/materials">Manage prices →</a></h2>
          <input className="va-search" placeholder="Search materials…" value={libQuery} onChange={(e) => setLibQuery(e.target.value)} aria-label="Search materials" />
          {library.length === 0 && (
            <div className="va-lib-empty">
              <p className="vp-muted vp-small">No materials yet.</p>
              <button className="vp-btn vp-primary" onClick={() => updateLibrary(starterMaterials())}>Load Vanguard starter materials</button>
            </div>
          )}
          <div className="va-scroll">
            {libShown.map((m) => (
              <div key={m.id} className="va-libitem" draggable
                onDragStart={(e) => { e.dataTransfer.setData("application/x-vg-mat", m.id); e.dataTransfer.effectAllowed = "copy"; }}>
                <span className="va-grip" aria-hidden>⠿</span>
                <span className="va-libtext"><strong>{m.name}</strong><small>{m.unit_cost != null ? `${money(m.unit_cost)}/${m.unit || "unit"} · ` : ""}1 {m.unit || "unit"} per {m.per} {BASES.find((b) => b.id === (m.basis || "area"))?.label}{m.manufacturer ? ` · ${m.manufacturer}` : ""}</small></span>
                {t && <button className="va-add" title="Add to the selected assembly" onClick={() => addMat(m)}>+</button>}
                <button className="va-remove" title="Delete from the library (assemblies keep their copy)" onClick={() => { if (window.confirm(`Delete “${m.name}” from the material library? Assemblies already using it keep their copy.`)) updateLibrary(library.filter((x) => x.id !== m.id)); }}>×</button>
              </div>
            ))}
          </div>
          {newMat ? (
            <form className="va-newmat" onSubmit={(e) => { e.preventDefault(); if (!newMat.name.trim()) return; updateLibrary([...library, { id: newId("lib"), ...newMat, name: newMat.name.trim(), per: Number(newMat.per) || 0, round: true }]); setNewMat(null); }}>
              <input placeholder="Material name" value={newMat.name} onChange={(e) => setNewMat({ ...newMat, name: e.target.value })} autoFocus required />
              <div className="va-rate">1<input className="va-unit" placeholder="unit" value={newMat.unit} onChange={(e) => setNewMat({ ...newMat, unit: e.target.value })} />
                per<input className="va-per" type="number" min="0" step="0.01" value={newMat.per} onChange={(e) => setNewMat({ ...newMat, per: e.target.value })} />
                <select value={newMat.basis} onChange={(e) => setNewMat({ ...newMat, basis: e.target.value })}>{BASES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select></div>
              <div className="vp-row"><button type="button" className="vp-btn vp-ghost" onClick={() => setNewMat(null)}>Cancel</button><button className="vp-btn vp-primary">Add material</button></div>
            </form>
          ) : (
            <button className="vp-btn va-newmat-btn" onClick={() => setNewMat({ name: "", unit: "ea", per: 1, basis: "area", note: "" })}>+ New material</button>
          )}
        </aside>
      </div>
    </main>
  );
}
