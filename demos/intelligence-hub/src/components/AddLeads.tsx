import { useRef, useState } from "react";
import { apiUrl, withSession } from "../api";
import {
  buildCommitPayload,
  commitCounts,
  defaultResolution,
  templateCsv,
  type CommitResponse,
  type ParseResponse,
  type ParsedLead,
  type Resolution,
} from "../leads";

// AddLeads slide-over (ADR-046, FE phase) — three stages: capture (drop a file / paste / type) →
// preview-gate (review classified rows, resolve ambiguous, skip) → done. parse is read-only; commit
// writes user-verified rows and the existing auto-enrich pass fills the blanks. Wire contract:
// docs/superpowers/specs/2026-06-28-manual-lead-ingestion-design.md.

type Stage = "capture" | "preview" | "done";

const BADGE: Record<ParsedLead["classification"], { label: string; cls: string }> = {
  new: { label: "New", cls: "b-new" },
  known: { label: "Duplicate", cls: "b-dup" },
  ambiguous: { label: "Ambiguous", cls: "b-amb" },
};

function downloadTemplate() {
  const blob = new Blob([templateCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "kh-leads-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function AddLeads(props: {
  market: { city: string | null; country: string | null } | null;
  onClose: () => void;
  onCommitted: (res: CommitResponse) => void;
}) {
  const { market, onClose, onCommitted } = props;
  const marketName = market?.city ?? null;

  const [stage, setStage] = useState<Stage>("capture");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [addedBy, setAddedBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [committed, setCommitted] = useState<CommitResponse | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const effective = (lead: ParsedLead): Resolution => resolutions[lead.tempId] ?? defaultResolution(lead);
  const setRes = (id: string, r: Resolution) => setResolutions((m) => ({ ...m, [id]: r }));

  const parse = async () => {
    setError(null);
    if (!text.trim() && !file) {
      setError("Drop a file or paste/type at least one hotel.");
      return;
    }
    if (!addedBy.trim()) {
      setError("Add your name so the entries are attributed.");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("addedBy", addedBy.trim());
      if (text.trim()) fd.append("text", text);
      if (file) fd.append("file", file);
      if (marketName) fd.append("market", marketName);
      const res = await fetch(apiUrl("/api/leads/parse"), {
        method: "POST",
        headers: withSession(),
        body: fd,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(detail?.detail ?? `Parse failed (${res.status}).`);
        return;
      }
      const data: ParseResponse = await res.json();
      if (data.leads.length === 0) {
        setError("Couldn't pull any hotels from that. Try the template, or be more explicit.");
        return;
      }
      setParsed(data);
      setResolutions({});
      setStage("preview");
    } catch (e) {
      setError(`Could not reach the backend (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!parsed) return;
    setError(null);
    setBusy(true);
    try {
      const payload = buildCommitPayload(addedBy.trim(), parsed.leads, resolutions);
      const res = await fetch(apiUrl("/api/leads/commit"), {
        method: "POST",
        headers: withSession({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(detail?.detail ?? `Commit failed (${res.status}).`);
        return;
      }
      const data: CommitResponse = await res.json();
      setCommitted(data);
      onCommitted(data);
      setStage("done");
    } catch (e) {
      setError(`Could not reach the backend (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStage("capture");
    setText("");
    setFile(null);
    setParsed(null);
    setResolutions({});
    setCommitted(null);
    setError(null);
  };

  const counts = parsed ? commitCounts(parsed.leads, resolutions) : { insert: 0, merge: 0, skip: 0 };
  const ctxLabel = marketName ? <>into <b>{marketName}</b></> : "to the database";

  return (
    <>
      <div className="al-head">
        <div className="al-title tight">Add leads</div>
        <span className="al-ctx">{ctxLabel}</span>
        <button className="x" onClick={onClose} aria-label="close">✕</button>
      </div>

      {/* ── capture ── */}
      {stage === "capture" && (
        <div className="al-body">
          <p className="al-lede">
            Drop a spreadsheet, paste a list or some notes, or just type a hotel. I'll structure it
            into rows{marketName ? <>, check each against <b>{marketName}</b>,</> : ","} and show you
            what's new before anything is saved.
          </p>

          <div className="al-drop">
            <div className="al-drop-top">
              <label className="al-file">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,.txt"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                Choose a file
              </label>
              {file && (
                <span className="al-chip mono">
                  {file.name}
                  <button className="x2" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ""; }} aria-label="remove file">✕</button>
                </span>
              )}
              <span className="spacer2" />
              <button className="al-tmpl" onClick={downloadTemplate}>Download CSV template</button>
            </div>
            <textarea
              className="al-ta"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="…or paste a table, a list of hotel names, or loose notes — one hotel per line."
            />
          </div>

          <details className="al-help">
            <summary>Column guide</summary>
            <ul>
              <li><b>name</b> — required.</li>
              <li><b>brand</b> / <b>affiliation</b> — operator/brand and its affiliation. <b>website</b> — a URL.</li>
              <li><b>key_count</b> — a whole number (rooms/keys).</li>
              <li><b>owner_linkedin</b> — a profile URL. <b>notes</b> — free text.</li>
              <li>Any other columns you add are kept, not dropped.</li>
            </ul>
          </details>

          <div className="al-controls">
            <label className="al-who">
              Added by
              <input value={addedBy} onChange={(e) => setAddedBy(e.target.value)} placeholder="your name" />
            </label>
            <span className="spacer2" />
            <button className="btn ghost sm" onClick={() => setText("")} disabled={!text}>Clear</button>
            <button className="btn accent sm" onClick={parse} disabled={busy}>
              {busy ? <><span className="spin" /> Parsing…</> : "Parse leads"}
            </button>
          </div>

          {error && <div className="al-err">⚠ {error}</div>}

          <div className="al-formats">
            <div className="al-fmt"><span className="b">📄</span><div><div className="ft">Clean CSV</div><div className="fd">Template columns auto-mapped — uncapped.</div></div></div>
            <div className="al-fmt"><span className="b">✎</span><div><div className="ft">Loose text or notes</div><div className="fd">Hotels &amp; owners pulled from prose (≤100 rows).</div></div></div>
            <div className="al-fmt"><span className="b">＋</span><div><div className="ft">One at a time</div><div className="fd">Type a name &amp; city — auto-enrich fills the rest.</div></div></div>
          </div>
        </div>
      )}

      {/* ── preview ── */}
      {stage === "preview" && parsed && (
        <>
          <div className="al-body">
            <button className="al-back" onClick={() => setStage("capture")}>Edit input</button>
            <div className="al-pv-title tight">Review {parsed.leads.length} parsed {parsed.leads.length === 1 ? "lead" : "leads"}</div>
            <div className="al-pv-sub">
              {parsed.mode === "template" && "Columns auto-mapped from your template. "}
              {parsed.mode === "llm" && "Parsed with AI from your input. "}
              {parsed.mode === "llm-fallback" && "Headers didn't match the template — parsed with AI. "}
              Nothing is saved until you confirm.
            </div>
            {parsed.truncated && (
              <div className="al-err warn">⚠ Capped at 100 rows — {parsed.dropped ?? 0} dropped. Use the template for larger sets (uncapped).</div>
            )}

            <div className="al-summary">
              <span className="al-pill"><span className="dot b-new" /><b>{parsed.summary.new}</b> new</span>
              <span className="al-pill"><span className="dot b-dup" /><b>{parsed.summary.known}</b> duplicate</span>
              <span className="al-pill"><span className="dot b-amb" /><b>{parsed.summary.ambiguous}</b> ambiguous</span>
            </div>

            <div className="al-tablewrap">
              <table className="al-ptable">
                <thead>
                  <tr><th>Status</th><th>Name</th><th>Keys</th><th>Segment</th><th>Owner</th><th>Resolve</th></tr>
                </thead>
                <tbody>
                  {parsed.leads.map((l) => {
                    const eff = effective(l);
                    const badge = BADGE[l.classification];
                    const nameFixed = l.normalizations.find((n) => n.field === "name");
                    return (
                      <tr key={l.tempId} className={eff === "skip" ? "skipped" : ""}>
                        <td>
                          <span className={`al-badge ${badge.cls}`}>● {badge.label}</span>
                          {l.match && (
                            <div className="al-match">
                              {l.classification === "ambiguous" ? `≈ ${l.match.score.toFixed(2)} to ` : "↳ "}
                              {l.match.name}
                            </div>
                          )}
                        </td>
                        <td>
                          <span className="al-nm">{l.name}</span>
                          {nameFixed && <span className="al-fixed mono" title={`normalized from "${nameFixed.from}"`}>·fixed</span>}
                          {l.cellErrors && l.cellErrors.length > 0 && (
                            <div className="al-cellerr">⚠ {l.cellErrors.map((c) => c.column).join(", ")} skipped — bad value</div>
                          )}
                        </td>
                        <td>{l.fields.key_count ?? <span className="muted">—</span>}</td>
                        <td>{l.fields.segment ?? <span className="muted">—</span>}</td>
                        <td>{l.fields.owner_name ?? <span className="muted">—</span>}</td>
                        <td>
                          {eff === "skip" ? (
                            <button className="al-undo" onClick={() => setRes(l.tempId, defaultResolution(l))}>skipped · undo</button>
                          ) : (
                            <div className="al-resolve">
                              {l.classification === "ambiguous" && l.match ? (
                                <span className="al-actions">
                                  <button className={eff === "insert" ? "on" : ""} onClick={() => setRes(l.tempId, "insert")}>Create new</button>
                                  <button className={eff === "merge" ? "on" : ""} onClick={() => setRes(l.tempId, "merge")}>Merge</button>
                                </span>
                              ) : (
                                <span className={`al-act mono ${eff === "merge" ? "merge" : ""}`}>{eff === "merge" ? "merge existing" : "insert"}</span>
                              )}
                              <button className="al-skip" onClick={() => setRes(l.tempId, "skip")} aria-label="skip row">skip</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {error && <div className="al-err">⚠ {error}</div>}
          </div>

          <div className="al-foot">
            <div className="al-ct">
              Adding <b>{counts.insert} new</b>{counts.merge > 0 && <> + merging <b>{counts.merge}</b></>}
              {counts.skip > 0 && <> · {counts.skip} skipped</>}
              <span className="al-prov mono"> · user-entry · verified · {addedBy.trim()}</span>
            </div>
            <span className="spacer2" />
            <button className="btn accent sm" onClick={commit} disabled={busy || counts.insert + counts.merge === 0}>
              {busy ? <><span className="spin" /> Saving…</> : `Add ${counts.insert + counts.merge} leads ✓`}
            </button>
          </div>
        </>
      )}

      {/* ── done ── */}
      {stage === "done" && committed && (
        <div className="al-body">
          <div className="al-done">
            <div className="al-ck">✓</div>
            <div className="al-pv-title tight">
              {committed.inserted + committed.merged} {committed.inserted + committed.merged === 1 ? "lead" : "leads"} added{marketName ? ` to ${marketName}` : ""}
            </div>
            <p className="al-lede" style={{ maxWidth: 380, margin: "calc(10px * var(--space)) auto calc(22px * var(--space))" }}>
              {committed.inserted} new inserted, {committed.merged} merged. They're in the live set now —
              blanks (keys, owners, contacts) fill via auto-enrich.
            </p>
            <button className="btn accent sm" onClick={reset}>＋ Add more</button>
          </div>
        </div>
      )}
    </>
  );
}
