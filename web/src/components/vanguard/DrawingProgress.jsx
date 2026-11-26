// Vanguard — the "adding drawings" card: reading the files, uploading them (with
// real byte progress from vanguardApi.transfer), and opening them. Shown on the
// canvas AND on the Plan set screen, so adding plans is never a silent wait.
import React from "react";

const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);

export default function DrawingProgress({ importing, transfers, fixed = false }) {
  const list = Object.values(transfers || {});
  if (!importing && !list.length) return null;
  const loaded = list.reduce((n, t) => n + (t.loaded || 0), 0), total = list.reduce((n, t) => n + (t.total || 0), 0);
  const up = list.some((t) => t.dir === "up");
  const pct = list.length && total ? Math.min(100, Math.round((loaded / total) * 100)) : null;
  const title = list.length
    ? (up ? "Uploading drawings" : "Loading drawings")
    : importing?.phase === "opening" ? "Opening drawings" : "Reading files";
  const names = list.length ? list.map((t) => t.name).filter(Boolean).join(", ") : (importing?.names || []).join(", ");
  const step = importing?.of > 1 && importing?.at ? ` · file ${importing.at} of ${importing.of}` : "";
  const meta = list.length
    ? (pct == null ? "Working…" : `${pct}% · ${mb(loaded)} of ${mb(total)} MB${up && pct === 100 ? " · saving on the server…" : ""}`)
    : importing?.msg || "Working…";
  return (
    <div className="vg-progress" role="status" aria-live="polite" style={fixed ? { position: "fixed", zIndex: 1000 } : undefined}>
      <div className="vg-progress-title">{title}{step}</div>
      <div className="vg-progress-name">{names}</div>
      <div className="vg-progress-bar"><span style={{ width: pct == null ? "35%" : `${pct}%` }} className={pct == null ? "is-indeterminate" : ""} /></div>
      <div className="vg-progress-meta">{meta}</div>
    </div>
  );
}
