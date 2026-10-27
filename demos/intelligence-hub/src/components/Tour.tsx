// Layer-1 guided tour (ADR-090 / spec 2026-07-19-workbench-onboarding-help-design.md).
// A hand-rolled coach-mark overlay: dimmed backdrop, a spotlight over the current target, and a
// step card. Presentational only — the trigger policy (auto-play on every new market, the mute
// flag, ? replay) lives in Workbench. Steps anchor to real elements by selector; a step whose
// target is absent (e.g. the review band when there's nothing to review) is skipped, not fatal.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type Pos = "center" | "below" | "above" | "rightof";
type Step = { title: string; body: string; selector: string; pos: Pos };

// Ordered by the work funnel: orient → understand → explore & narrow → clean & inspect →
// qualify → act → manage → move on. Mirrors mocks/onboarding-help.html.
export const TOUR_STEPS: Step[] = [
  { title: "This is your workbench", body: "The map, the list, and the assistant are three views of one set of hotels, and you'll spend most of your time here.", selector: ".mf-work", pos: "center" },
  { title: "Your live set", body: "This line shows what matched, what your filters hid, and per-kind “to enrich” chips — click one to see only the rows where that enrichment hasn't run yet.", selector: "[data-tour='breakdown']", pos: "below" },
  { title: "Ask the assistant", body: "Ask in plain English to filter, sort, or triage the list. It changes the grid on the right.", selector: "[data-testid='assistant-rail']", pos: "rightof" },
  { title: "Filter and find", body: "Narrow the list with per-column filters (a keys range, class, owner category, and so on), or use “Filter rows…” for a quick text search across everything. The assistant can do all of this for you too.", selector: ".tbl-filterbtn", pos: "above" },
  { title: "Resize map ⇄ list", body: "Drag this grip (or press ↑/↓) to snap between map, balanced, and list views.", selector: ".mf-divider", pos: "below" },
  { title: "Hotels that need your call", body: "Below the list sits a band of properties we weren't sure about: likely duplicates, closed, or not lodging (◌ on the map). Decide each one and it leaves the list.", selector: ".mf-reviewline", pos: "above" },
  { title: "Open a dossier", body: "Click a hotel's name to open its full dossier. Most fields there are click-to-edit.", selector: ".namelink", pos: "below" },
  { title: "Enrich fills in the blanks", body: "The basics (keys, class, guest rating) fill in on their own. Owner & contact research (the owner, the people of interest, their channels via the web and Apollo) and reviews & rates don't: select rows and run Enrich to pull those (paid data). Until you do, filters and the assistant can't see them.", selector: "[data-tour='enrich']", pos: "above" },
  { title: "Outreach", body: "Once leads have an owner and contacts, Outreach drafts a personalized email plus teaser. Nothing is ever sent automatically.", selector: "[data-tour='outreach']", pos: "above" },
  { title: "Outreach settings", body: "Tune how outreach is written here: your right to win, the copy agent, and the teaser PDF sent with every email. Nothing is ever sent automatically.", selector: ".gearbtn", pos: "below" },
  { title: "Add your own leads", body: "Already have hotels in mind? Add leads lets you paste or upload your own and drop them straight into this market.", selector: "[data-tour='addleads']", pos: "below" },
  { title: "Export to CSV", body: "Download every hotel in this market as a template-format CSV — it rounds back through Add leads.", selector: "[data-tour='export']", pos: "below" },
  { title: "Find another market", body: "Search a market takes you back to the map view to look for a new market.", selector: "[data-tour='search']", pos: "below" },
];

const PAD = 6;
export const CARD_W = 268;
const GAP = 16; // gap between the target and the card

// Place the step card near the target, on the requested side, clamped to the viewport and
// flipped to the opposite side when the requested one has no room — so the card never lands on
// top of the element it's describing. `cardH` is the card's real measured height.
export function placeCard(
  rect: DOMRect | null,
  pos: Pos,
  cardH: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  const clampL = (l: number) => Math.max(10, Math.min(l, vw - CARD_W - 10));
  const clampT = (t: number) => Math.max(10, Math.min(t, vh - cardH - 10));
  if (!rect || pos === "center") return { left: clampL((vw - CARD_W) / 2), top: clampT((vh - cardH) / 2) };

  if (pos === "rightof") return { left: clampL(rect.right + GAP), top: clampT(rect.top) };

  // Vertical placement: honour the requested side, but flip if it would overflow the viewport
  // (which would force the clamp to drag the card back over the target).
  const roomBelow = rect.bottom + GAP + cardH <= vh - 10;
  const roomAbove = rect.top - GAP - cardH >= 10;
  const below = pos === "below" ? roomBelow || !roomAbove : !roomAbove && roomBelow;
  const top = below ? rect.bottom + GAP : rect.top - cardH - GAP;
  return { left: clampL(rect.left), top: clampT(top) };
}

// First step at or after `from` whose target element is currently in the DOM (walking `dir`).
function present(from: number, dir: 1 | -1): number | null {
  for (let k = from; k >= 0 && k < TOUR_STEPS.length; k += dir) {
    if (document.querySelector(TOUR_STEPS[k].selector)) return k;
  }
  return null;
}

export function Tour({
  open,
  onClose,
  onMute,
}: {
  open: boolean;
  onClose: () => void;
  onMute: () => void;
}) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(180);

  // On open, land on the first present step (skip any missing leading targets).
  useEffect(() => {
    if (!open) return;
    setI(present(0, 1) ?? 0);
  }, [open]);

  const next = useCallback(() => {
    const n = present(i + 1, 1);
    if (n === null) onClose(); // past the last present step → Done
    else setI(n);
  }, [i, onClose]);
  const back = useCallback(() => {
    const p = present(i - 1, -1);
    if (p !== null) setI(p);
  }, [i]);

  // Measure the current target (best-effort; jsdom returns zeros, which is harmless).
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = document.querySelector(TOUR_STEPS[i]?.selector ?? "");
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, i]);

  // Measure the card's real height so placement can sit it clear of the target (body copy
  // varies, so a fixed height would over/undershoot). Only set on change to avoid a re-render loop.
  useLayoutEffect(() => {
    if (!open) return;
    const h = cardRef.current?.offsetHeight;
    if (h && h !== cardH) setCardH(h);
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, back, onClose]);

  if (!open) return null;
  const step = TOUR_STEPS[i];
  const last = present(i + 1, 1) === null;

  const spot = rect
    ? { left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : null;

  // Card placement relative to the target rect, using the card's measured height (see placeCard).
  const card = placeCard(rect, step.pos, cardH, window.innerWidth || 1024, window.innerHeight || 768);

  return (
    <div className="wb-tour" data-testid="tour" role="dialog" aria-modal="true" aria-label="workbench tour">
      <div className="wb-tour-scrim" onClick={onClose} aria-label="skip tour" />
      {spot && (
        <div
          className="wb-tour-spot"
          style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height }}
        />
      )}
      <div ref={cardRef} className="wb-tour-card" style={{ left: card.left, top: card.top, width: CARD_W }}>
        <div className="wb-tour-kicker">Step {i + 1} of {TOUR_STEPS.length}</div>
        <h4>{step.title}</h4>
        <p>{step.body}</p>
        <div className="wb-tour-nav">
          <div className="wb-tour-dots">
            {TOUR_STEPS.map((_, k) => (
              <i key={k} className={k === i ? "on" : ""} />
            ))}
          </div>
          <button className="wb-tour-skip" onClick={onClose}>Skip</button>
          {i > (present(0, 1) ?? 0) && (
            <button className="wb-tour-nav-btn" onClick={back}>Back</button>
          )}
          <button className="wb-tour-nav-btn pri" onClick={next}>{last ? "Done" : "Next"}</button>
        </div>
        <label className="wb-tour-mute">
          <input type="checkbox" onChange={(e) => { if (e.target.checked) onMute(); }} />
          Don't show this on new markets
        </label>
      </div>
    </div>
  );
}
