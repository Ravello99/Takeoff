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
