import type { ReactNode } from "react";

// The assistant as a collapsible left rail (mock: moment4-layout-model.html).
// Open → header + the conversation thread + a pinned chatbox footer; collapsed → a 44px
// labelled strip that summons it back (history intact). A pending-answer badge shows on the strip.
export function AssistantRail(props: {
  open: boolean;
  onToggle: () => void;
  badge?: number;
  children: ReactNode;
  footer?: ReactNode; // the chatbox — pinned below the scrolling thread
}) {
  const { open, onToggle, badge = 0, children, footer } = props;
  return (
    <aside className={`mf-rail${open ? "" : " collapsed"}`} data-testid="assistant-rail">
      {open ? (
        <>
          <div className="mf-rail-head">
            <b className="tight">Assistant</b>
            <button
              className="mf-rail-fold btn ghost sm"
              aria-label="Collapse assistant"
              onClick={onToggle}
            >
              «
            </button>
          </div>
          <div className="mf-rail-body">{children}</div>
          {footer && <div className="mf-rail-foot">{footer}</div>}
        </>
      ) : (
        <button className="mf-rail-strip" aria-label="Expand assistant" onClick={onToggle}>
          <span className="mf-rail-strip-label">Assistant</span>
          {badge > 0 && <span className="mf-rail-strip-badge">{badge}</span>}
        </button>
      )}
    </aside>
  );
}
