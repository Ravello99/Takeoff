// Vanguard — Materials page (/materials): the company material catalog.
//
// A searchable table grouped by category with prices editable in place; a
// side panel with every field (product, size, gauge, flange, manufacturer,
// supplier, SKU, cost, coverage, labor, price history); CSV export; and a
// price-list import that shows every change for review before saving.
// Prices flow into the assemblies that use each material.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/vanguardApi.js";
import { sanitizeMaterialLibrary, libFields } from "../../lib/materials.js";
import { sanitizeTemplates } from "../../lib/templates.js";
import { DRYWALL_DEFAULTS } from "../../lib/drywallDefaults.js";
import { LABOR_UNITS, guessLaborUnit } from "../../lib/labor.js";
import {
  MATERIAL_CATEGORIES, guessCategory, buildName, money, withPrice,
  toCsv, parseCsv, matchRows, applyChanges, syncAssemblies,
} from "../../lib/materialCatalog.js";
import "../../styles/vanguardAssemblies.css";
import "../../styles/vanguardMaterials.css";

const BASES = [{ id: "area", label: "SF" }, { id: "linear", label: "LF" }, { id: "perimeter", label: "perimeter LF" }, { id: "count", label: "EA" }];
const SCALES = [{ id: "", label: "Fixed rate" }, { id: "layers", label: "Board layers" }, { id: "oc_stud", label: "Stud O.C." }, { id: "oc_chan", label: "Channel O.C." }, { id: "oc_cross", label: "Cross tee O.C." }];
const newId = () => `lib-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const today = () => new Date().toISOString().slice(0, 10);

function starterMaterials() {
  const seen = new Map();
  for (const t of DRYWALL_DEFAULTS) for (const m of t.materials || []) {
    if (!seen.has(m.name)) seen.set(m.name, { id: newId(), ...libFields(m), category: guessCategory(m), labor_unit: m.labor_unit ?? guessLaborUnit(m) });
  }
  return [...seen.values()];
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function MaterialsPage() {
  const [lib, setLib] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [openId, setOpenId] = useState(null);
  const [importing, setImporting] = useState(false);
  const timer = useRef({});
  const templatesRef = useRef(null);

  useEffect(() => {
    Promise.all([api("GET", "/api/library/materials"), api("GET", "/api/library/templates")]).then(([m, t]) => {
      setLib(sanitizeMaterialLibrary(m.value || []));
      const tpl = sanitizeTemplates(t.value || []);
      setTemplates(tpl); templatesRef.current = tpl;
    }, (e) => setError(e.message));
  }, []);

  // autosave the catalog; prices/product data also flow into linked assembly lines
  const save = useCallback((next) => {
    setLib(next);
    setStatus("Saving…");
    clearTimeout(timer.current.lib);
    timer.current.lib = setTimeout(async () => {
      try {
        await api("PUT", "/api/library/materials", { json: { value: next } });
        const synced = syncAssemblies(templatesRef.current || [], next);
        if (synced !== templatesRef.current) {
          templatesRef.current = synced; setTemplates(synced);
          await api("PUT", "/api/library/templates", { json: { value: synced } });
        }
        setStatus("All changes saved");
      } catch (e) { setStatus(""); setError(e.message); }
    }, 600);
  }, []);

  const update = (id, patch) => save(lib.map((m) => {
    if (m.id !== id) return m;
    const n = { ...m, ...patch };
    if (n.name_auto !== false && ["product", "size", "gauge", "flange", "length"].some((k) => k in patch)) {
      const built = buildName(n);
      if (built) n.name = built;
    }
    return n;
  }));
  const setCost = (id, v) => save(lib.map((m) => (m.id === id ? (v === "" ? { ...m, unit_cost: undefined } : withPrice(m, v, "edited")) : m)));

  const counts = useMemo(() => {
    const c = new Map();
    for (const m of lib || []) c.set(guessCategory(m), (c.get(guessCategory(m)) || 0) + 1);
    return c;
  }, [lib]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (lib || []).filter((m) => (!cat || guessCategory(m) === cat)
      && (!s || [m.name, m.sku, m.manufacturer, m.supplier, m.product, m.size, m.gauge, m.note].some((v) => String(v || "").toLowerCase().includes(s))));
  }, [lib, q, cat]);
  const groups = useMemo(() => {
    const order = [...MATERIAL_CATEGORIES];
    const by = new Map();
    for (const m of shown) { const k = guessCategory(m); if (!by.has(k)) by.set(k, []); by.get(k).push(m); }
    return [...by.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99) || a[0].localeCompare(b[0]));
  }, [shown]);
  const usage = useMemo(() => {
    const u = new Map();
    for (const t of templates || []) for (const line of t.materials || []) if (line.lib_id) u.set(line.lib_id, [...(u.get(line.lib_id) || []), t.finish_tag]);
    return u;
  }, [templates]);
  const priced = (lib || []).filter((m) => m.unit_cost != null).length;

  if (error && !lib) return <main className="va-page"><p className="vp-error">{error}</p></main>;
  if (!lib) return <main className="va-page"><p className="vp-muted">Loading materials…</p></main>;
  const open = lib.find((m) => m.id === openId);

  const addMaterial = () => {
    const m = { id: newId(), name: "New material", name_auto: true, category: cat || "Steel framing", unit: "ea", per: 1, basis: "area", round: true, note: "" };
    save([...lib, m]); setOpenId(m.id);
  };

  return (
    <main className="va-page vm-page">
      <div className="va-head">
        <div>
          <h1>Materials</h1>
          <p className="vp-muted">{lib.length} materials · {priced} priced. Prices here flow into every assembly that uses them. <span className="va-status">{status}</span></p>
        </div>
        <div className="vp-row">
          <button className="vp-btn" onClick={() => download(`vanguard-materials-${today()}.csv`, toCsv(lib))} disabled={!lib.length}>Export CSV</button>
          <button className="vp-btn" onClick={() => setImporting(true)}>Import price list</button>
          <button className="vp-btn vp-primary" onClick={addMaterial}>+ New material</button>
        </div>
      </div>
      {error && <p className="vp-error">{error}</p>}

      {lib.length === 0 && (
        <div className="va-banner">
          <div><strong>Start with Vanguard's drywall materials?</strong><p className="vp-muted">Studs, track, board, finishing, ceiling grid and trims with coverage rates and labor units. Add your prices and suppliers after.</p></div>
          <button className="vp-btn vp-primary" onClick={() => save(starterMaterials())}>Load starter materials</button>
        </div>
      )}

      <div className="vm-filters">
        <input className="va-search" placeholder="Search name, SKU, manufacturer, supplier…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search materials" />
        <div className="vm-chips" role="group" aria-label="Category">
          <button className={!cat ? "is-on" : ""} onClick={() => setCat("")}>All <span>{lib.length}</span></button>
          {MATERIAL_CATEGORIES.filter((c) => counts.get(c)).map((c) => <button key={c} className={cat === c ? "is-on" : ""} onClick={() => setCat(c)}>{c} <span>{counts.get(c)}</span></button>)}
        </div>
      </div>

      <div className="vm-tablewrap">
        <table className="vm-table">
          <thead><tr>
            <th>Material</th><th>Size</th><th>Gauge</th><th>Flange</th><th>Supplier</th>
            <th className="vm-num">Cost</th><th>Unit</th><th>Coverage</th><th>Labor</th><th>Updated</th>
          </tr></thead>
          <tbody>
            {groups.map(([g, items]) => [
              <tr key={`h-${g}`} className="vm-group"><td colSpan={10}>{g} <span>{items.length}</span></td></tr>,
              ...items.map((m) => (
                <tr key={m.id} className={m.id === openId ? "is-open" : ""} onClick={() => setOpenId(m.id)}>
                  <td><strong>{m.name}</strong><small>{[m.manufacturer, m.sku && `SKU ${m.sku}`].filter(Boolean).join(" · ") || (usage.get(m.id) ? `used in ${usage.get(m.id).join(", ")}` : "")}</small></td>
                  <td>{m.size || ""}</td><td>{m.gauge || ""}</td><td>{m.flange || ""}</td><td>{m.supplier || ""}</td>
                  <td className="vm-num" onClick={(e) => e.stopPropagation()}>
                    <span className="vm-cost">$<input type="number" min="0" step="0.01" defaultValue={m.unit_cost ?? ""} key={`${m.id}-${m.unit_cost}`} placeholder="—"
                      onBlur={(e) => { if (e.target.value !== String(m.unit_cost ?? "")) setCost(m.id, e.target.value); }}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} aria-label={`Cost of ${m.name}`} /></span>
                  </td>
                  <td>{m.unit || ""}</td>
                  <td className="vp-muted">1 {m.unit || "unit"} / {m.per} {BASES.find((b) => b.id === (m.basis || "area"))?.label}</td>
                  <td className="vp-muted">{m.labor_unit && m.labor_rate ? `${money(m.labor_rate)}/${m.labor_unit === "unit" ? m.unit || "unit" : m.labor_unit}` : m.labor_unit ? `per ${m.labor_unit}` : ""}</td>
                  <td className="vp-muted">{m.cost_updated || ""}</td>
                </tr>
              )),
            ])}
            {shown.length === 0 && lib.length > 0 && <tr><td colSpan={10} className="vp-muted vm-empty">No materials match.</td></tr>}
          </tbody>
        </table>
      </div>

      {open && <MaterialDrawer m={open} usage={usage.get(open.id) || []} onChange={(p) => update(open.id, p)} onCost={(v) => setCost(open.id, v)}
        onClose={() => setOpenId(null)}
        onDuplicate={() => { const c = { ...open, id: newId(), name: `${open.name} (copy)`, name_auto: false, price_history: [] }; save([...lib, c]); setOpenId(c.id); }}
        onDelete={() => { if (window.confirm(`Delete “${open.name}”? Assemblies that use it keep their copy.`)) { save(lib.filter((m) => m.id !== open.id)); setOpenId(null); } }} />}

      {importing && <ImportDialog lib={lib} onClose={() => setImporting(false)} onApply={(result, source) => { save(applyChanges(lib, result, source, newId)); setImporting(false); }} />}
    </main>
  );
}

function F({ label, children, wide }) {
  return <label className={`va-f${wide ? " va-desc" : ""}`}><span>{label}</span>{children}</label>;
}

function MaterialDrawer({ m, usage, onChange, onCost, onClose, onDuplicate, onDelete }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const txt = (k) => ({ value: m[k] ?? "", onChange: (e) => onChange({ [k]: e.target.value || undefined }) });
  return (
    <aside className="vm-drawer" role="dialog" aria-label={`Edit ${m.name}`}>
      <header>
        <h2>{m.name}</h2>
        <button className="vp-x" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="vm-drawer-body">
        <section>
          <h3>Product</h3>
          <div className="vm-grid">
            <F label="Category"><input list="vm-cats" {...txt("category")} placeholder={guessCategory(m)} /><datalist id="vm-cats">{MATERIAL_CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist></F>
            <F label="Product"><input {...txt("product")} placeholder="Steel stud" /></F>
            <F label="Size"><input {...txt("size")} placeholder={'3-5/8"'} /></F>
            <F label="Gauge / thickness"><input {...txt("gauge")} placeholder="20ga" /></F>
            <F label="Flange"><input {...txt("flange")} placeholder={'1-1/4"'} /></F>
            <F label="Length"><input {...txt("length")} placeholder="10'" /></F>
          </div>
          <F label="Name used in assemblies" wide>
            <input value={m.name} onChange={(e) => onChange({ name: e.target.value, name_auto: false })} />
          </F>
          <label className="vp-check"><input type="checkbox" checked={m.name_auto !== false} onChange={(e) => onChange(e.target.checked ? { name_auto: true, name: buildName(m) || m.name } : { name_auto: false })} /> Build the name from product, size, gauge, flange and length</label>
        </section>
        <section>
          <h3>Supplier</h3>
          <div className="vm-grid">
            <F label="Manufacturer"><input {...txt("manufacturer")} placeholder="Saturn Maple Steel" /></F>
            <F label="Supplier"><input {...txt("supplier")} placeholder="Who you buy from" /></F>
            <F label="SKU / product code"><input {...txt("sku")} placeholder="Matches price lists" /></F>
          </div>
        </section>
        <section>
          <h3>Price</h3>
          <div className="vm-grid">
            <F label={`Cost per ${m.unit || "unit"}`}>
              <input type="number" min="0" step="0.01" defaultValue={m.unit_cost ?? ""} key={`c-${m.unit_cost}`}
                onBlur={(e) => { if (e.target.value !== String(m.unit_cost ?? "")) onCost(e.target.value); }} />
            </F>
            <F label="Purchase unit"><input {...txt("unit")} placeholder="pc, sheet, box" /></F>
          </div>
          {m.price_history?.length > 0 && (
            <table className="vm-history"><tbody>
              {m.price_history.slice(0, 8).map((h, i) => <tr key={i}><td>{h.date}</td><td>{money(h.cost)}</td><td className="vp-muted">{h.source}</td></tr>)}
            </tbody></table>
          )}
        </section>
        <section>
          <h3>Coverage (how much an assembly needs)</h3>
          <div className="va-rate vm-rate">1 {m.unit || "unit"} per
            <input className="va-per" type="number" min="0" step="0.01" value={m.per ?? 0} onChange={(e) => onChange({ per: Number(e.target.value) || 0 })} />
            <select value={m.basis || "area"} onChange={(e) => onChange({ basis: e.target.value })}>{BASES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
            <select value={m.scale || ""} onChange={(e) => onChange({ scale: e.target.value || undefined, ...(e.target.value === "layers" && !m.layers_base ? { layers_base: 1 } : {}) })}>{SCALES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
          </div>
        </section>
        <section>
          <h3>Default labor</h3>
          <div className="va-rate vm-rate">$<input className="va-lrate" type="number" min="0" step="0.01" value={m.labor_rate ?? ""} placeholder="0.00"
            onChange={(e) => onChange({ labor_rate: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value) || 0), ...(m.labor_unit ? {} : { labor_unit: guessLaborUnit(m) || "SF" }) })} />
            <select value={m.labor_unit || ""} onChange={(e) => onChange({ labor_unit: e.target.value })}>{LABOR_UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</select>
          </div>
        </section>
        <F label="Note" wide><textarea rows={2} {...txt("note")} /></F>
        {usage.length > 0 && <p className="vp-muted vp-small">Used in: {usage.join(", ")}</p>}
      </div>
      <footer className="vp-row">
        <button className="vp-btn vp-ghost vp-danger" onClick={onDelete}>Delete</button>
        <button className="vp-btn vp-ghost" onClick={onDuplicate}>Duplicate</button>
        <button className="vp-btn vp-primary" onClick={onClose}>Done</button>
      </footer>
    </aside>
  );
}

function ImportDialog({ lib, onApply, onClose }) {
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState(null);
  const [addNew, setAddNew] = useState(false);
  const [skip, setSkip] = useState(new Set());
  const [err, setErr] = useState("");
  const result = useMemo(() => (rows ? matchRows(lib, rows, { addNew }) : null), [lib, rows, addNew]);
  const pick = async (f) => {
    setErr(""); setFile(f); setSkip(new Set());
    try {
      const parsed = parseCsv(await f.text());
      if (!parsed.length) throw new Error("No rows found. The first row should be column names (e.g. SKU, Description, Price).");
      if (!parsed.some((r) => r.unit_cost != null)) throw new Error("No price column found. Name it Cost or Price.");
      setRows(parsed);
    } catch (e) { setErr(e.message); setRows(null); }
  };
  const approved = result ? { changes: result.changes.filter((c) => !skip.has(c.id)), added: result.added } : null;
  const pct = (c) => (c.old ? `${c.new >= c.old ? "+" : ""}${(((c.new - c.old) / c.old) * 100).toFixed(1)}%` : "new");
  return (
    <div className="vp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="vp-dialog vm-import" role="dialog" aria-label="Import a price list">
        <header><h2>Import a price list</h2><button className="vp-x" onClick={onClose} aria-label="Close">×</button></header>
        <p className="vp-small vp-muted">Upload a CSV from your supplier (or from Excel: <em>Save As → CSV</em>). Rows are matched by <strong>SKU</strong>, then by name. Columns named SKU / Item #, Description, Price / Cost and Unit are recognised. You'll review every change before anything is saved.</p>
        <label className="vm-file">
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
          <span>{file ? file.name : "Choose a CSV file…"}</span>
        </label>
        <p className="vm-ai vp-small">Coming next: drop in a supplier's PDF price booklet and AI reads it into this same review.</p>
        {err && <p className="vp-error">{err}</p>}
        {result && (<>
          <h3>{result.changes.length} price change{result.changes.length === 1 ? "" : "s"}</h3>
          {result.changes.length > 0 && (
            <div className="vm-review"><table className="vm-table"><tbody>
              {result.changes.map((c) => (
                <tr key={c.id}>
                  <td><input type="checkbox" checked={!skip.has(c.id)} onChange={() => setSkip((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} aria-label={`Apply ${c.name}`} /></td>
                  <td><strong>{c.name}</strong><small>{c.sku}</small></td>
                  <td className="vm-num vp-muted">{c.old == null ? "—" : money(c.old)}</td><td>→</td>
                  <td className="vm-num"><strong>{money(c.new)}</strong></td>
                  <td className={`vm-num ${c.old && c.new > c.old ? "vm-up" : "vm-down"}`}>{pct(c)}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          {(result.unmatched.length > 0 || result.added.length > 0) && (
            <label className="vp-check"><input type="checkbox" checked={addNew} onChange={(e) => setAddNew(e.target.checked)} />
              {addNew ? `Add ${result.added.length} new material${result.added.length === 1 ? "" : "s"} from rows that didn't match` : `${result.unmatched.length} row${result.unmatched.length === 1 ? "" : "s"} didn't match any material. Add them as new materials?`}</label>
          )}
          <div className="vp-row">
            <button className="vp-btn vp-ghost" onClick={onClose}>Cancel</button>
            <button className="vp-btn vp-primary" disabled={!approved.changes.length && !approved.added.length}
              onClick={() => onApply(approved, file?.name || "price list")}>Apply {approved.changes.length} change{approved.changes.length === 1 ? "" : "s"}{approved.added.length ? ` + ${approved.added.length} new` : ""}</button>
          </div>
        </>)}
      </div>
    </div>
  );
}
