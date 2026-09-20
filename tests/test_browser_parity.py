"""Browser and Python consume the same synthetic ordering/coverage examples."""
import json
from pathlib import Path

import pytest

from backend.database import Profile, open_database
from backend.tracker import Tracker, now


FIXTURES = json.loads((Path(__file__).parents[1] / "web/tests/local-parity.json").read_text())


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda fixture: fixture["name"])
def test_browser_python_shared_snapshot_contract(tmp_path, fixture):
    engine, sessions = open_database(tmp_path / "parity.db")
    try:
        tracker = Tracker(sessions)
        with sessions.begin() as session:
            session.add(Profile(id="parity", owner_id="local", name="Synthetic", created_at=now()))
        for snapshot in fixture["snapshots"]:
            rows = [
                {
                    "source_type_id": row.get("type", 3),
                    "source_page": row.get("page", 1),
                    "record": {"item": row["item"], "pool_id": 224001,
                               "item_num": row.get("quantity", 1), "time": row.get("time", 1784800558)},
                }
                for row in snapshot
            ]
            tracker.import_snapshot("parity", {
                "schema_version": 1, "exported_at": "2026-07-26T17:57:48Z",
                "account_fingerprint": "sha256:" + "a" * 64,
                "endpoint_host": "gf2-gacha-record-us.sunborngame.com", "records": rows,
            })
        history = tracker.history("parity", {})
        assert len(history) == fixture["expected_total"]
        assert [row["item_id"] for row in history] == fixture["expected_items"]
        for expectation, field in (("expected_pity", "pity"), ("expected_uncertain", "pity_uncertain"), ("expected_gaps", "gap_before")):
            if expectation in fixture:
                assert [row[field] for row in history] == fixture[expectation]
    finally:
        engine.dispose()
