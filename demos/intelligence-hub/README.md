# Cognitidata — Hospitality Intelligence (demo)

A self-contained, browser-only demo of the Intelligence Hub. No server, no API keys, no paid
calls: every `/api/*` request is answered in the browser from bundled data.

## Run

```
npm ci
npm run dev        # local, http://localhost:5173
npm run build      # static site in dist/ — host on any static host (Netlify, Vercel, S3, Render static)
npm test           # fake-backend tests
node .verify/verify.mjs   # after a build: drives the app in headless Chromium, screenshots to .verify/
```

## What's inside

- The app's UI, unchanged apart from branding, a **Reset demo** button and chat suggestions.
- `src/demo/` — the in-browser fake backend (`server.ts`, `store.ts`, `ports.ts`) and its data.
- `src/demo/data/` — four markets: **Abu Dhabi, Casablanca, Trieste, Lecce** (878 hotels, their
  registry places, owner research, contacts, reviews, outreach drafts and settings). Emails and
  phone numbers are masked.
- `public/teaser.pdf` (placeholder teaser), `public/sample-leads.csv` (for **Add leads**).

## How the "AI" parts behave

- **Search** works for the four markets; elsewhere it says what the demo covers.
- **Enrichment** (owner, contacts, reviews) replays stored research at a live-looking pace.
- **Outreach** shows stored drafts; export gives an Outlook `.eml` (several → a `.zip`).
- **Chat** answers a fixed set of questions (shown as suggestions); anything else gets a demo reply.
- Changes a viewer makes are kept in their browser until **Reset demo**.

## Theming

Every design decision lives in one file: `public/theme.css`. That covers colours, fonts, the
map style, the teaser PDF, corner rounding, spacing, animation and the Agency page's drawing.
It applies to the app, the map and both architecture pages.

- To re-theme, edit the values in `public/theme.css`, or replace it with your own file. After a
  build you can swap `dist/theme.css` directly — no rebuild needed.
- Keep every token name (`--accent`, `--ink`, `--sans`, `--map-style`, …); change only the values.
  The comments in the file say what each one is for.
- Fonts: put the files in `public/fonts/` and add `@font-face` rules for them at the top of
  `theme.css` (web fonts can be `@import`ed there too), then name them in `--sans`, `--body`,
  `--label`, `--mono`.
- `.verify/probe-theme.css` is a loud example theme (purple, mint, serif). Copy it over
  `dist/theme.css` to see the whole demo re-theme.
- Dials: `--space` (all padding and gaps), `--radius-scale` (corners; 0 = square) and `--motion`
  (animation length; 0 = off) scale every value at once. 1 keeps the design as built.
- `--teaser-pdf` names the PDF in `public/` attached to every email.
- The Agency drawing colours are the `--ill-*` block at the bottom of the file.

## Note

The product font (Futura PT, `public/fonts/`) is a licensed typeface — swap it before handing
this copy to a third party.
