"""Observed source adjacency and pity under the stable source-order assumption.

Snapshots are evidence of contiguous windows, not lifetime completeness. An
Exilium aggregate is treated as one window; gaps already lost by its exporter
cannot be reconstructed here. Later snapshots can bridge previously separated
windows without persisting a stale gap flag on individual pulls.
"""
from collections import Counter, defaultdict
import hashlib
import json

from backend.database import source_records_newest_first


def _identity(row):
    return row["type_id"], row["record_key"], row["occurrence"]


def _observed_adjacency(documents, saved_counts):
    edges = set()
    for document in documents:
        empty_pages = {int(type_id): set(pages) for type_id, pages in
                       document.get("_coverage_empty_pages", {}).items()}
        occurrences = Counter()
        candidates = set()
        previous = {}
        for entry in source_records_newest_first(document):
            type_id = entry["source_type_id"]
            raw = entry["record"]
            key = hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()
            occurrences[(type_id, key)] += 1
            identity = (type_id, key, occurrences[(type_id, key)])
            page = entry["source_page"]
            prior = previous.get(type_id)
            # Collector pages must form an uninterrupted sequence. Exilium
            # conversion stores its full oldest-first array on source page 1.
            connected_pages = prior is not None and (
                page in (prior[1], prior[1] + 1)
                or (page > prior[1] + 1 and all(
                    skipped in empty_pages.get(type_id, set())
                    for skipped in range(prior[1] + 1, page))))
            # Incremental exports retain emptied overlap pages before their
            # cached tail. Only validated empty-page evidence closes that jump.
            if connected_pages and prior[2] >= raw["time"]:
                candidates.add((prior[0], identity))
            previous[type_id] = (identity, page, raw["time"])
        # Ordinals identify indistinguishable duplicate records only when the
        # snapshot contains every saved occurrence of that key. A subset's A1
        # could actually be the saved A2, so neither adjacent edge is evidence.
        edges.update((newer, older) for newer, older in candidates
                     if occurrences[newer[:2]] == saved_counts[newer[:2]]
                     and occurrences[older[:2]] == saved_counts[older[:2]])
    return edges


def _launch_date(endpoint_host):
    if endpoint_host in {"gf2-gacha-record-us.sunborngame.com", "gf2-gacha-record.sunborngame.com"}:
        return "2024-12-03"
    if endpoint_host in {"gf2-gacha-record-asia.haoplay.com", "gf2-gacha-record-jp.haoplay.com",
                         "gf2-gacha-record-kr.haoplay.com", "gf2-gacha-record-intl.haoplay.com"}:
        return "2024-12-05"
    return None


def annotate_history(rows, documents, endpoint_host):
    """Annotate complete newest-first history before search/filter/pagination.

    Rows include internal record_key and occurrence identifiers. Counters are
    per source type, count records (not item quantities), and reset after an
    Elite reward. A gap or unknown rarity makes the observed count uncertain
    until the next known Elite. A launch-day oldest record establishes an
    assumed starting point; all other first windows start uncertain.
    """
    saved_counts = Counter((row["type_id"], row["record_key"]) for row in rows)
    edges = _observed_adjacency(documents, saved_counts)
    types = defaultdict(list)
    for row in rows:
        types[row["type_id"]].append(row)
    launch = _launch_date(endpoint_host)
    for ordered in types.values():
        chronological = list(reversed(ordered))
        uncertain = launch is None or chronological[0]["timestamp"][:10] != launch
        count = 0
        previous = None
        for row in chronological:
            gap = previous is not None and (_identity(row), _identity(previous)) not in edges
            uncertain = uncertain or gap or row["rarity"] == "Unknown"
            count += 1
            row.update(gap_before=gap, pity=count, pity_uncertain=uncertain)
            if row["rarity"] == "Elite":
                count = 0
                uncertain = False
            previous = row
    return rows
