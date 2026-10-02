---
version: alpha
name: AtendON Operate
description: Dense operational console in black and ice, with cyan reserved for focus, selection, and the send action.
colors:
  primary: "#22D3EE"
  primaryHover: "#67E8F9"
  background: "#0E0F11"
  surface: "#141518"
  surfaceElevated: "#191A1E"
  text: "#E6E7EA"
  body: "#A4A7AF"
  muted: "#8E8E96"
  success: "#3DDC97"
  warning: "#F5B94A"
  danger: "#FF7A7A"
  info: "#22D3EE"
typography:
  body:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: Geist
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.5
  body-large:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 12px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
layout:
  gutter: "clamp(12px, 1.4vw, 20px)"
  contentMax: 1160px
  contentFormMax: 48rem
  sidebarWidth: 68px
  topbarHeight: 52px
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: 34px
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "#0A0A0A"
    rounded: "{rounded.md}"
    height: 34px
  button-accent:
    backgroundColor: "{colors.primary}"
    textColor: "#0A0A0A"
    rounded: "{rounded.md}"
    height: 34px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: 34px
  input-small:
    height: 34px
  mobile-control:
    height: 44px
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  card-flush:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  body-large:
    typography: "{typography.body-large}"
exports:
  runtime: "@/components/ui"
  tokens: "@/styles/tokens.css"
  globalCss: "@/app/globals.css"
  cssPrimitives: "@/styles/components.css"
---

## Overview

AtendON is an operational console. Information density, calm hierarchy, and a single cyan accent on black and ice take priority over decoration. Runtime primitives live in `apps/panel/components/ui`; their compatibility selectors are styled by the global CSS vocabulary.

## Colors

The dark theme is the default (`<html data-theme="dark">`): `#0E0F11` background, `#141518` surfaces, `#E6E7EA` text. Cyan `#22D3EE` marks focus, selection, and indicators, and `#67E8F9` is its hover. The main action button is neutral (ice on dark, black on light); the filled cyan `btn--accent` is reserved for sending and bulk confirmation. Cyan used as text on the light theme switches to `--primary-text` (`#0E7490`) to keep AA contrast. Success, warning, danger, and info communicate state; use the `--{status}-text` tokens when the color is text. The light theme is declared in `:root` and the dark theme overrides the same semantic variables under `:root[data-theme="dark"]`; consumers use variables, not a second palette.

Runtime record colors remain data-driven: pass the record color through an inline CSS custom property such as `style={{ "--appointment-color": item.responsavel?.cor_agenda ?? "var(--primary)" }}` and let the domain stylesheet consume `var(--appointment-color)`. Do not add record-specific colors to the component palette.

## Typography

The runtime font is Geist (`--font-sans`), loaded by `app/globals.css` with a system-ui fallback. Geist Mono (`--font-mono`) is reserved for identifiers, timestamps, and tabular metrics. The shell navigation uses the same family. Body text is 13px at 1.5 line-height, body-large is 14px, labels are 12px, captions are 11.5px, and controls use 13px text (buttons at weight 500, fields at 400). Icons come only from `components/icons`.

## Layout

Use the runtime spacing rhythm (`--space-1` through `--space-16`) and the responsive `--gutter` (`clamp(12px, 1.4vw, 20px)`). Content is bounded by `--content-max` (1160px); wide data uses `TableScroll` or the `.table-scroll` wrapper instead of clipping. Short forms opt in to `--content-form-max` (48rem) panel by panel; Settings/General does. There is no global width cap, because inbox, pipeline, agenda, canvas, and tables need their own widths. Mobile controls are at least 44px high, and text inputs use 16px text below 700px to avoid mobile browser zoom.

## Shapes

Controls use `--radius-md` (8px), cards use `--radius-lg` (10px), panels and dialogs use `--radius-xl` (12px), and badges use `--radius-pill`. `Card` renders a `section.card`; add the `flush` class when its content must reach the card edge (`.card.flush` sets padding to zero).

## Components

- **Button:** `Button` forwards native button props and a ref, supports `default`, `primary`, `quiet`, and `danger` tones, and defaults to `type="button"`. Set `type="submit"` explicitly for form submission; never rely on the default for an action with submit semantics. `IconButton` requires a visible `label` prop and supplies `aria-label` and a title.
- **Card:** `Card` forwards section attributes and refs and preserves the `.card` selector. Use `className="flush"` only for intentional edge-to-edge card content.
- **Field:** `Field` generates a stable control id with `useId` when no id is supplied. It clones supported native or primitive controls to apply the id, associates the label through `htmlFor`, and links either `hint` or `error` with `aria-describedby`; errors also set `aria-invalid`. Supply `htmlFor` when the control id is known or when a custom label target is required. `Input`, `Select`, and `Textarea` forward native props and refs; `Textarea` also carries the `textarea` class.
- **Form controls:** `input`, `select`, and `textarea` read three hooks from `styles/tokens.css`: `--input-min-height` (`--control-height-md`: 34px, or 30px in compact density), `--input-pad-y` (4px), and `--input-pad-x` (12px). One-line height comes from the token, so inputs, selects, date fields, and `Button` measure the same. `.input--sm` only swaps hooks (34px, or 28px in compact). A textarea keeps 8px of vertical padding and grows with `rows`; inside `Field` it has a floor of two `--control-height-lg` (76px, or 64px in compact).
- **Table:** `Table` wraps the table in a focusable `.table-wrap`; `TableScroll` renders a focusable `.table-scroll` wrapper for horizontal overflow. Give tables a descriptive accessible name (for example, a nearby heading or `aria-label`), use real `<th>` elements, and associate complex headers with `scope` or `headers`/`id`. Focus the scroll wrapper so keyboard users can reach overflow content.
- **State and status:** `EmptyState`, `ErrorState`, and `LoadingState` preserve `.empty`, `.error`, and `.loading-state`, with status or alert semantics. `Badge` uses semantic tones and the runtime status variables.

CSS ownership is deliberately split: `styles/tokens.css` owns semantic variables and theme overrides; `styles/base.css` owns global resets and typography defaults; `styles/components.css` owns compatibility primitives; domain CSS owns domain selectors; `*.module.css` owns local component layout. `app/globals.css` imports the global layers. Use CSS Modules for component-local rules and global CSS for tokens, resets, shared primitives, and domain selectors; do not duplicate token definitions in a module or documentation export.

## Do's and Don'ts

- Do import the canonical runtime tokens through `docs/design-system/tokens.css`; its `../../styles/tokens.css` path resolves from `docs/design-system` to `apps/panel/styles/tokens.css`.
- Do extend the semantic vocabulary in `styles/tokens.css` only when a shared need exists, then consume the variable through the appropriate global or module stylesheet.
- Do preserve the cascade order: tokens, base, shared primitives, then domain or module rules. Keep a single owner for each semantic decision.
- Don't copy the palette into docs, modules, or feature stylesheets.
- Don't introduce arbitrary pixel values or invalid utility classes when a runtime token or valid utility already expresses the intent.
- Don't set a global `max-width` on content or forms. Opt in with `--content-form-max` where a form reads better narrow.
- Don't use gradients, glass effects, or broad `!important` shape overrides.
