from datetime import UTC, datetime

from backend.coverage import annotate_history
from backend.tracker import validate_document


HOST = "gf2-gacha-record-us.sunborngame.com"


def snapshot(items, *, date="2026-01-01", pages=None, exilium=False, type_id=3):
    timestamp = int(datetime.fromisoformat(date).replace(tzinfo=UTC).timestamp())
    document = {
        "schema_version": 1, "exported_at": "2026-01-01T00:00:00Z",
        "account_fingerprint": "sha256:" + "a" * 64, "endpoint_host": HOST,
        "records": [{"source_type_id": type_id, "source_page": pages[i] if pages else 1,
                     "record": {"item": item, "pool_id": 1, "time": timestamp, "item_num": 20}}
                    for i, item in enumerate(items)],
    }
    if exilium:
        document["external_source"] = {"source": "https://exilium.xyz"}
    return document


def history(document, *, elites=(), unknowns=()):
    _, rows = validate_document(document, None, None)
    occurrences = {}
    for row in rows:
        key = (row["type_id"], row["record_key"])
        occurrences[key] = occurrences.get(key, 0) + 1
        row["occurrence"] = occurrences[key]
        row["rarity"] = "Elite" if row["item_id"] in elites else "Unknown" if row["item_id"] in unknowns else "Standard"
    return rows


def test_first_window_uncertain_then_elite_resets_record_counter():
    doc = snapshot([5, 4, 3, 2, 1])
    rows = annotate_history(history(doc, elites=(3, 5)), [doc], HOST)
    assert [r["pity"] for r in rows] == [2, 1, 3, 2, 1]
    assert [r["pity_uncertain"] for r in rows] == [False, False, True, True, True]
    assert not any(r["gap_before"] for r in rows)


def test_missing_overlap_marks_boundary_and_later_bridge_heals_it():
    full = snapshot([6, 5, 4, 3, 2, 1])
    old, new = snapshot([3, 2, 1]), snapshot([6, 5, 4])
    rows = history(full, elites=(2, 5))
    annotate_history(rows, [old, new], HOST)
    assert [r["item_id"] for r in rows if r["gap_before"]] == [4]
    assert [r["pity_uncertain"] for r in rows] == [False, True, True, False, True, True]
    annotate_history(rows, [old, new, snapshot([4, 3])], HOST)
    assert not any(r["gap_before"] for r in rows)
    assert rows[1]["pity"] == 3 and not rows[1]["pity_uncertain"]


def test_unknown_reward_propagates_uncertainty_until_elite():
    doc = snapshot([6, 5, 4, 3, 2, 1], date="2024-12-03")
    rows = annotate_history(history(doc, elites=(1, 5), unknowns=(3,)), [doc], HOST)
    assert [r["pity_uncertain"] for r in rows] == [False, True, True, True, False, False]


def test_launch_day_is_host_specific_and_unknown_hosts_stay_uncertain():
    doc = snapshot([2, 1], date="2024-12-05")
    assert all(not r["pity_uncertain"] for r in annotate_history(history(doc), [doc], "gf2-gacha-record-intl.haoplay.com"))
    for host in (HOST, "unknown.example"):
        assert all(r["pity_uncertain"] for r in annotate_history(history(doc), [doc], host))


def test_missing_source_page_breaks_adjacency_and_exilium_reverses_ties():
    doc = snapshot([4, 3, 2, 1], pages=[1, 1, 3, 3])
    rows = annotate_history(history(doc), [doc], HOST)
    assert [r["item_id"] for r in rows if r["gap_before"]] == [3]
    exilium = snapshot([1, 2, 3, 4], exilium=True)
    rows = annotate_history(history(exilium), [exilium], HOST)
    assert [r["item_id"] for r in rows] == [4, 3, 2, 1]
    assert not any(r["gap_before"] for r in rows)


def test_type_isolation_and_duplicate_occurrences():
    one = snapshot([1, 2, 1])
    two = snapshot([1, 2, 1], type_id=6)
    rows = history(one, elites=(2,)) + history(two)
    annotate_history(rows, [one, two], HOST)
    assert [r["pity"] for r in rows] == [1, 2, 1, 3, 2, 1]
    assert not any(r["gap_before"] for r in rows)
    assert annotate_history([], [], HOST) == []


def test_partial_duplicate_ordinals_cannot_prove_adjacency():
    full = snapshot([1, 2, 1, 3, 4])
    rows = history(full)
    # Each partial source labels its one identical record occurrence 1, but it
    # cannot identify which of the two saved occurrences it actually contains.
    partials = [snapshot([1, 2]), snapshot([2, 1, 3, 4])]
    annotate_history(rows, partials, HOST)
    assert [r["gap_before"] for r in rows] == [True, True, True, False, False]
    # A later complete source establishes all identities and heals the gaps.
    annotate_history(rows, [*partials, full], HOST)
    assert not any(r["gap_before"] for r in rows)
