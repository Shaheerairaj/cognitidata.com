import { distanceLabel, reviewPrompt, reviewReasonLabel, socialLabel, type ReviewDecision, type ReviewRow } from "../registry_review";
import { googleMapsUrl } from "../registry_search";

// The review table (ADR-083 Phase D / mock review-options.html option B): the banner opens this
// popup listing every held-back property that needs human validation — the reason it's flagged,
// the thin data we have, and the decision inline. Presentational: the parent owns the queue,
// the map fly-to (row click), and applying decisions. Rows leave as they're decided.
export function ReviewTable(props: {
  rows: ReviewRow[];
  market: string;
  onDecide: (row: ReviewRow, decision: ReviewDecision) => void;
  onFocusRow: (row: ReviewRow) => void;
  onClose: () => void;
}) {
  const { rows, market, onDecide, onFocusRow, onClose } = props;
  return (
    <div className="rv-scrim" onClick={onClose}>
      <div
        className="rv-modal"
        role="dialog"
        aria-label="properties awaiting review"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rv-modal-head">
          <div>
            <div className="rv-modal-title tight">Needs your review</div>
            <div className="rv-modal-sub">
              {rows.length} propert{rows.length === 1 ? "y" : "ies"} in {market} we weren’t sure about —
              decide each and it leaves the list.
            </div>
          </div>
          <button className="rv-modal-x" onClick={onClose} aria-label="close review table">✕</button>
        </div>
        <div className="rv-table-scroll">
          <table className="rv-table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Why it’s here</th>
                <th>What we know</th>
                <th className="rv-th-decide">Your call</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const { choices } = reviewPrompt(r, market);
                const facts = [
                  r.brand,
                  r.category && r.category !== "hotel" ? r.category : null,
                  r.address || r.locality,
                  r.phone,
                ].filter(Boolean).join(" · ");
                const socials = r.socials ?? [];
                const cand = r.candidate;
                const hasLinks = Boolean(r.website) || socials.length > 0;
                return (
                  <tr key={r.id}>
                    <td>
                      <button className="rv-name" onClick={() => onFocusRow(r)} title="Show on map">
                        {r.name}
                      </button>
                    </td>
                    <td>
                      <span className="rv-flag">{reviewReasonLabel(r.reason)}</span>
                      {r.detail ? <span className="rv-detail"> · {r.detail}</span> : null}
                    </td>
                    <td className="rv-known">
                      {facts ? <div className="rv-facts">{facts}</div> : null}
                      {hasLinks || r.lat ? (
                        <div className="rv-links">
                          {r.website ? (
                            <a href={r.website} target="_blank" rel="noreferrer">Website ↗</a>
                          ) : null}
                          {socials.map((s) => (
                            <a key={s} href={s} target="_blank" rel="noreferrer">{socialLabel(s)} ↗</a>
                          ))}
                          <a href={googleMapsUrl(r.lat, r.lng, r.name, r.locality)} target="_blank" rel="noreferrer">Maps ↗</a>
                        </div>
                      ) : null}
                      {/* duplicate: the row it may merge into, how far apart, and a link to compare */}
                      {cand ? (
                        <div className="rv-vs">
                          Likely the same as <b>{cand.name}</b>
                          <span className="rv-dist"> · {distanceLabel(r.lat, r.lng, cand.lat, cand.lng)}</span>
                          {cand.locality ? <span> · {cand.locality}</span> : null}
                          <span className="rv-links">
                            {cand.website ? (
                              <a href={cand.website} target="_blank" rel="noreferrer">its site ↗</a>
                            ) : null}
                            <a href={googleMapsUrl(cand.lat, cand.lng, cand.name, cand.locality)} target="_blank" rel="noreferrer">its map ↗</a>
                          </span>
                        </div>
                      ) : null}
                      {!facts && !hasLinks && !cand ? <span className="rv-empty">— no details on file</span> : null}
                    </td>
                    <td className="rv-decide">
                      {choices.map((c) => (
                        <button
                          key={c.decision}
                          className={`rv-choice${c.primary ? " primary" : ""}`}
                          onClick={() => onDecide(r, c.decision)}
                        >
                          {c.label}
                        </button>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
