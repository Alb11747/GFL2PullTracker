# Data provenance

The item catalog is independently transformed from the Refitting Room data compilation at revision `240cd46587eca1187119c85c4aee97ec177c45df`:

- Source: https://github.com/Infernal-Crack-LED/gfl2-team-builder/tree/240cd46587eca1187119c85c4aee97ec177c45df/data
- Scope notice: https://github.com/Infernal-Crack-LED/gfl2-team-builder/blob/240cd46587eca1187119c85c4aee97ec177c45df/LICENSE
- Copyright Maxwell Sutton — Refitting Room (https://refittingroom.app)

The source maintainer permits reuse of the extracted and organized game-data compilation. Its source-code PolyForm Noncommercial license expressly excludes underlying game content; this project does not treat that code license as a grant over game data. Underlying Girls' Frontline 2 content belongs to Sunborn and its respective owners.

Only game IDs, names, rarity labels, and region metadata are retained. No upstream application code, descriptions, skill text, or recommendations are copied. Elite (5★), Standard (4★), and Retired (3★) doll and weapon artwork from the same pinned snapshot is served locally for the recruitment history; per-file URLs and SHA-256 hashes are listed in `web/static/portraits/PROVENANCE.md`. Underlying artwork remains the property of its respective game-content owners. The catalog contains 65 dolls and 190 weapons from the snapshot dated 2026-09-04. CN-region entries retain their region label and are not presented as verified global-release names. Miscellaneous items are not covered. Recruitment category labels are mapped from [EXILIUM Tracker’s English locale](https://github.com/EXILIUM-Tracker/i18n/blob/da528b9296162d48dc15337f9250527be1a78803/en/pages/pull.json#L2-L10); individual event pool names are not inferred.

Run `uv run python scripts/update_catalog.py` to reproduce the catalog and `uv run python scripts/update_portraits.py` to reproduce the locally hosted artwork, frontend mapping, and artwork provenance from the pinned snapshot. Changing the pin requires reviewing the upstream data and reuse statements again. Catalog updates never alter original imported records.

## Banner classification facts

`backend/banner_rules.json` contains 110 factual Targeted Procurement and Military Upgrade mappings extracted from EXILIUM Tracker's publicly delivered [banner metadata bundle](https://exilium.xyz/_next/static/chunks/6324-910555260e1a45e7.js), reviewed on 2026-09-24. The source SHA-256 is `66dbaabc637bd03daf5d1cf5c78e40935bfeadfc2abc5f54ec5ae59c5a6821d8`. Only pool IDs, featured Elite item IDs, category IDs, and dates are retained; no upstream application code or artwork is copied. The extractor reads literal data without executing the source JavaScript and rejects any content change until its pin is reviewed.

The dataset covers events from December 2024 through April 2026. Classification is enabled only for `gf2-gacha-record-us.sunborngame.com`; other providers are unverified. The official Sunborn notices for [Daiyan](https://gf2exilium.sunborngame.com/NewsInfo?id=38&typeId=4) and [Mechty](https://gf2exilium.sunborngame.com/NewsInfo?id=83&typeId=4) corroborate the separate Targeted Procurement and Military Upgrade categories and their 50% / 75% featured Elite rates. EXILIUM's wall-clock dates and the publisher's UTC-4 schedule do not use a consistent identical clock. Each matching interval therefore excludes 24 hours at both boundaries and retains the original dates for audit; these conservative intervals are not presented as exact event schedules. Pool IDs are not globally unique: `106001` identifies different featured dolls in January 2025 and February 2026, so time bounds are essential.

For a known single-featured pool, a recorded Elite of the expected kind either matches the featured ID or is an off-banner result. This comparison does not claim that every catalog Elite is eligible for that pool. Unknown items, mismatched kinds, unsupported providers, and Select Procurement remain unclassified. When a dated mapping is missing, targeted recruitment uses the separately maintained standard Elite loss roster. The original six standard dolls are documented by [Prydwen](https://d2ankz0m1a0dsp.cloudfront.net/gfl-exilium/guides/beginner-guide/); [archived publisher announcements](https://iopwiki.com/wiki/GFL2_Changelogs) describe Faye/Hestia and Harpsy/Antinomy, including the [June 24, 2026 notice](https://gf2exilium.sunborngame.com/NewsInfo?typeId=3&id=361) adding Harpsy/Antinomy to targeted recruitment. Item IDs come from the local catalog. Known standard-item rate-up pools still require a matching dated rule. No classification is inferred from observed pull frequency or the historical export's precomputed status flags.

Run `uv run python scripts/update_banner_rules.py` to reproduce these facts. Updating the source requires reviewing provider compatibility, reused pool IDs, dates, and the supported recruitment rules. Imported records are never changed by a metadata update.

## Fonts

The interface uses self-hosted Barlow and Barlow Condensed through Fontsource. Their original SIL Open Font License notices accompany the app at `web/static/fonts-license.txt` and are available from the running app at `/fonts-license.txt`.
