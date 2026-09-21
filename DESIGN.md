---
name: "GFL2 Pull Tracker"
description: "An Exilium-inspired recruitment ledger with charcoal chrome, cool white surfaces, and signal-orange actions."
colors:
  accent: "#ff7a18"
  surface: "#e3e7eb"
  surface-hover: "#dce2e8"
  control-line: "#7a8591"
  success: "#386346"
  danger: "#a62932"
  accent-text: "#a64000"
  accent-hover: "#ff963f"
  primary-text: "#20252b"
  ink: "#20252b"
  muted: "#555e68"
  paper: "#f0f2f4"
  line: "#c3c9d0"
  table-head: "#292f36"
  white: "#fbfcfd"
  track: "#d6dce2"
  bar: "#707d8a"
  bar-deep: "#424e5d"
  type-bar: "#526273"
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
    backgroundColor: "{colors.accent}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
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
    textColor: "{colors.accent-text}"
  ledger-header:
    backgroundColor: "{colors.table-head}"
    padding: "10px 16px"
  import-panel:
    padding: "24px 28px 28px"
---

# Design System: GFL2 Pull Tracker

## Overview

**Creative North Star: "The Armory Inspection Ledger"**

The existing ledger layout now uses an Exilium-inspired palette, following the user's request for stronger official color cues. The [official Haoplay website](https://gf2.haoplay.com/en/) provides the visual reference: orange branding against near-black and white. These are adapted interface colors, not an official brand specification.

## Colors

- **Signal orange** (`accent`) identifies primary buttons, the masthead mark/rule, and the active navigation underline. Dark labels keep buttons readable.
- **Burnt orange** (`accent-text`) supports readable active text, Elite labels/bars, and focus rings on light surfaces. Bright orange focus is used inside the dark masthead.
- **Charcoal** (`ink`, `table-head`) anchors the masthead and table headings, with white text on both.
- **Cool neutrals** (`paper`, `white`, `surface`, `surface-hover`) separate the canvas, fields, import/settings panels, and hovered rows. `control-line` defines visible control edges; `line` is a quiet separator.
- **Slate chart series** (`bar`, `bar-deep`, `type-bar`) retain adjacent numeric labels and text categories.
- **Semantic colors** (`success`, `danger`) keep status green and errors red separate from orange branding. Text always accompanies these meanings.

## Typography

Barlow is the body and control family; Barlow Condensed provides headings and the large total. Both are bundled through Fontsource imports in the root layout. The source loads Barlow weights 400, 500, 600, and 700, plus Barlow Condensed 500 and 600.

The page title uses `display`; general section headings use `headline`, while chart headings are a smaller observed variant (1.45rem). The history heading is an observed larger variant (2rem). Generic third-level headings use `title`. The body baseline is 15px, with form labels and supporting information deliberately smaller. Controls typically use weights 400 through 600. Table data, statistics, and pagination use tabular numerals.

Headings use tight tracking and balanced wrapping. Ordinary body text retains natural casing. The wordmark uses a compact stacked name; it does not establish an eyebrow-label convention for future content.

## Layout

The desktop masthead and main content share a centered maximum width (1456px) and matching gutters. The main region begins with 42px top padding. A ruled summary strip uses three unequal columns (.85fr / 1.5fr / 1fr), followed by two equal chart columns with a 56px gap. The history is separated by a strong top rule, with filters above the full-width table. This describes the current surface, rather than requiring every future screen to reproduce its composition.

Search and rarity occupy the two visible filter columns. **More filters** discloses item kind, source type, pool ID, and date bounds in five columns, with an active count in its summary even when collapsed. Reset clears both visible and disclosed values. At 1150px and below, gutters become 32px and record secondary values stack beneath the name. At 1450px and above, shared gutters grow to 64px.

At 760px and below, gutters become 20px; the summary total spans both remaining columns; charts and import columns stack; filters use two columns with search spanning both, and disclosed filters use two columns. The header keeps the import action visible with the profile selector below it. Pagination stacks, and the footer wraps.

The mobile ledger retains a minimum table width (630px) inside its horizontal scroll region. Source also provides mobile table-navigation buttons. Page layout itself should fit the viewport. The import panel reaches the mobile content edges and preserves its internal padding.

## Elevation & Depth

The source contains no box shadows. Background shifts distinguish the table header, expanded details, empty state, and import panel. Strong section rules are 2px; normal dividers and control borders are 1px.

**The Flat Register Rule.** Separate ordinary sections with rules and tone; the implemented system has no shadow vocabulary.

## Shapes

Controls have slightly softened corners through `rounded.control`. Chart tracks, the ledger, and major panels keep square edges. The small archive-status dot is circular. Icons are inline, unfilled line SVGs, generally 20px with a 1.5 stroke width, with smaller local variants where space requires them.

## Components

The header wordmark uses “GIRLS’ FRONTLINE 2: EXILIUM” when its available space is at least 23rem, falling back to “GFL2” beside the profile and import controls on narrower layouts. “PULL TRACKER” remains on the second line, and the home link always has the full accessible name.

### Buttons

Primary and secondary buttons share centered inline content, an 8px icon gap, and a 40px minimum height. Primary buttons use signal orange with charcoal text; secondary buttons use a transparent surface and a slate outline. Hover brightens the primary surface or adds a cool gray tint to the secondary button. Text actions use an underline offset by 4px and no border. Disabled buttons reduce opacity to .45 and lose the pointer cursor.

All keyboard-focusable controls receive a burnt-orange outline (3px) offset from the element (3px). File chooser labels use the same treatment through focus-within. The masthead uses bright orange focus against charcoal. Active navigation has a bottom orange marker; this indicates selection, not a decorative panel border.

Enabled buttons, dropdowns, checkbox/radio controls and their labels, file pickers, and date-picker icons use a pointer cursor. Disabled controls use the default cursor, including those disabled by a parent fieldset. Editable text and page-number fields retain their text cursor.

### Fields

Labels sit above white inputs with a 7px gap. Inputs, selects, and textareas use the control radius, slate border, and 40px minimum height. Search reserves space for an inline icon. Textareas resize vertically. Error feedback appears as explicit text in the import-result region, with a dark red tone; field-level error styling is not a separate system variant.

### Import navigation

Import methods are adjacent text buttons over a shared bottom divider. The chosen method gains a 2px burnt-orange underline, burnt-orange text, semibold weight, and a programmatic pressed state. These are method selectors inside the import region, not a global navigation system.

### Rarity labels and charts

Rarity is a compact text label without a pill background. Elite uses burnt-orange, while other labels retain ink. Chart tracks show a cool gray remainder and numeric labels remain visible beside bars. Horizontal bars animate scaleX from the left edge; vertical columns animate scaleY from the bottom edge. Both use a transform transition over .5s with cubic-bezier(.16,1,.3,1). A zero count has zero visible fill.

The secondary overview leads with **What you recruited**: Dolls, Weapons, and Unknown counts. **Source details** discloses technical source-type and pool distributions with an explicit note that recruitment category names are unverified. Do not infer banner names from those IDs.

### Ledger and details

Current pity sits beside the recruitment selector, above the portrait history, with the number of pulls since the last 5★ and that reward's name and date. Incomplete intervals use an explicit uncertainty message; histories without an Elite describe pulls before the first 5★. The counter stacks below the selector on mobile.

Each ledger pity cell includes its recruitment name. Elite rows mark the counter reset, and a short explanation above the scroll region describes separate counters and filtered-out rewards. Keep this explanation readable without horizontal scrolling. Record log filters do not change the recruitment overview.

At 760px and below, hide the Qty. column; item quantity remains available in expanded record details at every width.

Pagination retains the current rows and expanded details while fetching the next page. Disable paging and row controls while busy, then preserve the visible pager's position when the replacement arrives. If the user scrolls away during loading, leave their position alone. Failed page requests retain the current page with an inline retry; filter and profile changes still clear outdated rows immediately.

The current page number is an inline, underlined numeric field with no box or spinner: Enter jumps to a valid page, and Escape or leaving the field cancels an unsubmitted edit. Keep the total page count beside it and preserve the keyboard focus outline. At narrow mobile widths, move Rows onto its own line so Previous, the page field, and Next remain together.

The ledger uses a charcoal header with white text, compact rows, and horizontal dividers. Hover gives the row a subtle tonal change. Expanded details use a cool gray surface and wrap their provenance fields, including raw source IDs. The disclosure SVG rotates over .2s. Unknown item names retain an explicit Unknown label and use lighter, italic treatment rather than disappearing.

### Import panel

The import region is an inline tonal panel with a strong top rule. Its source uses a short clip-path reveal (.35s) and two columns (1fr / 2fr) on desktop. Submission and progress precede the long capture guide. Progress distinguishes collection, stopping, and saving; a compact status remains visible when the panel closes or navigation changes. Completion reports records read, added, and profile total, with coverage caveats and a **View history** action that focuses the ledger. Errors are alerts; progress and outcomes use status announcements. All authored transitions and animation are removed when prefers-reduced-motion is reduce.

**Choose files** accepts JSON exports and individual compressed tracker backups alongside **Choose export folder** and the separate **Restore a tracker backup** action. A validated backup opens the existing restore controls, retains its filename, and focuses the restore heading. Each selection defaults to merging; replacement remains an explicit confirmed choice. Unavailable server choices explain their capability restriction beside the disabled control. Profile and archive controls stay disabled while collection or saving is active.

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

Public mode adds a compact navigation row for My history, Profiles, Backup & sync, Community statistics, and Privacy. These surfaces reuse the existing cool paper, charcoal, orange, thin rules, Barlow typography, and visible focus treatments. Settings use aligned form groups and inline confirmations; consent and unavailable-provider messages appear beside the action they affect. Mobile settings stack, and history overflow stays within its table region.

Local storage and cloud synchronization have separate status messages. Empty community statistics show the minimum contribution threshold, not illustrative totals. Captures are never reflected in errors, and unavailable Google or provider configuration is explained before submission.
