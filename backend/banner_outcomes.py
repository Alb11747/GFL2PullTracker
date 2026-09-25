"""Conservative featured and guarantee inference from documented pool rules.

Derivation uses complete history, never filtered display rows. A catalog rarity
or an unrecognized item alone cannot establish that a reward was featured.
"""
from collections import defaultdict
import json
from pathlib import Path


def load_banner_rules():
    path = Path(__file__).with_name("banner_rules.json")
    return json.loads(path.read_text(encoding="utf-8"))


def annotate_banner_outcomes(rows, endpoint_host, rules=None):
    """Mutate newest-first rows after coverage annotation, before filtering.

    Source order at equal timestamps is already newest-first. Reverse it along
    with timestamps, preserving the source's ordering of individual rewards.
    Initial guarantee is unknown even for history beginning on launch day.
    """
    rules = load_banner_rules() if rules is None else rules
    provider_known = endpoint_host in rules["hosts"]
    pools = defaultdict(list)
    for pool in rules["pools"]:
        pools[(pool["type_id"], pool["pool_id"])].append(pool)
    fixed_loss_pools = defaultdict(list)
    for pool in rules.get("fixed_loss_pools", []):
        fixed_loss_pools[pool["type_id"]].append(pool)
    by_type = defaultdict(list)
    for row in rows:
        by_type[row["type_id"]].append(row)
    for type_id, newest_first in by_type.items():
        guarantee = None
        interval = None
        uncertainty = "unknown_start"
        chronological = sorted(newest_first, key=lambda row: (
            row["timestamp"], -row.get("timestamp_order", 0), -row.get("id", 0)))
        for row in chronological:
            result = dict(featured=None, outcome="not_applicable", guarantee_before=None,
                          guarantee_after=None, featured_pity=None, reason=None)
            row["banner_result"] = result
            if type_id not in (3, 4):
                result["reason"] = "unsupported_type"
                continue
            if row.get("gap_before") or row["rarity"] == "Unknown":
                guarantee, interval = None, None
                uncertainty = "history_gap" if row.get("gap_before") else "unknown_item"
            matching = [pool for pool in pools[(type_id, row["pool_id"])]
                        if (not pool.get("start") or row["timestamp"] >= pool["start"])
                        and (not pool.get("end") or row["timestamp"] < pool["end"])]
            pool = matching[0] if len(matching) == 1 else None
            fixed_candidates = [candidate for candidate in fixed_loss_pools[type_id]
                                if (not candidate.get("start") or row["timestamp"] >= candidate["start"])
                                and (not candidate.get("end") or row["timestamp"] < candidate["end"])]
            fixed_pool = fixed_candidates[0] if len(fixed_candidates) == 1 else None
            if pool is None and fixed_pool is not None and any(
                    item in fixed_pool["item_ids"]
                    for candidate in pools[(type_id, row["pool_id"])]
                    for item in candidate["featured"]):
                # A rerun of a standard Elite needs exact dates to distinguish
                # featured rewards from the same item appearing as a loss.
                fixed_pool = None
            classification_pool = pool if pool is not None else fixed_pool
            unknown = ("unknown_provider" if not provider_known else
                       "unknown_pool" if classification_pool is None else None)
            if unknown:
                guarantee, interval, uncertainty = None, None, unknown
                result.update(outcome="unknown" if row["rarity"] == "Elite" else "not_applicable",
                              reason=unknown)
                continue
            if interval is not None:
                interval += 1
            result.update(guarantee_before=guarantee, guarantee_after=guarantee)
            if row["rarity"] != "Elite":
                if row["rarity"] == "Unknown":
                    result["reason"] = uncertainty
                continue
            off_banner = row.get("kind") == classification_pool["kind"]
            # A documented fixed loss roster also identifies featured Elites when
            # historical banner dates are unavailable. Exact dated pools win.
            featured = off_banner and (row["item_id"] in pool["featured"] if pool is not None
                                       else row["item_id"] not in fixed_pool["item_ids"])
            if not featured and not off_banner:
                # A catalog unknown or mismatched reward kind cannot prove a loss.
                guarantee, interval, uncertainty = None, None, "unknown_item"
                result.update(outcome="unknown", guarantee_after=None, reason=uncertainty)
            elif featured:
                result.update(featured=True, outcome="guaranteed" if guarantee is True else
                              "win" if guarantee is False else "unknown",
                              guarantee_after=False, featured_pity=interval,
                              reason=uncertainty if guarantee is None else None)
                guarantee, interval, uncertainty = False, 0, None
            elif guarantee is True:
                result.update(featured=False, outcome="unknown", guarantee_after=True,
                              reason="guarantee_conflict")
                guarantee, interval, uncertainty = True, None, None
            else:
                # A known off-banner Elite proves this draw was not guaranteed.
                result.update(featured=False, outcome="loss", guarantee_before=False,
                              guarantee_after=True, reason=None)
                guarantee, uncertainty = True, None
    return rows


def summarize_banner_outcomes(rows):
    """Summarize a complete newest-first recruitment type, independently of UI filters."""
    elites = [row["banner_result"] for row in rows
              if row["rarity"] == "Elite" and row["type_id"] in (3, 4) and row.get("banner_result")]
    latest = rows[0].get("banner_result") if rows else None
    return dict(featured_count=sum(result["featured"] is True for result in elites),
                off_banner_count=sum(result["featured"] is False for result in elites),
                wins=sum(result["outcome"] == "win" for result in elites),
                losses=sum(result["outcome"] == "loss" for result in elites),
                guaranteed=sum(result["outcome"] == "guaranteed" for result in elites),
                unknown_elites=sum(result["featured"] is None for result in elites),
                unknown_outcomes=sum(result["outcome"] == "unknown" for result in elites),
                featured_intervals=[result["featured_pity"] for result in elites
                                    if result["featured"] is True and result["featured_pity"] is not None],
                current_guarantee=latest["guarantee_after"] if latest else None)
