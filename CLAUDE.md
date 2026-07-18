# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

This is the Cognitidata website — an Astro static site using file-based routing with React for interactive components.

**Tech Stack:** Astro 5, React 19, Tailwind CSS 4, Framer Motion, TypeScript (strict)

**Key Directories:**
- `src/pages/` - Routes: index, services, portfolio, about, contact
- `src/components/` - Astro components (.astro) and React components (.tsx)
- `src/layouts/Layout.astro` - Base layout with SEO meta tags
- `src/config/site.mjs` - Global site config (title, URL, Web3Forms key)

**Styling:** Tailwind CSS is the primary styling method. Sass is available for component-scoped styles using `<style lang="scss">`.

**Icons:** astro-icon (`<Icon name="tabler:icon-name" />`) is available but unused — the design brief calls for numbered labels (01, 02, 03) instead of icons everywhere. Don't introduce icons without checking the brief first.

**Animations:** `ScrollReveal.tsx` wraps content for scroll-triggered animations. Requires `client:load` or `client:idle` directive.

**Forms:** Contact form uses Web3Forms. Configure access key in `src/config/site.mjs`.

## **COGNITIDATA — DESIGN BRIEF**

Full source of truth: `brand/brand-guidelines.html` (v1.0). This section is a condensed reference — check the source doc for anything not covered here.

**Aesthetic:** "Ink discipline, one accent." Confident minimalism — whitespace still does most of the work, but typography is bolder than the original editorial-luxury look. One neutral system (ink on paper), one signal color, used the same way everywhere it appears.

**Fonts:** Montserrat only — Cormorant Garamond and Outfit are both retired. Weight carries every role, never lighter than 500:
- 700 — headlines (h1/h2, hero/section titles)
- 700 italic, accent color — the one emphasized word per headline
- 600 — subheads/labels: card titles (h3–h6), eyebrows, buttons, nav
- 500 — body copy (never lighter, reads too thin below this)
- 800 — logo wordmark only

**Colours:**
```
Page background:  #FAFAF9   (never pure white/black)
Surface/cards:    #FFFFFF
Text primary:     #111111   (ink — headlines, logo)
Text body:        #444444   (paragraph copy)
Text hint/muted:  #999999   (eyebrows, nav, muted labels — one grey tier, not two)
Borders:          #DCDCDC
Accent — Frost Deep: #3F6C7A   (emphasis words, buttons, links, one full-color moment on closing CTAs)
Accent — Frost Soft: #7FA8B5   (numbered labels only — 01, 02, 03)
Button text:       #F0F0F0
```
The accent is a signal, not decoration: emphasis words, buttons/links, and index numbers — three touchpoints, nothing more. Never a second accent color, never as a border-left strip, never coloring the logo (except "AI" in the tagline).

**Typography rules:**
- Headlines: large, tight line-height, slight negative letter-spacing
- Eyebrow labels: uppercase, wide letter-spacing, hint colour
- Numbers (01, 02, 03) replace icons everywhere — Frost Soft accent

**Layout:**
- Max content width: 1080px centred
- Max text/prose width: 640px
- Sections need generous vertical padding
- Nav: bottom border (`#DCDCDC`) only, no background change on scroll
- Hero: left-aligned always, never centred
- Feature columns: separated by 1px border lines only, no card backgrounds, no gaps

**Buttons:**
- Primary: Frost Deep (`#3F6C7A`) bg, `#F0F0F0` text, small border-radius (4px)
- Ghost: no background, no border, muted text colour
- No pills, no gradients, no shadows

**Strictly avoid:**
- A second accent color, or filling large areas with the accent outside end cards/closing CTAs
- Gradients, shadows, textures
- Large border-radius (keep corners subtle)
- Centred hero text
- All-caps headlines (eyebrows only)
- Icons (use numbered labels instead)
- Serif or monospace type anywhere, including code
- Pure black/white backgrounds
- Heavy or prolonged animations

**Reference:** `brand/brand-guidelines.html` — treat it as the living doc; update there first, then propagate here and to the site.