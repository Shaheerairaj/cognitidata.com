import type { CSSProperties } from "react";

// Hub TopBar (frontend-design.md §4): brand mark + name + a context pill (market),
// no stepper (the proposal's stepper is proposal-specific). Right side carries
// lightweight DB/result counts as mono metadata.
const eyebrow: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  letterSpacing: "0.06em",
  color: "var(--ink-4)",
};

export function TopBar({
  market,
  meta,
}: {
  market?: string;
  meta?: string;
}) {
  return (
    <header
      style={{
        minHeight: 56,
        padding: "calc(8px * var(--space)) calc(20px * var(--space))",
        borderBottom: "1px solid var(--hair)",
        background: "var(--surface)",
        display: "flex",
        alignItems: "center",
        gap: "calc(12px * var(--space))",
        flex: "0 0 auto",
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: "calc(5px * var(--radius-scale))",
          background: "var(--ink)",
          color: "var(--on-ink)",
          display: "grid",
          placeItems: "center",
          fontFamily: "var(--sans)",
          fontWeight: 700,
          fontSize: 12.5,
        }}
      >
        CD
      </div>
      <span
        className="tight"
        style={{ fontWeight: 600, fontSize: 16 }}
      >
        Intelligence Hub
      </span>
      {market && (
        <span
          style={{
            marginLeft: "calc(6px * var(--space))",
            fontSize: 14,
            color: "var(--ink-2)",
            background: "var(--surface-2)",
            border: "1px solid var(--hair)",
            borderRadius: "calc(20px * var(--radius-scale))",
            padding: "calc(3px * var(--space)) calc(10px * var(--space))",
            display: "inline-flex",
            alignItems: "center",
            gap: "calc(6px * var(--space))",
          }}
        >
          Market{" "}
          <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {market.toUpperCase()}
          </span>
        </span>
      )}
      <div style={{ flex: 1 }} />
      {meta && <span style={eyebrow}>{meta}</span>}
    </header>
  );
}
