// Vanguard — "Read schedule" (AI tools, inside a takeoff project): Takeoff
// finds the partition / wall-type schedule in the project's own drawings
// (lib/scheduleFinder), the AI reads it, the estimator checks and fixes the
// wall types in a table, and they become THIS project's assemblies. A
// screenshot still works for scans or a schedule the search missed. The
// corrected rows go back to the server with the AI's original answer —
// training data.
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/vanguardApi.js";
import { normalizeWall, baseFor, wallToAssembly } from "../../lib/aiSchedule.js";

const MAX_SIDE = 2200;   // keep images readable but not huge

async function fileToDataUrl(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  } finally { URL.revokeObjectURL(url); }
}

const BASE_LABEL = { W1: "Standard", W2: "Acoustic", W3: "To deck", W4: "Acoustic to deck", W5: "2-layer rated", SW1: "Shaft wall", F1: "Furring / 1 side" };

export default function ScheduleReader({ onAdd, onClose, findSchedule, renderSheet, visibleArea, currentSheet, addLabel = "to this project" }) {
  const [image, setImage] = useState(null);
  // project search: { status: "searching"|"done", progress, candidates: [{ key, label, score, text }], pick }
  const [search, setSearch] = useState(findSchedule ? { status: "searching", progress: "", candidates: [], pick: 0 } : null);
  const [showText, setShowText] = useState(false);
  const [asPicture, setAsPicture] = useState(false);   // send the found schedule as a picture drawn from the PDF instead of its text
  const [rendering, setRendering] = useState(false);
  // draw a sheet (or its schedule area) straight from the PDF — no screenshot
  const drawSheet = async (key, rect) => {
    setRendering(true); setError("");
    try { return await renderSheet(key, rect); }
    catch (e) { setError("Couldn't draw that sheet: " + (e?.message || e)); return null; }
    finally { setRendering(false); }
  };
  const useImage = !search || search.status === "image";
  const found = search && search.status === "done" ? search.candidates[search.pick] : null;
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);   // { log_id, model, ms, rows: [{...normalized, include}] }
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef(null);

  const take = async (file) => {
    if (!file || !file.type.startsWith("image/")) { setError("That isn't an image. Take a screenshot of the schedule (Windows: Win+Shift+S) and paste it here."); return; }
    setError(""); setResult(null);
    setSearch((x) => (x ? { ...x, status: "image" } : x));   // a pasted screenshot wins over the found schedule
    setImage(await fileToDataUrl(file));
  };
  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (item) { e.preventDefault(); take(item.getAsFile()); }
    };
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("paste", onPaste); window.removeEventListener("keydown", onKey); };
  }, [busy, onClose]);

  useEffect(() => {
    if (!findSchedule) return;
    let live = true;
    findSchedule((progress) => { if (live) setSearch((x) => (x ? { ...x, progress } : x)); })
      .then((candidates) => { if (live) setSearch({ status: candidates.length ? "done" : "image", progress: "", candidates, pick: 0, missed: !candidates.length }); })
      .catch((e) => { if (live) { setSearch({ status: "image", progress: "", candidates: [], pick: 0, missed: true }); setError(String(e?.message || e)); } });
    return () => { live = false; };
  }, [findSchedule]);

  const read = async () => {
    setBusy(true); setError(""); setElapsed(0);
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    try {
      let payload;
      if (found && !useImage && asPicture) {
        const pic = await drawSheet(found.key, found.rect);
        if (!pic) throw new Error("Couldn't draw the schedule from the PDF.");
        payload = { image: pic, hint };
      } else payload = found && !useImage ? { text: found.text, source: found.label, hint } : { image, hint };
      const r = await api("POST", "/api/ai/read-schedule", { json: payload });
      if (r.error && !r.walls.length) setError(r.error);
      setResult({ ...r, rows: r.walls.map((w) => ({ ...normalizeWall(w), include: true })) });
    } catch (e) { setError(e.message); } finally { clearInterval(timer.current); setBusy(false); }
  };

  const patch = (i, p) => setResult({ ...result, rows: result.rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const chosen = result?.rows.filter((r) => r.include) || [];
  const add = async () => {
    const final = result.rows.map(({ include, ...r }) => ({ ...r, included: include }));
    api("POST", "/api/ai/feedback", { json: { log_id: result.log_id, final } }).catch(() => {});
    onAdd(chosen.map(({ include, ...w }) => wallToAssembly(w)));
  };

  return (
    <div className="vp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="vp-dialog vs-dialog" role="dialog" aria-label="Read a wall schedule with AI">
        <header><h2>Read the wall schedule</h2><button className="vp-x" onClick={onClose} disabled={busy} aria-label="Close">×</button></header>
        {!result && search && search.status === "searching" && (
          <p className="vp-small">Looking for the partition schedule in this project's drawings… <span className="vp-muted">{search.progress}</span></p>
        )}
        {!result && found && !useImage && (<>
          <p className="vp-small">Found the wall schedule on <strong>{found.label}</strong>{found.heading ? <> — <span className="vp-muted">{found.heading}</span></> : null}.</p>
          {search.candidates.length > 1 && (
            <label className="va-f"><span>Wrong sheet? Pick another</span>
              <select value={search.pick} onChange={(e) => setSearch({ ...search, pick: Number(e.target.value) })}>
                {search.candidates.map((c, i) => <option key={c.key} value={i}>{c.label}{c.heading ? ` — ${c.heading}` : ""}</option>)}
              </select></label>
          )}
          <div className="vp-row" style={{ justifyContent: "flex-start", gap: 14, flexWrap: "wrap" }}>
            <label className="vp-small"><input type="radio" checked={!asPicture} onChange={() => setAsPicture(false)} /> Send the schedule's text <span className="vp-muted">(fastest)</span></label>
            {renderSheet && <label className="vp-small"><input type="radio" checked={asPicture} onChange={() => setAsPicture(true)} /> Send a picture of it from the PDF <span className="vp-muted">(for tables the text reads badly; needs an image-capable model)</span></label>}
          </div>
          <button type="button" className="vp-btn vp-ghost vp-small" onClick={() => setShowText((v) => !v)}>{showText ? "Hide" : "Show"} what the AI will read</button>
          {showText && <pre className="vs-text" style={{ maxHeight: 220, overflow: "auto", fontSize: 11, whiteSpace: "pre-wrap", background: "var(--paper)", padding: 8, border: "1px solid var(--ink-faint)" }}>{found.text}</pre>}
          <label className="va-f"><span>Anything the AI should know? (optional)</span>
            <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. all partitions go to deck unless noted" /></label>
          {error && <p className="vp-error">{error}</p>}
          <div className="vp-row">
            <button className="vp-btn vp-ghost" onClick={() => setSearch({ ...search, status: "image" })} disabled={busy}>Pick it myself instead</button>
            <button className="vp-btn vp-primary" onClick={read} disabled={busy}>
              {busy ? (rendering ? "Drawing the schedule…" : `Reading… ${elapsed}s${elapsed > 15 ? " (the first read after a quiet spell loads the model)" : ""}`) : "Read schedule"}
            </button>
          </div>
        </>)}
        {!result && useImage && (<>
          {search?.missed && <p className="vp-small">Couldn't find a partition schedule in this project's text (the drawings may be scanned).</p>}
          {renderSheet && (
            <div className="vp-row" style={{ justifyContent: "flex-start" }}>
              <button type="button" className="vp-btn vp-primary" disabled={busy || rendering} onClick={async () => { const v = visibleArea ? visibleArea() : null; const pic = await drawSheet(v?.key || null, v?.rect || null); if (pic) { setImage(pic); setResult(null); } }}>
                {rendering ? "Drawing…" : `Use what's on screen${currentSheet ? ` (${currentSheet})` : ""}`}
              </button>
              <span className="vp-small vp-muted">Close this, zoom the plan to the schedule, then reopen Read schedule and click this. It's drawn sharp from the PDF — no screenshot. Or paste one below.</span>
            </div>
          )}
          <p className="vp-small vp-muted">Screenshot just the <strong>partition schedule / wall types</strong> from the drawings (Windows: <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>, Mac: <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>4</kbd>) and press <kbd>Ctrl</kbd>+<kbd>V</kbd> here, or choose an image file.</p>
          <label className={`vs-drop${image ? " has-image" : ""}`}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); take(e.dataTransfer.files?.[0]); }}>
            {image ? <img src={image} alt="Schedule to read" /> : <span>Paste a screenshot here, drop an image, or click to choose a file</span>}
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => take(e.target.files?.[0])} />
          </label>
          <label className="va-f"><span>Anything the AI should know? (optional)</span>
            <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. all partitions go to deck unless noted" /></label>
          {error && <p className="vp-error">{error}</p>}
          <div className="vp-row">
            {search && search.candidates.length > 0
              ? <button className="vp-btn vp-ghost" onClick={() => setSearch({ ...search, status: "done" })} disabled={busy}>Back to the found schedule</button>
              : <button className="vp-btn vp-ghost" onClick={onClose} disabled={busy}>Cancel</button>}
            <button className="vp-btn vp-primary" onClick={read} disabled={!image || busy}>
              {busy ? `Reading… ${elapsed}s${elapsed > 15 ? " (the first read after a quiet spell loads the model)" : ""}` : "Read schedule"}
            </button>
          </div>
        </>)}
        {result && (<>
          <p className="vp-small vp-muted">Found {result.rows.length} wall type{result.rows.length === 1 ? "" : "s"} in {(result.ms / 1000).toFixed(1)}s. <strong>Check each row against the drawing</strong> and fix anything wrong; your fixes are saved to make the AI better.</p>
          {error && <p className="vp-error">{error}</p>}
          <div className="vs-table-wrap"><table className="vs-table">
            <thead><tr><th></th><th>Tag</th><th>Stud size</th><th>Gauge</th><th>O.C.</th><th>Layers / side</th><th>Sides</th><th>To deck</th><th>Insulation</th><th>Rating</th><th>Starts from</th></tr></thead>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={i} className={r.include ? "" : "is-off"}>
                  <td><input type="checkbox" checked={r.include} onChange={(e) => patch(i, { include: e.target.checked })} aria-label={`Include ${r.tag}`} /></td>
                  <td><input className="vs-tag" value={r.tag} onChange={(e) => patch(i, { tag: e.target.value })} /></td>
                  <td><input value={r.stud_size} onChange={(e) => patch(i, { stud_size: e.target.value })} placeholder={'3-5/8"'} /></td>
                  <td><input className="vs-sm" value={r.stud_gauge} onChange={(e) => patch(i, { stud_gauge: e.target.value })} placeholder="20ga" /></td>
                  <td><select value={r.stud_oc} onChange={(e) => patch(i, { stud_oc: Number(e.target.value) })}>{[12, 16, 19.2, 24].map((n) => <option key={n} value={n}>{n}"</option>)}</select></td>
                  <td><select value={r.layers_per_side || ""} onChange={(e) => patch(i, { layers_per_side: e.target.value ? Number(e.target.value) : null })}><option value="">default</option>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></td>
                  <td><select value={r.sides} onChange={(e) => patch(i, { sides: Number(e.target.value) })}><option value={2}>2</option><option value={1}>1</option></select></td>
                  <td><input type="checkbox" checked={r.to_deck} onChange={(e) => patch(i, { to_deck: e.target.checked })} aria-label="To deck" /></td>
                  <td><input value={r.insulation} onChange={(e) => patch(i, { insulation: e.target.value })} placeholder="none" /></td>
                  <td><input className="vs-sm" value={r.fire_rating} onChange={(e) => patch(i, { fire_rating: e.target.value })} /></td>
                  <td className="vp-muted vp-small">{BASE_LABEL[baseFor(r)] || baseFor(r)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="vp-row">
            <button className="vp-btn vp-ghost" onClick={() => setResult(null)}>Back</button>
            <button className="vp-btn vp-primary" onClick={add} disabled={!chosen.length}>Add {chosen.length} assembl{chosen.length === 1 ? "y" : "ies"} {addLabel}</button>
          </div>
        </>)}
      </div>
    </div>
  );
}
