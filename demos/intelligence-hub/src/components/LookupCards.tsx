import { useState } from "react";
import type { CSSProperties } from "react";
import type { HotelDetailArtifact, LookupAnswerArtifact } from "../types";

// Read-only LOOKUP renderers (ADR-019): `lookup-answer` (aggregate → a stat card) and
// `hotel-detail` (entity → a key/value detail card). Neither is selectable — they're answers,
// not working sets. (A list LOOKUP reuses the hotel-results card and becomes the live set.)

const mono: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  letterSpacing: "0.04em",
  color: "var(--ink-3)",
};
const card: CSSProperties = {
  border: "1px solid var(--hair)",
  borderRadius: "calc(12px * var(--radius-scale))",
  overflow: "hidden",
  background: "var(--surface)",
  maxWidth: 1040,
};
const head: CSSProperties = {
  padding: "calc(11px * var(--space)) calc(14px * var(--space))",
  background: "var(--surface-2)",
  borderBottom: "1px solid var(--hair)",
  display: "flex",
  alignItems: "center",
  gap: "calc(10px * var(--space))",
};
const title: CSSProperties = { fontFamily: "var(--sans)", fontSize: 15, fontWeight: 600 };

const emDash = <span style={{ color: "var(--ink-4)", fontStyle: "italic" }}>—</span>;

// ---- aggregate: a stat card with a collapsible SQL peek -----------------------
export function LookupAnswer({ artifact }: { artifact: LookupAnswerArtifact }) {
  const [showSql, setShowSql] = useState(false);
  const entries = Object.entries(artifact.stats);
  return (
    <div style={card}>
      <div style={head}>
        <span style={title}>Lookup result</span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setShowSql((s) => !s)}
          style={{ ...mono, fontSize: 11, background: "transparent", border: "none", cursor: "pointer", color: "var(--ink-4)" }}
        >
          {showSql ? "hide SQL" : "view SQL"}
        </button>
      </div>
      <div style={{ padding: "calc(16px * var(--space)) calc(16px * var(--space)) calc(4px * var(--space))" }}>
        {entries.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "calc(1px * var(--space))", background: "var(--hair-2)", border: "1px solid var(--hair-2)", borderRadius: "calc(8px * var(--radius-scale))", overflow: "hidden", marginBottom: "calc(14px * var(--space))" }}>
            {entries.map(([k, v]) => (
              <div key={k} style={{ background: "var(--surface)", padding: "calc(13px * var(--space)) calc(18px * var(--space))", flex: "1 0 auto", minWidth: 120 }}>
                <div style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 24, letterSpacing: "-0.02em", color: "var(--accent-ink)" }}>
                  {v ?? "—"}
                </div>
                <div style={{ ...mono, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-4)", marginTop: "calc(3px * var(--space))" }}>
                  {k.replace(/_/g, " ")}
                </div>
              </div>
            ))}
          </div>
        )}
        {showSql && (
          <pre style={{ ...mono, fontSize: 11.5, color: "var(--ink-2)", background: "var(--surface-2)", border: "1px solid var(--hair-2)", borderRadius: "calc(8px * var(--radius-scale))", padding: "calc(10px * var(--space)) calc(12px * var(--space))", overflowX: "auto", whiteSpace: "pre-wrap", margin: "0 0 calc(12px * var(--space))" }}>
            {artifact.sql}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---- entity: a key/value detail card -----------------------------------------
const kRow: CSSProperties = { ...mono, fontSize: 11, color: "var(--ink-4)", padding: "calc(7px * var(--space)) 0", borderBottom: "1px solid var(--hair-2)" };
const vRow: CSSProperties = { fontSize: 13.5, color: "var(--ink)", padding: "calc(7px * var(--space)) 0", borderBottom: "1px solid var(--hair-2)" };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <div style={kRow}>{k}</div>
      <div style={vRow}>{v === null || v === undefined || v === "" ? emDash : v}</div>
    </>
  );
}

export function HotelDetail({ artifact }: { artifact: HotelDetailArtifact }) {
  const h = artifact.hotel;
  const where = [h.city, h.country].filter(Boolean).join(", ");
  const keys = [h.keys, h.residences].some((n) => n != null)
    ? `${h.keys ?? "—"} keys${h.residences != null ? ` · ${h.residences} residences` : ""}`
    : null;
  const owner = h.ownerName ? (h.ownerType ? `${h.ownerType} · ${h.ownerName}` : h.ownerName) : null;
  return (
    <div style={card}>
      <div style={head}>
        <span style={title}>{h.name}</span>
        {where && <span style={mono}>{where}</span>}
      </div>
      <div style={{ padding: "calc(14px * var(--space)) calc(16px * var(--space))" }}>
        <div style={{ display: "grid", gridTemplateColumns: "132px 1fr" }}>
          <Row k="keys" v={keys} />
          <Row k="segment" v={h.segment} />
          <Row k="brand" v={h.brand} />
          <Row k="operator" v={h.operator} />
          <Row k="owner" v={owner} />
          <Row k="owner email" v={h.ownerEmail ? <span style={{ ...mono, fontSize: 12, color: "var(--accent-ink)" }}>{h.ownerEmail}</span> : null} />
          <Row k="amenities" v={h.amenities.length ? h.amenities.join(" · ") : null} />
          <Row k="status" v={h.status} />
        </div>
      </div>
    </div>
  );
}
