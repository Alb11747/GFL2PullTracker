# Data provenance

The item catalog is independently transformed from the Refitting Room data compilation at revision `240cd46587eca1187119c85c4aee97ec177c45df`:

- Source: https://github.com/Infernal-Crack-LED/gfl2-team-builder/tree/240cd46587eca1187119c85c4aee97ec177c45df/data
- Scope notice: https://github.com/Infernal-Crack-LED/gfl2-team-builder/blob/240cd46587eca1187119c85c4aee97ec177c45df/LICENSE
- Copyright Maxwell Sutton — Refitting Room (https://refittingroom.app)

The source maintainer permits reuse of the extracted and organized game-data compilation. Its source-code PolyForm Noncommercial license expressly excludes underlying game content; this project does not treat that code license as a grant over game data. Underlying Girls' Frontline 2 content belongs to Sunborn and its respective owners.

Only game IDs, names, rarity labels, and region metadata are retained. No upstream application code, descriptions, skill text, or recommendations are copied. Elite doll and weapon artwork from the same pinned snapshot is served locally for the recruitment history; per-file URLs and SHA-256 hashes are listed in `web/static/portraits/PROVENANCE.md`. Underlying artwork remains the property of its respective game-content owners. The catalog contains 65 dolls and 190 weapons from the snapshot dated 2026-09-04. CN-region entries retain their region label and are not presented as verified global-release names. Miscellaneous items are not covered. Recruitment category labels are mapped from [EXILIUM Tracker’s English locale](https://github.com/EXILIUM-Tracker/i18n/blob/da528b9296162d48dc15337f9250527be1a78803/en/pages/pull.json#L2-L10); individual event pool names are not inferred.

Run `uv run python scripts/update_catalog.py` to reproduce the catalog from the pinned snapshot. Changing the pin requires reviewing the upstream data and reuse statements again. Catalog updates never alter original imported records.

## Fonts

The interface uses self-hosted Barlow and Barlow Condensed through Fontsource. Their original SIL Open Font License notices accompany the app at `web/static/fonts-license.txt` and are available from the running app at `/fonts-license.txt`.
