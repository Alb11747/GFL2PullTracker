import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from backend.app import create_app
from backend import banner_outcomes
from backend.banner_outcomes import annotate_banner_outcomes, summarize_banner_outcomes


HOST = "gf2-gacha-record-us.sunborngame.com"
RULES = {"hosts": [HOST], "pools": [
    {"type_id": 3, "pool_id": 10, "featured": [1], "kind": "doll"},
    {"type_id": 3, "pool_id": 11, "featured": [3], "kind": "doll"},
    {"type_id": 4, "pool_id": 20, "featured": [4], "kind": "weapon"},
]}
FIXED_RULES = dict(RULES, fixed_loss_pools=[
    {"type_id": 3, "kind": "doll", "item_ids": [2]},
    {"type_id": 4, "kind": "weapon", "item_ids": [5]},
])


def pull(item=1, *, rarity="Elite", type_id=3, pool_id=10, gap=False, kind=None):
    return dict(item_id=item, rarity=rarity, type_id=type_id, pool_id=pool_id,
                kind=kind or ("unknown" if item == 999 else "weapon" if type_id == 4 else "doll"),
                gap_before=gap, timestamp="2024-12-03T00:00:00Z")


def derive(*chronological, host=HOST, rules=RULES):
    rows = list(reversed(chronological))
    for i, row in enumerate(rows):
        row["timestamp_order"] = i
    annotate_banner_outcomes(rows, host, rules)
    return [row["banner_result"] for row in reversed(rows)]


def test_initial_featured_is_unknown_then_loss_guaranteed_and_win():
    results = derive(pull(), pull(8, rarity="Standard"), pull(2), pull(), pull())
    assert [r["outcome"] for r in results] == ["unknown", "not_applicable", "loss", "guaranteed", "win"]
    assert [r["guarantee_after"] for r in results] == [False, False, True, False, False]
    assert [r["featured_pity"] for r in results] == [None, None, None, 3, 1]
    assert results[0]["reason"] == "unknown_start"


def test_first_off_banner_proves_a_loss_despite_unknown_initial_guarantee():
    result = derive(pull(2))[0]
    assert result == dict(featured=False, outcome="loss", guarantee_before=False,
                          guarantee_after=True, featured_pity=None, reason=None)


def test_equal_timestamp_uses_reverse_source_order_not_item_id():
    newest_first = [pull(1), pull(2), pull(1)]
    for i, row in enumerate(newest_first):
        row["timestamp_order"] = i
    annotate_banner_outcomes(newest_first, HOST, RULES)
    assert [row["banner_result"]["outcome"] for row in newest_first] == ["guaranteed", "loss", "unknown"]
    assert newest_first[0]["banner_result"]["featured_pity"] == 2


@pytest.mark.parametrize("boundary, reason", [
    (pull(8, rarity="Standard", gap=True), "history_gap"),
    (pull(8, rarity="Unknown"), "unknown_item"),
    (pull(8, rarity="Standard", pool_id=999), "unknown_pool"),
    (pull(8, pool_id=999), "unknown_pool"),
    (pull(999), "unknown_item"),
])
def test_unknown_boundaries_reset_guarantee_and_featured_interval(boundary, reason):
    results = derive(pull(), pull(2), boundary, pull(), pull())
    assert results[2]["guarantee_after"] is None
    assert results[3]["outcome"] == "unknown"
    assert results[3]["reason"] == reason
    assert results[3]["featured_pity"] is None
    assert results[4]["outcome"] == "win"
    assert results[4]["featured_pity"] == 1


def test_pool_carry_and_type_isolation():
    results = derive(pull(), pull(2), pull(4, type_id=4, pool_id=20),
                     pull(3, pool_id=11), pull(5, type_id=4, pool_id=20), pull())
    assert [r["outcome"] for r in results] == ["unknown", "loss", "unknown", "guaranteed", "loss", "win"]
    assert results[3]["featured_pity"] == 2
    assert results[5]["featured_pity"] == 1


def test_contradictory_off_banner_breaks_featured_interval():
    results = derive(pull(), pull(2), pull(2), pull(), pull())
    assert results[2] == dict(featured=False, outcome="unknown", guarantee_before=True,
                              guarantee_after=True, featured_pity=None, reason="guarantee_conflict")
    assert results[3]["outcome"] == "guaranteed"
    assert results[3]["featured_pity"] is None
    assert results[4]["featured_pity"] == 1


def test_provider_and_type_are_explicitly_scoped():
    assert derive(pull(), host="unknown.example")[0]["reason"] == "unknown_provider"
    result = derive(pull(type_id=1))[0]
    assert result["outcome"] == "not_applicable"
    assert result["reason"] == "unsupported_type"
    assert result["featured"] is None
    assert derive(pull(kind="weapon"))[0]["reason"] == "unknown_item"


def test_reused_pool_requires_unique_date_window():
    rules = {"hosts": [HOST], "pools": [
        dict(RULES["pools"][0], start="2024-01-01T00:00:00Z", end="2025-01-01T00:00:00Z"),
        dict(RULES["pools"][0], featured=[3], start="2025-01-01T00:00:00Z", end="2026-01-01T00:00:00Z"),
    ]}
    for date, item, featured in (("2024-01-01T00:00:00Z", 1, True),
                                  ("2025-01-01T00:00:00Z", 3, True),
                                  ("2025-01-01T00:00:00Z", 1, False),
                                  ("2026-01-01T00:00:00Z", 3, None)):
        row = dict(pull(item), timestamp=date)
        annotate_banner_outcomes([row], HOST, rules)
        assert row["banner_result"]["featured"] is featured
    rules["pools"].append(rules["pools"][0])
    row = pull()
    annotate_banner_outcomes([row], HOST, rules)
    assert row["banner_result"]["reason"] == "unknown_pool"


def test_fixed_loss_pool_classifies_without_banner_mapping_and_carries_across_pools():
    results = derive(pull(pool_id=999), pull(2, pool_id=999),
                     pull(8, rarity="Standard", pool_id=998, kind="weapon"),
                     pull(3, pool_id=998), pull(6, pool_id=997),
                     pull(8, rarity="Standard", pool_id=996), rules=FIXED_RULES)
    assert [r["outcome"] for r in results] == [
        "unknown", "loss", "not_applicable", "guaranteed", "win", "not_applicable"]
    assert results[0]["featured"] is True
    assert results[0]["reason"] == "unknown_start"
    assert results[1]["featured"] is False
    assert results[2]["guarantee_after"] is True
    assert results[3]["featured_pity"] == 3
    assert results[4]["featured_pity"] == 1
    assert results[5]["guarantee_after"] is False


@pytest.mark.parametrize("pools", [
    [],
    [dict(RULES["pools"][0], end="2024-12-03T00:00:00Z")],
    [dict(RULES["pools"][0], start="2025-01-01T00:00:00Z")],
    [RULES["pools"][0], RULES["pools"][0]],
])
def test_fixed_loss_pool_applies_without_a_unique_active_banner(pools):
    results = derive(pull(2), pull(3), rules=dict(FIXED_RULES, pools=pools))
    assert [r["outcome"] for r in results] == ["loss", "guaranteed"]


def test_unique_dated_pool_takes_precedence_over_fixed_loss_pool():
    rules = dict(FIXED_RULES, pools=[dict(RULES["pools"][0], featured=[2],
                 start="2024-01-01T00:00:00Z", end="2025-01-01T00:00:00Z")])
    results = derive(pull(3), pull(2), rules=rules)
    assert [r["featured"] for r in results] == [False, True]
    assert [r["outcome"] for r in results] == ["loss", "guaranteed"]


@pytest.mark.parametrize("item", [2, 3])
def test_fixed_loss_pool_cannot_infer_expired_standard_featured_banners(item):
    rules = dict(FIXED_RULES, pools=[dict(RULES["pools"][0], featured=[2],
                 end="2024-12-03T00:00:00Z")])
    result = derive(pull(item), rules=rules)[0]
    assert result["featured"] is None
    assert result["outcome"] == "unknown"
    assert result["reason"] == "unknown_pool"


def test_standard_featured_banner_exclusion_is_scoped_to_type_and_pool():
    rules = dict(FIXED_RULES, pools=[dict(RULES["pools"][0], featured=[2],
                 end="2024-12-03T00:00:00Z")])
    result = derive(pull(2, pool_id=999), rules=rules)[0]
    assert result["outcome"] == "loss"
    weapon = derive(pull(5, type_id=4), rules=rules)[0]
    assert weapon["outcome"] == "loss"


@pytest.mark.parametrize("boundary, reason", [
    (pull(8, rarity="Standard", pool_id=999, gap=True), "history_gap"),
    (pull(8, rarity="Unknown", pool_id=999), "unknown_item"),
    (pull(999, pool_id=999), "unknown_item"),
    (pull(3, kind="weapon", pool_id=999), "unknown_item"),
])
def test_fixed_loss_pool_preserves_unknown_boundaries(boundary, reason):
    results = derive(pull(pool_id=999), pull(2, pool_id=999), boundary,
                     pull(3, pool_id=999), pull(3, pool_id=999), rules=FIXED_RULES)
    assert results[2]["featured"] is None
    assert results[2]["guarantee_after"] is None
    assert results[3]["featured"] is True
    assert results[3]["outcome"] == "unknown"
    assert results[3]["reason"] == reason
    assert results[3]["featured_pity"] is None
    assert results[4]["outcome"] == "win"


def test_fixed_loss_pool_preserves_provider_and_type_scope_and_isolates_guarantees():
    assert derive(pull(pool_id=999), host="unknown.example", rules=FIXED_RULES)[0]["reason"] == "unknown_provider"
    assert derive(pull(type_id=1, pool_id=999), rules=FIXED_RULES)[0]["reason"] == "unsupported_type"
    results = derive(pull(2, pool_id=999), pull(4, type_id=4, pool_id=999),
                     pull(3, pool_id=999), pull(5, type_id=4, pool_id=999),
                     pull(4, type_id=4, pool_id=998), rules=FIXED_RULES)
    assert [r["outcome"] for r in results] == ["loss", "unknown", "guaranteed", "loss", "guaranteed"]


def test_fixed_loss_pool_requires_a_unique_active_time_window():
    rules = dict(RULES, pools=[], fixed_loss_pools=[
        dict(FIXED_RULES["fixed_loss_pools"][0], start="2024-01-01T00:00:00Z", end="2025-01-01T00:00:00Z"),
        dict(FIXED_RULES["fixed_loss_pools"][0], item_ids=[2, 3],
             start="2025-01-01T00:00:00Z", end="2026-01-01T00:00:00Z"),
    ])
    for timestamp, featured in (("2023-12-31T23:59:59Z", None),
                                ("2024-01-01T00:00:00Z", True),
                                ("2025-01-01T00:00:00Z", False),
                                ("2026-01-01T00:00:00Z", None)):
        result = derive(dict(pull(3, pool_id=999), timestamp=timestamp), rules=rules)[0]
        assert result["featured"] is featured
    rules["fixed_loss_pools"].append(rules["fixed_loss_pools"][0])
    assert derive(pull(pool_id=999), rules=rules)[0]["reason"] == "unknown_pool"


def test_fixed_loss_pool_keeps_current_guarantee_after_trailing_ordinary_pulls():
    rows = [pull(8, rarity="Standard", pool_id=997, kind="weapon"),
            pull(8, rarity="Standard", pool_id=998), pull(2, pool_id=999)]
    for i, row in enumerate(rows):
        row["timestamp_order"] = i
    annotate_banner_outcomes(rows, HOST, FIXED_RULES)
    summary = summarize_banner_outcomes(rows)
    assert summary["current_guarantee"] is True
    assert summary["losses"] == 1
    assert summary["off_banner_count"] == 1


def test_summary_distinguishes_unknown_identity_and_unknown_outcome():
    rows = [pull(999), pull(), pull(), pull(2), pull()]
    for i, row in enumerate(rows):
        row["timestamp_order"] = i
    annotate_banner_outcomes(rows, HOST, RULES)
    assert summarize_banner_outcomes(rows) == dict(featured_count=3, off_banner_count=1,
        wins=1, losses=1, guaranteed=1, unknown_elites=1, unknown_outcomes=2,
        featured_intervals=[1, 2], current_guarantee=None)
    assert summarize_banner_outcomes([])["current_guarantee"] is None


def test_shared_browser_fixture_has_identical_outcomes_and_summary():
    fixture = json.loads((Path(__file__).resolve().parents[1] / "web/tests/banner-parity.json").read_text())
    rows = [dict(id=i + 1, item_id=1039, kind="doll", rarity="Elite", type_id=3,
                 pool_id=101, timestamp="2025-01-15T12:00:00Z", timestamp_order=99 - i,
                 gap_before=False) | overrides
            for i, overrides in enumerate(fixture["chronological"])]
    rows.reverse()
    annotate_banner_outcomes(rows, HOST, fixture["rules"])
    assert [row["banner_result"] for row in reversed(rows)] == fixture["expected"]
    assert summarize_banner_outcomes(rows) == fixture["summary"]


def test_tracker_derives_before_history_filters_and_rewards_pagination(tmp_path, monkeypatch):
    monkeypatch.setattr(banner_outcomes, "load_banner_rules", lambda: RULES)
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"items": [dict(id=i, name=str(i), kind="doll", rarity=rarity)
                                            for i, rarity in ((1, "Elite"), (2, "Elite"), (8, "Standard"))]}))
    with TestClient(create_app(tmp_path, catalog_path=catalog), base_url="http://127.0.0.1:8000") as client:
        profile = client.post("/api/profiles", json={"name": "test"}).json()["id"]
        doc = dict(schema_version=1, exported_at="2026-01-01T00:00:00Z",
                   account_fingerprint="sha256:" + "a" * 64, endpoint_host=HOST,
                   records=[dict(source_type_id=3, source_page=1,
                                 record=dict(item=item, pool_id=10, time=1767225600, item_num=1))
                            for item in (1, 2, 8, 1)])
        assert client.post("/api/imports", json={"profile_id": profile, "records_document": doc}).status_code == 201
        all_rows = client.get("/api/history", params={"profile_id": profile}).json()["items"]
        selected = client.get("/api/history", params={"profile_id": profile, "q": "1"}).json()["items"]
        assert selected == [row for row in all_rows if row["item_id"] == 1]
        assert selected[0]["banner_result"]["outcome"] == "guaranteed"
        assert selected[0]["banner_result"]["featured_pity"] == 3
        rewards = client.get("/api/rewards", params={"profile_id": profile, "limit": 1}).json()
        filtered = client.get("/api/rewards", params={"profile_id": profile, "rarity": "Standard"}).json()
        assert rewards["featured"] == filtered["featured"]
        assert rewards["featured"]["guaranteed"] == 1
        empty = client.post("/api/profiles", json={"name": "empty"}).json()["id"]
        assert client.get("/api/rewards", params={"profile_id": empty}).json()["featured"] == summarize_banner_outcomes([])


def test_production_fixed_loss_browser_server_window_parity():
    from backend.statistics_comparison import comparison_sequences
    fixture = json.loads((Path(__file__).parents[1] / "web/tests/fixed-loss-parity.json").read_text())
    rows = [dict(pull(), **row, timestamp_order=100 - i, timestamp="2026-09-01T00:00:00Z", pool_id=999999,
                 pity=1, pity_uncertain=False) for i, row in enumerate(fixture["chronological"])]
    rows.reverse()
    annotate_banner_outcomes(rows, HOST)
    results = [row["banner_result"] for row in reversed(rows)]
    for key in ("guarantee_after", "featured_pity"):
        assert [row[key] for row in results] == fixture[key]
    assert [row["outcome"] for row in results] == fixture["outcomes"]
    window = comparison_sequences(rows)["featured"]
    assert window["values"] == [0, 0, 1, 1, 0]
