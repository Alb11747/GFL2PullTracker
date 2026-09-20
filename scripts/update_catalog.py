"""Build the minimal lookup catalog from an explicitly pinned data compilation.

This copies no application code, artwork, skill text, or recommendations.
Review upstream provenance before changing SOURCE_REVISION.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.request import urlopen

SOURCE_REPOSITORY = "Infernal-Crack-LED/gfl2-team-builder"
SOURCE_REVISION = "240cd46587eca1187119c85c4aee97ec177c45df"
SOURCE_URL = f"https://github.com/{SOURCE_REPOSITORY}/tree/{SOURCE_REVISION}/data"
ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    items: list[dict[str, object]] = []
    synced_at: set[str] = set()
    for filename, key, id_field, kind in (
        ("dolls.json", "dolls", "gunDataId", "doll"),
        ("weapons.json", "weapons", "gunWeaponDataId", "weapon"),
    ):
        url = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_REVISION}/data/{filename}"
        with urlopen(url, timeout=30) as response:
            document = json.load(response)
        synced_at.add(document["syncedAt"])
        for item in document[key]:
            item_id = item[id_field]
            if not isinstance(item_id, int) or isinstance(item_id, bool):
                raise ValueError(f"Invalid numeric game ID in {filename}")
            if item["rarity"] not in {"Elite", "Standard", "Retired"}:
                raise ValueError(f"Unrecognized rarity in {filename}")
            items.append({
                "id": item_id,
                "name": item["name"],
                "kind": kind,
                "rarity": item["rarity"],
                "region": item["regionTag"],
            })
    if len({item["id"] for item in items}) != len(items):
        raise ValueError("Catalog has duplicate game IDs")
    catalog = {
        "source": {
            "name": "Refitting Room data compilation",
            "url": SOURCE_URL,
            "revision": SOURCE_REVISION,
            "synced_at": sorted(synced_at),
            "notice": "Copyright Maxwell Sutton — Refitting Room (https://refittingroom.app)",
            "scope": "Compilation reuse permitted by its maintainer; underlying game content belongs to its respective owners. See THIRD_PARTY_NOTICES.md.",
        },
        "items": sorted(items, key=lambda item: item["id"]),
    }
    destination = ROOT / "backend" / "catalog.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(items)} catalog entries from {SOURCE_REVISION}")


if __name__ == "__main__":
    main()
