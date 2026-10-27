import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Artifact, Confidence, FieldProv, Hotel, ProvKey } from "../types";
import { Btn } from "./Btn";

// Inline artifact renderer (Option C). One self-contained, selectable card per
// artifact. Dispatches on `artifact.kind` so new kinds slot in without touching
// the thread. Today: hotel-results — a selectable hotel table whose cells carry
// on-selection enrichment values + provenance (ADR-015): each enriched cell shows
// its value, a confidence dot, and links to its first source. A single "Enrich" button
// (active with ≥1 row selected) runs the combined POST /api/enrich (facts + owner) over
// the selection. Compact card shows the core columns + a condensed amenity-chip set; the
// expand modal shows all columns.
//
// Single live set (ADR-017): only the most recent results card is `live` (interactive —
// selectable rows + the Enrich action). Earlier cards render frozen: read-only scrollback
// with no checkbox column, no row selection, and no Enrich button (Expand still views them).

const mono: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  letterSpacing: "0.04em",
  color: "var(--ink-3)",
};
const th: CSSProperties = {
  ...mono,
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--ink-4)",
  fontWeight: 500,
  textAlign: "left",
  padding: "calc(9px * var(--space)) calc(12px * var(--space))",
  borderBottom: "1px solid var(--hair)",
  position: "sticky",
  top: 0,
  background: "var(--surface)",
};
const td: CSSProperties = {
  padding: "calc(10px * var(--space)) calc(12px * var(--space))",
  borderBottom: "1px solid var(--hair-2)",
  color: "var(--ink-2)",
  verticalAlign: "top",
};

function Checkbox({ on }: { on: boolean }) {
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: "calc(4px * var(--radius-scale))",
        display: "inline-grid",
        placeItems: "center",
        verticalAlign: "middle",
        border: on ? "1.5px solid var(--accent)" : "1.5px solid var(--hair-3)",
        background: on ? "var(--accent)" : "transparent",
        color: "var(--on-accent)",
        fontSize: 11.5,
      }}
    >
      {on ? "✓" : ""}
    </span>
  );
}

const emDash = <span style={{ color: "var(--ink-4)", fontStyle: "italic" }}>—</span>;

// Confidence dot — high=green, medium=amber, low=grey (ADR-015).
const dotColor: Record<Confidence, string> = {
  high: "var(--ok)",
  medium: "var(--warn)",
  low: "var(--ink-4)",
};
function Dot({ confidence }: { confidence: Confidence }) {
  return (
    <span
      title={`${confidence} confidence`}
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: dotColor[confidence],
        display: "inline-block",
        flex: "0 0 auto",
      }}
    />
  );
}

// An enriched cell: value + confidence dot, with the value linking to its first source
// (new tab). Falls back to a plain rendering when the field has no provenance (e.g. a
// value carried over from discovery), and to the muted em-dash when there's no value.
function Cell({ value, prov }: { value: ReactNode; prov?: FieldProv }) {
  if (value === null || value === undefined || value === "") return emDash;
  if (!prov) return <span>{value}</span>;
  const href = prov.sources[0];
  const inner = href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ color: "var(--accent-ink)", textDecoration: "none", borderBottom: "1px solid var(--accent-tint)" }}
    >
      {value}
    </a>
  ) : (
    <span>{value}</span>
  );
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "calc(6px * var(--space))" }}>
      <Dot confidence={prov.confidence} />
      {inner}
    </span>
  );
}

const chipStyle: CSSProperties = {
  ...mono,
  fontSize: 10.5,
  letterSpacing: "0.03em",
  color: "var(--ink-2)",
  background: "var(--surface-2)",
  border: "1px solid var(--hair)",
  borderRadius: "calc(5px * var(--radius-scale))",
  padding: "calc(1px * var(--space)) calc(6px * var(--space))",
  whiteSpace: "nowrap",
};

// Amenity tag chips. `limit` (compact card) shows the first N + a "+N" overflow chip;
// omitted (expand modal) shows all.
function Amenities({ tags, prov, limit }: { tags?: string[]; prov?: FieldProv; limit?: number }) {
  if (!tags || tags.length === 0) return emDash;
  const shown = limit ? tags.slice(0, limit) : tags;
  const overflow = limit ? tags.length - shown.length : 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "calc(5px * var(--space))", flexWrap: "wrap" }}>
      {prov && <Dot confidence={prov.confidence} />}
      {shown.map((t) => (
        <span key={t} style={chipStyle}>
          {t}
        </span>
      ))}
      {overflow > 0 && <span style={{ ...chipStyle, color: "var(--ink-4)" }}>{`+${overflow}`}</span>}
    </span>
  );
}

const totalKeys = (h: Hotel) => (h.keys ?? 0) + (h.residences ?? 0);
const hasKeys = (h: Hotel) => h.keys != null || h.residences != null;

// Display sort (ADR-015): total keys descending; rows with no keys at all sort last.
function sortRows(hotels: Hotel[]): Hotel[] {
  return [...hotels].sort((a, b) => {
    const ak = hasKeys(a);
    const bk = hasKeys(b);
    if (ak !== bk) return ak ? -1 : 1;
    return totalKeys(b) - totalKeys(a);
  });
}

const prov = (h: Hotel, k: ProvKey) => h.prov?.[k];

// Columns: Hotel · Keys (hotel/res) · Brand · Operator · Amenities · Owner. Selection
// is shared (same `selected`/`onToggle` back both inline card and overlay). `compact`
// hides Operator and condenses the amenity chips (first 3 + "+N"); the expand modal
// shows every column full-width. `enriching` rows show a spinner badge.
function HotelTable({
  hotels,
  live,
  selected,
  onToggle,
  enriching,
  compact,
}: {
  hotels: Hotel[];
  live: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  enriching: Set<string>;
  compact: boolean;
}) {
  const rows = sortRows(hotels);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14.5 }}>
      <thead>
        <tr>
          {live && <th style={th}></th>}
          <th style={th}>Hotel</th>
          <th style={th}>
            Keys
            <span style={{ display: "block", fontSize: 9.5, color: "var(--ink-4)", letterSpacing: "0.06em" }}>
              hotel / res
            </span>
          </th>
          <th style={th}>Brand</th>
          {!compact && <th style={th}>Operator</th>}
          <th style={th}>Amenities</th>
          <th style={th}>Owner</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h: Hotel) => {
          const on = selected.has(h.id);
          const busy = enriching.has(h.id);
          return (
            <tr
              key={h.id}
              onClick={live ? () => onToggle(h.id) : undefined}
              style={{
                cursor: live ? "pointer" : "default",
                background: live && on ? "var(--accent-tint)" : undefined,
              }}
            >
              {live && (
                <td style={td}>
                  <Checkbox on={on} />
                </td>
              )}
              <td style={{ ...td, color: "var(--ink)", fontWeight: 500 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "calc(7px * var(--space))" }}>
                  {h.name}
                  {busy && <span className="kh-spin" title="enriching…" />}
                </span>
              </td>
              <td style={td}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "calc(4px * var(--space))" }}>
                  <Cell value={h.keys ?? null} prov={prov(h, "keys")} />
                  <span style={{ color: "var(--ink-4)" }}>/</span>
                  <Cell value={h.residences ?? null} prov={prov(h, "residences")} />
                </span>
              </td>
              <td style={td}>
                <Cell value={h.brand ?? null} prov={prov(h, "brand")} />
              </td>
              {!compact && (
                <td style={td}>
                  <Cell value={h.operator ?? null} prov={prov(h, "operator")} />
                </td>
              )}
              <td style={td}>
                <Amenities tags={h.amenityTags} prov={prov(h, "amenities")} limit={compact ? 3 : undefined} />
              </td>
              <td style={td}>
                {h.ownerName ? (
                  <Cell
                    value={h.ownerType ? `${h.ownerType} · ${h.ownerName}` : h.ownerName}
                    prov={prov(h, "owner")}
                  />
                ) : (
                  emDash
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ResultCard({
  artifact,
  live,
  selected,
  onToggle,
  enriching,
  onEnrich,
}: {
  artifact: Artifact;
  live: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  enriching: Set<string>;
  onEnrich: (ids: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Escape closes the overlay (only bound while open).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Extension point: switch on artifact.kind as new kinds are added.
  if (artifact.kind !== "hotel-results") return null;

  const selectedIds = artifact.hotels.filter((h) => selected.has(h.id)).map((h) => h.id);
  const selCount = selectedIds.length;
  const fillPct = Math.round(artifact.ownerFillRate * 100);

  return (
    <div
      style={{
        border: "1px solid var(--hair)",
        borderRadius: "calc(12px * var(--radius-scale))",
        overflow: "hidden",
        background: "var(--surface)",
        maxWidth: 1040,
        opacity: live ? 1 : 0.78,
      }}
    >
      <div
        style={{
          padding: "calc(11px * var(--space)) calc(14px * var(--space))",
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--hair)",
          display: "flex",
          alignItems: "center",
          gap: "calc(10px * var(--space))",
        }}
      >
        <span
          className="tight"
          style={{ fontSize: 15, fontWeight: 600, color: live ? "var(--ink)" : "var(--ink-3)" }}
        >
          {artifact.title}
        </span>
        {!live && (
          <span
            style={{
              ...mono,
              fontSize: 9.5,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink-4)",
              border: "1px solid var(--hair)",
              borderRadius: "var(--radius-pill)",
              padding: "calc(2px * var(--space)) calc(8px * var(--space))",
            }}
          >
            ▣ frozen
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ ...mono, display: "inline-flex", alignItems: "center", gap: "calc(6px * var(--space))" }}>
          owner-fill
          <span
            style={{
              width: 54,
              height: 5,
              borderRadius: "calc(3px * var(--radius-scale))",
              background: "var(--hair)",
              overflow: "hidden",
              display: "inline-block",
            }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                width: `${fillPct}%`,
                background: "var(--warn)",
              }}
            />
          </span>
          {fillPct}%
        </span>
      </div>

      <div className="scroll" style={{ maxHeight: 240, overflow: "auto" }}>
        <HotelTable hotels={artifact.hotels} live={live} selected={selected} onToggle={onToggle} enriching={enriching} compact />
      </div>

      <div
        style={{
          padding: "calc(10px * var(--space)) calc(14px * var(--space))",
          borderTop: "1px solid var(--hair)",
          display: "flex",
          alignItems: "center",
          gap: "calc(10px * var(--space))",
        }}
      >
        <span style={{ fontSize: 14, color: "var(--ink-2)" }}>
          {live ? (
            <>
              <b>{selCount}</b> selected
            </>
          ) : (
            <span style={{ color: "var(--ink-4)" }}>Frozen · {artifact.hotels.length} hotels</span>
          )}
        </span>
        <div style={{ flex: 1 }} />
        <Btn variant="outline" size="sm" onClick={() => setExpanded(true)}>
          Expand ⤢
        </Btn>
        {live && (
          <Btn variant="accent" size="sm" disabled={selCount === 0} onClick={() => onEnrich(selectedIds)}>
            Enrich
          </Btn>
        )}
      </div>

      {expanded && (
        <div
          onClick={() => setExpanded(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "color-mix(in oklch, var(--ink) 45%, transparent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "calc(24px * var(--space))",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(1100px, 94vw)",
              height: "86vh",
              display: "flex",
              flexDirection: "column",
              background: "var(--surface)",
              border: "1px solid var(--hair)",
              borderRadius: "calc(14px * var(--radius-scale))",
              overflow: "hidden",
              boxShadow: "0 24px 64px color-mix(in oklch, var(--ink) 30%, transparent)",
            }}
          >
            <div
              style={{
                padding: "calc(13px * var(--space)) calc(18px * var(--space))",
                background: "var(--surface-2)",
                borderBottom: "1px solid var(--hair)",
                display: "flex",
                alignItems: "center",
                gap: "calc(10px * var(--space))",
              }}
            >
              <span className="tight" style={{ fontSize: 16, fontWeight: 600 }}>
                {artifact.title}
              </span>
              <div style={{ flex: 1 }} />
              <Btn variant="ghost" size="sm" onClick={() => setExpanded(false)} title="Close (Esc)">
                Close ✕
              </Btn>
            </div>
            <div className="scroll" style={{ flex: 1, overflow: "auto" }}>
              <HotelTable
                hotels={artifact.hotels}
                live={live}
                selected={selected}
                onToggle={onToggle}
                enriching={enriching}
                compact={false}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
