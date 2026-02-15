# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server at localhost:4321
npm run build        # Build production site to ./dist/
npm run preview      # Preview production build locally
npm run check        # Run all checks (type-check + lint + format:check)
npm run type-check   # TypeScript validation via astro check
npm run lint         # ESLint for .js,.jsx,.ts,.tsx,.astro files
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier format all files
npm run format:check # Prettier check formatting
```

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
