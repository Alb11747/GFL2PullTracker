"""Extract reviewed banner facts without executing the source application's code.

The content hash is mandatory: a changed upstream release requires a new review,
including provider compatibility, pool-ID reuse, and the source's time convention.
"""

from __future__ import annotations

import ast
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://exilium.xyz/_next/static/chunks/6324-910555260e1a45e7.js"
SOURCE_SHA256 = "66dbaabc637bd03daf5d1cf5c78e40935bfeadfc2abc5f54ec5ae59c5a6821d8"
SOURCE_REVIEWED_ON = "2026-09-24"


def extract_facts(source: str) -> list[dict]:
    # Decode only the literal string table and scalar/array assignments. Never
    # evaluate JavaScript: the upstream bundle also contains executable code.
    table_match = re.search(r"function ey\(\)\{let t=(\[.*?\]);return", source)
    if table_match is None:
        raise ValueError("Reviewed source string table is missing")
    strings = ast.literal_eval(table_match[1])
    if not isinstance(strings, list) or not all(isinstance(s, str) for s in strings):
        raise ValueError("Invalid source string table")
    offset = (strings.index("pool_id") - (202 - 106)) % len(strings)
    strings = strings[offset:] + strings[:offset]
    decoded = re.sub(r"c\((\d+)\)", lambda m: json.dumps(strings[int(m[1]) - 106]), source)
    fields = "cardPoolType|pool_id|rateUps5|start_time|end_time"
    assignment = re.compile(
        rf'([A-Za-z_$][\w$]*)(?:\["({fields})"\]|\.({fields}))='
        r'(\[[\d,]*\]|\d+|"[^"]*")'
    )
    objects: dict[str, dict] = {}
    for match in assignment.finditer(decoded):
        objects.setdefault(match[1], {})[match[2] or match[3]] = json.loads(match[4])
    facts = [row for row in objects.values() if row.get("cardPoolType") in (3, 4)]
    if len(facts) != 110:
        raise ValueError("Reviewed banner count changed")
    return facts


def build_rules(source: bytes, catalog: dict) -> dict:
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError("Source hash changed; review the new data before updating the pin")
    items = {item["id"]: item for item in catalog["items"]}
    pools = []
    for fact in extract_facts(source.decode("utf-8")):
        kind = "doll" if fact["cardPoolType"] == 3 else "weapon"
        featured = fact["rateUps5"]
        if len(featured) != 1 or any(
            item not in items or items[item]["kind"] != kind or items[item]["rarity"] != "Elite"
            for item in featured
        ):
            raise ValueError("Banner must have one known Elite featured item of the expected kind")
        start = datetime.strptime(fact["start_time"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        end = datetime.strptime(fact["end_time"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        if start >= end:
            raise ValueError("Invalid banner interval")
        pools.append({
            "type_id": fact["cardPoolType"], "pool_id": fact["pool_id"],
            "kind": kind, "featured": featured,
            # These are matching guards, not advertised event schedules. Source
            # and publisher clocks differ; exclude uncertain boundary periods.
            "start": (start + timedelta(days=1)).isoformat().replace("+00:00", "Z"),
            "end": (end - timedelta(days=1) + timedelta(seconds=1)).isoformat().replace("+00:00", "Z"),
            "source_start": fact["start_time"], "source_end": fact["end_time"],
        })
    pools.sort(key=lambda row: (row["type_id"], row["pool_id"], row["start"]))
    for previous, current in zip(pools, pools[1:]):
        if (previous["type_id"], previous["pool_id"]) == (current["type_id"], current["pool_id"]) and previous["end"] > current["start"]:
            raise ValueError("Ambiguous matching intervals for a reused pool ID")
    return {
        "version": 2,
        "source": {
            "name": "EXILIUM Tracker published banner metadata",
            "url": SOURCE_URL, "sha256": SOURCE_SHA256, "reviewed_on": SOURCE_REVIEWED_ON,
            "scope": "Factual pool IDs and featured item IDs only; no application code or artwork reused.",
            "time_bounds": "Source wall-clock interval narrowed by 24 hours at each boundary; exclusive end. Matching guards, not exact event schedules.",
            "official_rules_urls": [
                "https://gf2exilium.sunborngame.com/NewsInfo?id=38&typeId=4",
                "https://gf2exilium.sunborngame.com/NewsInfo?id=83&typeId=4",
            ],
        },
        "hosts": ["gf2-gacha-record-us.sunborngame.com"],
        "pools": pools,
        **fixed_loss_facts(),
    }


def fixed_loss_facts() -> dict:
    # These independently reviewed roster facts are not extracted from the old
    # dated-banner bundle. Preserve them when regenerating its mappings.
    current = json.loads((ROOT / "backend" / "banner_rules.json").read_text(encoding="utf-8"))
    return {key: current[key] for key in ("fixed_loss_pools", "fixed_loss_source")}


def main() -> None:
    with urlopen(SOURCE_URL, timeout=30) as response:
        source = response.read()
    catalog = json.loads((ROOT / "backend" / "catalog.json").read_text(encoding="utf-8"))
    rules = build_rules(source, catalog)
    destination = ROOT / "backend" / "banner_rules.json"
    destination.write_text(json.dumps(rules, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(rules['pools'])} reviewed banner rules")


if __name__ == "__main__":
    main()
