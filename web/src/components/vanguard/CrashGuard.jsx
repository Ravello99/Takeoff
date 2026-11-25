// Vanguard — when something on the screen crashes, show what happened and a way
// back instead of a blank white page. Takeoffs already saved are on the server;
// an unfinished Find walls review is kept in this browser and offered back after
// the reload (TakeoffCanvas "vt_wf_review").
import React from "react";

export default class CrashGuard extends React.Component {
  constructor(props) { super(props); this.state = { error: null, copied: false }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    // keep the details for "Copy details" (and the browser console)
    this.details = `${error?.stack || error}\n\nComponent stack:${info?.componentStack || ""}\n\nPage: ${window.location.href}\nWhen: ${new Date().toISOString()}\nBrowser: ${navigator.userAgent}`;
    console.error("[Vanguard] screen crashed:", error, info?.componentStack);
  }
  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const box = { maxWidth: 560, margin: "12vh auto", padding: "28px 30px", background: "#fff", border: "1px solid #DDE2EA", borderRadius: 14, boxShadow: "0 10px 34px rgba(11,37,86,.10)", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: "#1C2430" };
    const btn = { padding: "10px 18px", borderRadius: 8, border: "1px solid #DDE2EA", background: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 14 };
    return (
      <div style={{ minHeight: "100vh", background: "#F4F5F7", padding: 20 }}>
        <div style={box} role="alert">
          <h2 style={{ margin: "0 0 8px", color: "#0B2556" }}>Something went wrong on this screen</h2>
          <p style={{ margin: "0 0 12px", lineHeight: 1.5 }}>Your saved takeoffs are safe on the server. If you were in a <b>Find walls review</b>, it was kept in this browser — reload and Takeoff will offer to bring it back.</p>
          <pre style={{ background: "#F4F5F7", padding: 10, borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>{String(error?.message || error)}</pre>
          <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            <button style={{ ...btn, background: "#0B2556", borderColor: "#0B2556", color: "#fff" }} onClick={() => window.location.reload()}>Reload</button>
            <button style={btn} onClick={() => { navigator.clipboard?.writeText(this.details || String(error)).then(() => this.setState({ copied: true }), () => {}); }}>{copied ? "Copied" : "Copy details for support"}</button>
          </div>
        </div>
      </div>
    );
  }
}
