import type { Config } from "tailwindcss";

// Design tokens (colours + fonts) live as CSS variables in public/theme.css — the one
// file to swap. Tailwind references them via var() / arbitrary values (`bg-[var(--surface)]`).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Preflight's default border colour, pointed at the theme instead of Tailwind grey.
      borderColor: { DEFAULT: "var(--hair)" },
      fontFamily: {
        sans: ["var(--body)"],
        tight: ["var(--sans)"],
        mono: ["var(--mono)"],
      },
    },
  },
  plugins: [],
} satisfies Config;
