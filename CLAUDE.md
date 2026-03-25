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

**Icons:** Use `<Icon name="tabler:icon-name" />` from astro-icon. Browse icons at tabler.io/icons.

**Animations:** `ScrollReveal.tsx` wraps content for scroll-triggered animations. Requires `client:load` or `client:idle` directive.

**Forms:** Contact form uses Web3Forms. Configure access key in `src/config/site.mjs`.

## **COGNITIDATA — DESIGN BRIEF**

**Aesthetic:** Editorial minimalism. Quiet confidence. No visual tricks. Whitespace is the primary design element. Closer to a luxury consultancy than a tech startup.

**Fonts:** Import from Google Fonts.
- Headlines: Cormorant Garamond, light weight only, italic for emphasis — never bold
- Body/UI: Outfit, light weight for body, regular for labels/nav, medium for buttons only
- Logo: Outfit, light weight, uppercase, wide letter-spacing

**Colours — strictly monochrome, no accent colours:**
```
Page background:  #F0F0F0
Surface/cards:    #FFFFFF
Text primary:     #111111
Text body:        #777777
Text muted:       #999999
Text hint:        #AAAAAA
Borders:          #DCDCDC
Button bg:        #111111
Button text:      #F0F0F0
```

**Typography rules:**
- Headlines: large, tight line-height, slight negative letter-spacing — use Cormorant Garamond light
- Eyebrow labels: Outfit regular, small, uppercase, wide letter-spacing, hint colour (`#AAAAAA`)
- Body: comfortable reading size, generous line-height
- Feature/card titles: Cormorant Garamond light, mid-size
- Numbers (01, 02, 03) replace icons everywhere

**Layout:**
- Max content width: 1080px centred
- Max text/prose width: 640px
- Sections need generous vertical padding
- Nav: bottom border (`#DCDCDC`) only, no background change on scroll
- Hero: left-aligned always, never centred
- Feature columns: separated by 1px border lines only, no card backgrounds, no gaps

**Buttons:**
- Primary: `#111111` bg, `#F0F0F0` text, small border-radius, Outfit medium
- Ghost: no background, no border, muted text colour
- No pills, no gradients, no shadows

**Strictly avoid:**
- Any accent or brand colour
- Gradients, shadows, textures
- Large border-radius (keep corners subtle)
- Heavy font weights
- Centred hero text
- All-caps headlines (eyebrows only)
- Icons (use numbered labels instead)
- Coloured section backgrounds
- Heavy or prolonged animations

**Reference:** High-end architecture studio websites.