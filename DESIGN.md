---
name: "GFL2 Pull Tracker"
description: "A warm paper recruitment ledger with precise ink rules and restrained oxblood controls."
colors:
  red: "#a33625"
  red-hover: "#842c20"
  primary-text: "#fffaf5"
  ink: "#232a29"
  muted: "#5b6058"
  paper: "#f3f1e9"
  line: "#c5c8bd"
  olive: "#d4d8cc"
  white: "#faf9f5"
  track: "#e3e5da"
  bar: "#8e9b80"
  bar-deep: "#465241"
  type-bar: "#7b896e"
typography:
  display:
    fontFamily: "Barlow Condensed, Barlow, sans-serif"
    fontSize: "clamp(2.4rem, 4vw, 3.6rem)"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-.02em"
  headline:
    fontFamily: "Barlow Condensed, Barlow, sans-serif"
    fontSize: "1.65rem"
    fontWeight: 600
    letterSpacing: "-.02em"
  title:
    fontFamily: "Barlow Condensed, Barlow, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    letterSpacing: "-.02em"
  body:
    fontFamily: "Barlow, sans-serif"
    fontSize: "15px"
    fontWeight: 400
  label:
    fontFamily: "Barlow, sans-serif"
    fontSize: ".8rem"
    fontWeight: 600
  metric:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "3.25rem"
    fontWeight: 600
    lineHeight: 1
rounded:
  square: "0"
  control: "3px"
spacing:
  control-gap: "8px"
  field-gap: "12px"
  section-gap: "24px"
  desktop-gutter: "48px"
  mobile-gutter: "20px"
components:
  button-primary:
    backgroundColor: "{colors.red}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.red-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 0"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 10px"
  import-navigation:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "8px 0 12px"
  rarity-tag:
    textColor: "{colors.red}"
  ledger-header:
    backgroundColor: "{colors.olive}"
    padding: "10px 16px"
  import-panel:
    padding: "24px 28px 28px"
---

# Design System: GFL2 Pull Tracker

## Overview

**Creative North Star: "The Armory Inspection Ledger"**

Warm paper, condensed headings, olive table surfaces, and thin ink rules make records feel like an inspection register. Density comes from aligned information and compact controls; the red accent points to actions and selected evidence.

This captures the implemented draft direction, not a user-confirmed style choice. It was extracted from web/src/app.css, web/src/routes/+layout.svelte, and the page component. Integrated screenshots at desktop (1440px) and mobile (390px) widths were inspected by the primary task and finish reviewer, with a final SHIP disposition and no material visual regressions. The parent task reports 17 passing browser checks covering real imports, filters, pagination, import progress, keyboard access, and mobile overflow. This documentation pass records that completed evidence; it did not independently run the browser checks.

**Key Characteristics:**
- Warm paper with ink and olive structure.
- Condensed headings above a compact, tabular ledger.
- Flat sections separated by rules and tonal changes.
- Text labels accompany chart colors and record states.

## Colors

The palette combines warm neutrals with restrained oxblood and desaturated olive. Frontmatter values are normative; the color names below describe their use.

### Primary

- **Oxblood** (`red`) marks the primary action, keyboard focus, active import method, and Elite rarity. `red-hover` deepens primary buttons; `primary-text` provides their light label.

### Secondary

- **Olive** (`olive`) identifies the table heading. `bar`, `bar-deep`, and `type-bar` distinguish chart series without adding decorative accents.

### Neutral

- **Ink** (`ink`) is the default text and strong section rule.
- **Muted ink** (`muted`) supports labels, provenance, and secondary values.
- **Warm paper** (`paper`) is the page canvas; **field white** (`white`) is the control surface.
- **Ledger line** (`line`) divides regions; **chart track** (`track`) is the unfilled bar surface.

**The Evidence Label Rule.** Color reinforces a written label; it never replaces one.

The sidecar's tonal ramps are synthesized preview metadata, not an additional shipping color scale.

## Typography

Barlow is the body and control family; Barlow Condensed provides headings and the large total. Both are bundled through Fontsource imports in the root layout. The source loads Barlow weights 400, 500, 600, and 700, plus Barlow Condensed 500 and 600.

The page title uses `display`; general section headings use `headline`, while chart headings are a smaller observed variant (1.45rem). The history heading is an observed larger variant (2rem). Generic third-level headings use `title`. The body baseline is 15px, with form labels and supporting information deliberately smaller. Controls typically use weights 400 through 600. Table data, statistics, and pagination use tabular numerals.

Headings use tight tracking and balanced wrapping. Ordinary body text retains natural casing. The wordmark uses a compact stacked name; it does not establish an eyebrow-label convention for future content.

## Layout

The desktop masthead and main content share a centered maximum width (1456px) and matching gutters. The main region begins with 42px top padding. A ruled summary strip uses three unequal columns (.85fr / 1.5fr / 1fr), followed by two equal chart columns with a 56px gap. The history is separated by a strong top rule, with filters above the full-width table. This describes the current surface, rather than requiring every future screen to reproduce its composition.

Filters occupy seven columns at the widest layout. At 1150px and below, gutters become 32px, filters become four columns, and record secondary values stack beneath the name. At 1450px and above, shared gutters grow to 64px.

At 760px and below, gutters become 20px; the summary total spans both remaining columns; charts and import columns stack; filters become two columns with search spanning both. The header keeps the import action visible with the profile selector below it. The title rule disappears. Pagination stacks, and the footer wraps.

The mobile ledger retains a minimum table width (630px) inside its horizontal scroll region. Source also provides mobile table-navigation buttons. Page layout itself should fit the viewport. The import panel reaches the mobile content edges and preserves its internal padding.

## Elevation & Depth

The source contains no box shadows. Background shifts distinguish the table header, expanded details, empty state, and import panel. Strong section rules are 2px; normal dividers and control borders are 1px.

**The Flat Register Rule.** Separate ordinary sections with rules and tone; the implemented system has no shadow vocabulary.

## Shapes

Controls have slightly softened corners through `rounded.control`. Chart tracks, the ledger, and major panels keep square edges. The small archive-status dot is circular. Icons are inline, unfilled line SVGs, generally 20px with a 1.5 stroke width, with smaller local variants where space requires them.

## Components

### Buttons

Primary and secondary buttons share centered inline content, an 8px icon gap, and a 40px minimum height. Primary buttons use oxblood; secondary buttons use a transparent surface and a fine gray-green outline. Hover darkens the primary surface or adds a pale olive tint to the secondary button. Text actions use an underline offset by 4px and no border. Disabled buttons reduce opacity to .45 and lose the pointer cursor.

All keyboard-focusable controls receive an oxblood outline (3px) offset from the element (3px). File chooser labels use the same treatment through focus-within. There is no separate authored pressed-state visual.

### Fields

Labels sit above white inputs with a 7px gap. Inputs, selects, and textareas use the control radius, gray-green border, and 40px minimum height. Search reserves space for an inline icon. Textareas resize vertically. Error feedback appears as explicit text in the import-result region, with a dark red tone; field-level error styling is not a separate system variant.

### Import navigation

Import methods are adjacent text buttons over a shared bottom divider. The chosen method gains a 2px oxblood underline, oxblood text, and semibold weight. These are method selectors inside the import region, not a global navigation system.

### Rarity labels and charts

Rarity is a compact text label without a pill background. Elite uses oxblood, while other labels retain ink. Chart tracks show a subdued olive remainder and numeric labels remain visible beside bars. Horizontal bars animate scaleX from the left edge; vertical columns animate scaleY from the bottom edge. Both use a transform transition over .5s with cubic-bezier(.16,1,.3,1). A zero count has zero visible fill.

### Ledger and details

The ledger uses an olive header, compact rows, and horizontal dividers. Hover gives the row a subtle tonal change. Expanded details use a stronger olive surface and wrap their provenance fields. The disclosure SVG rotates over .2s. Unknown item names retain their textual identity and use lighter, italic treatment rather than disappearing.

### Import panel

The import region is an inline tonal panel with a strong top rule. Its source uses a short clip-path reveal (.35s) and two columns (1fr / 2fr) on desktop. Progress and partial/error outcomes appear within the region. All authored transitions and animation are removed when prefers-reduced-motion is reduce.

The current system has no reusable elevated card component. The sidecar records actual buttons, fields, method navigation, rarity label, ledger header, and import panel instead.

## Do's and Don'ts

### Do:
- Do use condensed headings with Barlow controls and tabular numeric data.
- Do pair rarity color with a visible text label.
- Do preserve visible keyboard focus and reduced-motion behavior.
- Do keep mobile horizontal overflow inside the ledger region.

### Don't:
- Don't communicate rarity or import problems through color alone.
- Don't hide unresolved records to produce a visually complete ledger.
- Don't turn the observed panel and chart transitions into continuous animation.

## Public tracker extension

Public mode adds a compact navigation row for My history, Profiles, Backup & sync, Community statistics, and Privacy. These surfaces reuse the existing paper, ink, oxblood, thin rules, Barlow typography, and visible focus treatments. Settings use aligned form groups and inline confirmations; consent and unavailable-provider messages appear beside the action they affect. Mobile settings stack, and history overflow stays within its table region.

Local storage and cloud synchronization have separate status messages. Empty community statistics show the minimum contribution threshold, not illustrative totals. Captures are never reflected in errors, and unavailable Google or provider configuration is explained before submission.
