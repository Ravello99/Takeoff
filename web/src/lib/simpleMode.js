// Vanguard simple mode — a decluttered interface for everyday drywall
// takeoff. ON by default; Help → "Show all tools" turns it off for power
// users. Nothing is removed from the app: simple mode only hides controls.
// Stored per browser; components subscribe with useSimpleMode().
import { useEffect, useState } from "react";

const KEY = "vanguard_simple_mode";
const EVT = "vanguard:simple-mode";

export function isSimpleMode() {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}

export function setSimpleMode(on) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* session only */ }
  try { window.dispatchEvent(new CustomEvent(EVT, { detail: on })); } catch { /* non-browser */ }
}

export function useSimpleMode() {
  const [on, setOn] = useState(isSimpleMode);
  useEffect(() => {
    const sync = () => setOn(isSimpleMode());
    window.addEventListener(EVT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return on;
}

// One-time switch for browsers that used the app before simple mode
// existed: turn on the compact workspace in the light theme so everyone
// lands on the new design once. Later choices are respected.
const MIGRATED = "vanguard_simple_migrated_v1";
export function migrateWorkspacePrefs(layoutKey) {
  try {
    if (localStorage.getItem(MIGRATED)) return;
    localStorage.setItem(MIGRATED, "1");
    const raw = localStorage.getItem(layoutKey);
    if (!raw) return;   // first visit: defaults already apply
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return;
    v.enabled = true;
    v.layout = { ...(v.layout || {}), look: "light" };
    localStorage.setItem(layoutKey, JSON.stringify(v));
  } catch { /* storage unavailable — defaults apply */ }
}
