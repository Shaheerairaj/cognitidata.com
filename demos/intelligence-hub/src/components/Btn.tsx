import type { ReactNode, CSSProperties } from "react";

type Variant = "primary" | "accent" | "outline" | "ghost" | "soft";
type Size = "sm" | "md";

const variants: Record<Variant, CSSProperties> = {
  primary: { background: "var(--ink)", color: "var(--on-ink)" },
  accent: { background: "var(--accent)", color: "var(--on-accent)" },
  outline: {
    background: "var(--surface)",
    color: "var(--ink)",
    border: "1px solid var(--hair)",
  },
  ghost: { background: "transparent", color: "var(--ink-2)" },
  soft: {
    background: "var(--surface-2)",
    color: "var(--ink)",
    border: "1px solid var(--hair)",
  },
};

export function Btn({
  children,
  variant = "ghost",
  onClick,
  disabled,
  style,
  icon,
  size = "md",
  type = "button",
  title,
}: {
  children?: ReactNode;
  variant?: Variant;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
  icon?: ReactNode;
  size?: Size;
  type?: "button" | "submit";
  title?: string;
}) {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "calc(6px * var(--space))",
    padding: size === "sm" ? "5px 10px" : "7px 12px",
    height: size === "sm" ? 28 : 32,
    borderRadius: "calc(6px * var(--radius-scale))",
    fontSize: 15,
    fontWeight: 500,
    transition: "background 0.12s, color 0.12s, border-color 0.12s",
    whiteSpace: "nowrap",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...base,
        ...variants[variant],
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}
