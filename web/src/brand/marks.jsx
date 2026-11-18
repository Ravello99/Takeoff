// Vanguard Drywall brand marks.
// Mark shows /brand/logo.svg (or logo.png) when present in web/public/brand/,
// and falls back to a simple "V" monogram until the real logo is added.
import { useState } from "react";

export function Wordmark({ size = 96, color = "var(--ink)", weight = 800, letterSpacing = "-0.03em" }) {
  return (
    <span
      style={{
        fontFamily: "var(--f-display)",
        fontWeight: weight,
        fontSize: size,
        lineHeight: 0.9,
        letterSpacing,
        color,
        display: "inline-flex",
        alignItems: "baseline",
        gap: "0.12em",
        fontOpticalSizing: "auto",
      }}
    >
      vanguard<span style={{ fontStyle: "italic", color: "var(--cobalt)" }}>takeoff</span>
    </span>
  );
}

export function Pip({ size = 7, color = "var(--cobalt)" }) {
  return <span style={{ display: "inline-block", width: size, height: size, background: color, verticalAlign: "middle" }} />;
}

const LOGO_SOURCES = ["/brand/logo.svg", "/brand/logo.png"];

export function Mark({ size = 100, ink = "var(--ink)", paper = "var(--paper-cream)", accent = "var(--cobalt)", style }) {
  const [idx, setIdx] = useState(0);
  if (idx < LOGO_SOURCES.length) {
    return (
      <img
        src={LOGO_SOURCES[idx]}
        width={size}
        height={size}
        alt="Vanguard Drywall"
        style={{ objectFit: "contain", ...style }}
        onError={() => setIdx(idx + 1)}
      />
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style} role="img" aria-label="Vanguard Drywall">
      <rect width="100" height="100" fill={paper} />
      <path d="M24 26 L50 76 L76 26" fill="none" stroke={ink} strokeWidth="9" strokeLinejoin="miter" />
      <rect x="20" y="80" width="60" height="5" fill={accent} />
    </svg>
  );
}
