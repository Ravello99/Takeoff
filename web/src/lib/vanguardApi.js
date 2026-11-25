// Vanguard Takeoff — client for the server API (backend/server.py).
// Same-origin, cookie session. Every write carries the X-Vanguard header the
// server requires (a browser can't add it to a cross-site request).

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, { json, raw, signal } = {}) {
  const headers = {};
  if (method !== "GET") headers["X-Vanguard"] = "1";
  let body;
  if (json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  else if (raw !== undefined) { headers["Content-Type"] = "application/octet-stream"; body = raw; }
  let res;
  try {
    res = await fetch(path, { method, headers, body, credentials: "same-origin", signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach the Vanguard Takeoff server. Check your connection.");
  }
  const ctype = res.headers.get("Content-Type") || "";
  if (!res.ok) {
    let msg = `Request failed (${res.status}).`;
    if (ctype.includes("application/json")) {
      try { msg = (await res.json()).error || msg; } catch { /* keep generic */ }
    }
    if (res.status === 401 && path !== "/api/login") notifySignedOut();
    throw new ApiError(res.status, msg);
  }
  if (ctype.includes("application/json")) return res.json();
  return res.arrayBuffer();
}

// ── plan-file transfers with progress ─────────────────────────────────────
// fetch() can't report upload progress, so plan files go over XHR, and every
// transfer is announced to whoever listens (the canvas shows a progress card).
// Event: { id, dir: "up"|"down", name, loaded, total, done, error }
const transferListeners = new Set();
export function onTransfer(fn) { transferListeners.add(fn); return () => transferListeners.delete(fn); }
const emit = (ev) => { for (const fn of transferListeners) { try { fn(ev); } catch { /* a listener's bug never breaks a transfer */ } } };
let transferSeq = 0;

export function transfer(method, path, { raw, name = "", dir = raw ? "up" : "down" } = {}) {
  const id = ++transferSeq;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    xhr.responseType = "arraybuffer";
    if (method !== "GET") xhr.setRequestHeader("X-Vanguard", "1");
    if (raw !== undefined) xhr.setRequestHeader("Content-Type", "application/octet-stream");
    const total0 = raw ? raw.byteLength || 0 : 0;
    emit({ id, dir, name, loaded: 0, total: total0, done: false });
    const prog = (e) => emit({ id, dir, name, loaded: e.loaded, total: e.lengthComputable ? e.total : total0, done: false });
    if (dir === "up") xhr.upload.onprogress = prog; else xhr.onprogress = prog;
    xhr.onerror = () => { emit({ id, dir, name, done: true, error: true }); reject(new ApiError(0, "Can't reach the Vanguard Takeoff server. Check your connection.")); };
    xhr.onload = () => {
      const ctype = xhr.getResponseHeader("Content-Type") || "";
      const buf = xhr.response;
      const asJson = () => { try { return JSON.parse(new TextDecoder().decode(buf)); } catch { return null; } };
      emit({ id, dir, name, done: true, error: xhr.status >= 400 });
      if (xhr.status >= 400) {
        const j = ctype.includes("application/json") ? asJson() : null;
        if (xhr.status === 401) notifySignedOut();
        reject(new ApiError(xhr.status, j?.error || `Request failed (${xhr.status}).`));
        return;
      }
      resolve(ctype.includes("application/json") ? asJson() : buf);
    };
    xhr.send(raw === undefined ? null : raw);
  });
}

// The server is optional: a plain static host has no /api. Returns the status
// object, or null when there is no Vanguard server behind this site.
export async function serverStatus() {
  try {
    const res = await fetch("/api/status", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok || !(res.headers.get("Content-Type") || "").includes("application/json")) return null;
    const v = await res.json();
    return v && v.server ? v : null;
  } catch {
    return null;
  }
}

// A 401 mid-session (expired session, account turned off) sends the app
// back to the sign-in screen.
const SIGNED_OUT = "vanguard:signed-out";
function notifySignedOut() {
  try { window.dispatchEvent(new CustomEvent(SIGNED_OUT)); } catch { /* non-browser */ }
}
export function onSignedOut(fn) {
  window.addEventListener(SIGNED_OUT, fn);
  return () => window.removeEventListener(SIGNED_OUT, fn);
}

export const enc = encodeURIComponent;
