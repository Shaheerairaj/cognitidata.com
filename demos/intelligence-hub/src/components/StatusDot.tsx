// Shared status indicator used by ResearchPane and DraftingPane.
// The pulse keyframe lives here so it's injected once per mount site.
const STATUS_COLOR: Record<string, string> = {
  queued: "var(--ink-4)",
  running: "var(--accent)",
  done: "var(--ok)",
  error: "var(--danger)",
};

export const PULSE_KEYFRAMES = `
@keyframes pe-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.4); opacity: 0.6; }
}
`;

export function StatusDot({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "var(--ink-4)";
  const isRunning = status === "running";
  return (
    <div
      style={{
        width: 8,
        height: 8,
        borderRadius: "var(--radius-pill)",
        marginTop: "calc(4px * var(--space))",
        flexShrink: 0,
        background: status === "queued" ? "transparent" : color,
        border: status === "queued" ? `1.5px solid ${color}` : "none",
        animation: isRunning ? "pe-pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}
