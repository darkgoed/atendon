---
version: alpha
name: AtendON Operate
description: Dense operational console with a petrol action signal, ink depth, and warm-paper clarity.
colors:
  primary: "#0E7490"
  primaryHover: "#0B6175"
  background: "#101719"
  surface: "#172124"
  surfaceRaised: "#202C30"
  text: "#F3F5F3"
  body: "#C6D0CD"
  muted: "#A1AFAB"
  accent: "#67E8F9"
  success: "#6BCB7A"
  warning: "#E7A04E"
  danger: "#EC6A6E"
  info: "#8EB1DF"
typography:
  body:
    fontFamily: Manrope
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: Manrope
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.45
  control:
    fontFamily: Manrope
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.25
  body-large:
    fontFamily: Manrope
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
layout:
  gutter: "clamp(16px, 2.2vw, 32px)"
  contentMax: 1440px
  sidebarWidth: 236px
  topbarHeight: 48px
components:
  button:
    backgroundColor: "#172124"
    textColor: "#E2E8E6"
    rounded: "{rounded.sm}"
    height: 36px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    height: 36px
  mobile-control:
    height: 44px
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
  card-flush:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
  body-large:
    typography: "{typography.body-large}"
exports:
  runtime: "@/components/ui"
  tokens: "@/styles/tokens.css"
  globalCss: "@/app/globals.css"
  cssPrimitives: "@/styles/components.css"
---

## Overview

AtendON is an operational console. Information density, calm hierarchy, and a clear petrol action signal take priority over decoration. Runtime primitives live in `apps/panel/components/ui`; their compatibility selectors are styled by the global CSS vocabulary.

## Colors

The dark runtime defaults to ink `#101719`, with `#172124` surfaces and `#F3F5F3` primary text. Petrol `#0E7490` is the primary action; `#67E8F9` is the accent and focus language. Success, warning, danger, and info communicate state. The light theme overrides these semantic variables under `:root[data-theme="light"]`; consumers use variables, not a second palette.

Runtime record colors remain data-driven: pass the record color through an inline CSS custom property such as `style={{ "--appointment-color": item.responsavel?.cor_agenda ?? "var(--primary)" }}` and let the domain stylesheet consume `var(--appointment-color)`. Do not add record-specific colors to the component palette.

## Typography

The runtime font is Manrope, loaded by `app/globals.css`. Body text is 14px at 1.5 line-height; body-large is 16px; captions are 12px at 1.45; controls use 13px semibold text. Monospace is reserved for identifiers, timestamps, and tabular metrics.

## Layout

Use the runtime spacing rhythm (`--space-1` through `--space-10`) and the responsive `--gutter` (`clamp(16px, 2.2vw, 32px)`). Content is bounded by `--content-max`; wide data uses `TableScroll` or the `.table-scroll` wrapper instead of clipping. Mobile controls are at least 44px high, and text inputs use 16px text below 700px to avoid mobile browser zoom.

## Shapes

Controls use `--radius-sm` (6px), cards use `--radius-md` (8px), dialogs use `--radius-lg` (12px), and badges use `--radius-pill`. `Card` renders a `section.card`; add the `flush` class when its content must reach the card edge (`.card.flush` sets padding to zero).

## Components

- **Button:** `Button` forwards native button props and a ref, supports `default`, `primary`, `quiet`, and `danger` tones, and defaults to `type="button"`. Set `type="submit"` explicitly for form submission; never rely on the default for an action with submit semantics. `IconButton` requires a visible `label` prop and supplies `aria-label` and a title.
- **Card:** `Card` forwards section attributes and refs and preserves the `.card` selector. Use `className="flush"` only for intentional edge-to-edge card content.
- **Field:** `Field` generates a stable control id with `useId` when no id is supplied. It clones supported native or primitive controls to apply the id, associates the label through `htmlFor`, and links either `hint` or `error` with `aria-describedby`; errors also set `aria-invalid`. Supply `htmlFor` when the control id is known or when a custom label target is required. `Input`, `Select`, and `Textarea` forward native props and refs.
- **Table:** `Table` wraps the table in a focusable `.table-wrap`; `TableScroll` renders a focusable `.table-scroll` wrapper for horizontal overflow. Give tables a descriptive accessible name (for example, a nearby heading or `aria-label`), use real `<th>` elements, and associate complex headers with `scope` or `headers`/`id`. Focus the scroll wrapper so keyboard users can reach overflow content.
- **State and status:** `EmptyState`, `ErrorState`, and `LoadingState` preserve `.empty`, `.error`, and `.loading-state`, with status or alert semantics. `Badge` uses semantic tones and the runtime status variables.

CSS ownership is deliberately split: `styles/tokens.css` owns semantic variables and theme overrides; `styles/base.css` owns global resets and typography defaults; `styles/components.css` owns compatibility primitives; domain CSS owns domain selectors; `*.module.css` owns local component layout. `app/globals.css` imports the global layers. Use CSS Modules for component-local rules and global CSS for tokens, resets, shared primitives, and domain selectors; do not duplicate token definitions in a module or documentation export.

## Do's and Don'ts

- Do import the canonical runtime tokens through `docs/design-system/tokens.css`; its `../../styles/tokens.css` path resolves from `docs/design-system` to `apps/panel/styles/tokens.css`.
- Do extend the semantic vocabulary in `styles/tokens.css` only when a shared need exists, then consume the variable through the appropriate global or module stylesheet.
- Do preserve the cascade order: tokens, base, shared primitives, then domain or module rules. Keep a single owner for each semantic decision.
- Don't copy the palette into docs, modules, or feature stylesheets.
- Don't introduce arbitrary pixel values or invalid utility classes when a runtime token or valid utility already expresses the intent.
- Don't use gradients, glass effects, or broad `!important` shape overrides.
