import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  // Prose inherits font-size/color from the container (e.g. the rail's `.atext` at 13px), so the
  // same component looks right wherever it's mounted; only structure (margins, hierarchy) is set
  // here. `:first-child`/`:last-child` margin trims live in the wrapper's CSS below.
  p: ({ children }) => (
    <p style={{ margin: "0 0 0.7em", fontSize: "inherit", lineHeight: 1.55, color: "inherit" }}>
      {children}
    </p>
  ),
  h2: ({ children }) => (
    <h2 style={{ margin: "1em 0 0.35em", fontSize: "1.15em", fontWeight: 600, color: "var(--ink)", lineHeight: 1.35 }}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ margin: "0.85em 0 0.3em", fontSize: "1.05em", fontWeight: 600, color: "var(--ink)", lineHeight: 1.35 }}>
      {children}
    </h3>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: "0.4em 0 0.7em", paddingLeft: "calc(18px * var(--space))", fontSize: "inherit", lineHeight: 1.55, color: "inherit" }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "0.4em 0 0.7em", paddingLeft: "calc(18px * var(--space))", fontSize: "inherit", lineHeight: 1.55, color: "inherit" }}>
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li style={{ marginBottom: "0.2em" }}>{children}</li>
  ),
  strong: ({ children }) => (
    <strong style={{ fontWeight: 600, color: "var(--ink)" }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em style={{ fontStyle: "italic" }}>{children}</em>
  ),
  code: ({ children, className }) => {
    const isBlock = !!className;
    if (isBlock) {
      return (
        <pre
          className="code"
          style={{
            margin: "0.6em 0",
            padding: "calc(10px * var(--space)) calc(14px * var(--space))",
            background: "var(--surface-2)",
            border: "1px solid var(--hair)",
            borderRadius: "calc(6px * var(--radius-scale))",
            fontSize: "0.9em",
            lineHeight: 1.5,
            overflowX: "auto",
            color: "var(--ink-2)",
          }}
        >
          <code>{children}</code>
        </pre>
      );
    }
    return (
      <code
        className="code"
        style={{
          padding: "calc(1px * var(--space)) calc(5px * var(--space))",
          background: "var(--surface-2)",
          border: "1px solid var(--hair)",
          borderRadius: "calc(3px * var(--radius-scale))",
          fontSize: "0.9em",
          color: "var(--ink-2)",
        }}
      >
        {children}
      </code>
    );
  },
  a: ({ children, href }) => (
    <a
      href={href}
      style={{ textDecoration: "underline", color: "var(--accent-ink)" }}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: "0.6em 0",
        paddingLeft: "calc(12px * var(--space))",
        borderLeft: "3px solid var(--hair)",
        color: "var(--ink-3)",
        fontStyle: "italic",
      }}
    >
      {children}
    </blockquote>
  ),
  hr: () => (
    <hr style={{ border: "none", borderTop: "1px solid var(--hair)", margin: "1em 0" }} />
  ),
  table: ({ children }) => (
    <div style={{ overflowX: "auto", margin: "0.6em 0" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: "0.95em",
          width: "100%",
          color: "var(--ink-2)",
        }}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th
      style={{
        padding: "calc(6px * var(--space)) calc(10px * var(--space))",
        borderBottom: "2px solid var(--hair)",
        textAlign: "left",
        fontWeight: 600,
        color: "var(--ink)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      style={{
        padding: "calc(5px * var(--space)) calc(10px * var(--space))",
        borderBottom: "1px solid var(--hair-2)",
      }}
    >
      {children}
    </td>
  ),
};

export function Markdown({ body }: { body: string }) {
  return (
    <div className="md" style={{ minWidth: 0 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
