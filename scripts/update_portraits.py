"""Host pinned catalog artwork locally and record its source and content hash.

Review upstream provenance before changing the pin in update_catalog.py.
This does not copy upstream application code or modify imported history.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
from urllib.request import urlopen

from update_catalog import SOURCE_REPOSITORY, SOURCE_REVISION

ROOT = Path(__file__).resolve().parents[1]
RAW_BASE = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_REVISION}"
SOURCE_BASE = f"https://github.com/{SOURCE_REPOSITORY}"


def fetch_artwork(entry: tuple[int, str]) -> tuple[int, str, bytes]:
    item_id, asset_path = entry
    url = f"{RAW_BASE}/web/public{asset_path}"
    with urlopen(url, timeout=30) as response:
        content = response.read()
    if content[:4] != b"RIFF" or content[8:12] != b"WEBP":
        raise ValueError(f"Expected WebP artwork for item {item_id}")
    return item_id, url, content


def main() -> None:
    catalog = json.loads((ROOT / "backend/catalog.json").read_text(encoding="utf-8"))
    if catalog["source"]["revision"] != SOURCE_REVISION:
        raise ValueError("Regenerate the catalog before updating artwork from a new pin")
    catalog_ids = {item["id"] for item in catalog["items"]}
    entries: dict[int, str] = {}
    for kind, id_field, image_field in (
        ("dolls", "gunDataId", "avatarUrl"),
        ("weapons", "gunWeaponDataId", "imageUrl"),
    ):
        with urlopen(f"{RAW_BASE}/data/{kind}.json", timeout=30) as response:
            document = json.load(response)
        for item in document[kind]:
            item_id, asset_path = item[id_field], item[image_field]
            if item_id not in catalog_ids or item_id in entries:
                raise ValueError(f"Unexpected or duplicate item ID: {item_id}")
            if not re.fullmatch(rf"/game-assets/{kind}/[a-z0-9-]+\.webp", asset_path):
                raise ValueError(f"Unexpected artwork path for item {item_id}")
            entries[item_id] = asset_path
    if entries.keys() != catalog_ids:
        raise ValueError("Pinned artwork does not cover the catalog")

    # Finish all downloads before replacing any files, so a network failure
    # cannot leave a partially updated mapping or provenance table.
    with ThreadPoolExecutor(max_workers=8) as executor:
        artwork = list(executor.map(fetch_artwork, sorted(entries.items())))
    destination = ROOT / "web/static/portraits"
    destination.mkdir(parents=True, exist_ok=True)
    mapping = {}
    rows = []
    for item_id, url, content in sorted(artwork, key=lambda entry: str(entry[0])):
        (destination / f"{item_id}.webp").write_bytes(content)
        mapping[str(item_id)] = f"/portraits/{item_id}.webp"
        rows.append(f"| {item_id} | {url} | {hashlib.sha256(content).hexdigest()} |")
    (ROOT / "web/src/lib/portraits.json").write_text(
        json.dumps(mapping, indent=2) + "\n", encoding="utf-8"
    )
    provenance = f"""# Reward artwork

Game artwork belongs to Sunborn Network Technology and its respective owners. These local copies cover every Elite (5★), Standard (4★), and Retired (3★) item in the pinned public catalog, independently of user history.

Compilation: Copyright Maxwell Sutton — Refitting Room (https://refittingroom.app).

Source: {SOURCE_BASE}/tree/{SOURCE_REVISION}/web/public/game-assets

Scope notice: {SOURCE_BASE}/blob/{SOURCE_REVISION}/LICENSE

The maintainer permits reuse of the extraction and organization and requests local hosting. The application source-code license excludes these game assets and does not grant rights over the underlying artwork.

Run `uv run python scripts/update_portraits.py` to reproduce these unmodified WebP files, the frontend mapping, and this table from the pinned source. The script requires the local catalog to use the same source revision and refuses incomplete coverage.

| Item ID | Source | SHA256 |
| --- | --- | --- |
"""
    (destination / "PROVENANCE.md").write_text(
        provenance + "\n".join(rows) + "\n", encoding="utf-8"
    )
    print(f"Wrote {len(artwork)} local artwork files from {SOURCE_REVISION}")


if __name__ == "__main__":
    main()
