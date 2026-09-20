import base64
import json
import sqlite3
from threading import Event

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import event, select, text

from backend.app import create_app
from backend import database
from backend.database import Job, Profile, Pull, Snapshot, open_database
from backend.tracker import now
from scripts import fetch_pull_history as collector


def record(item=11007, *, time=1784800558, type_id=3, quantity=1, page=1, pool=224001):
    return {"source_type_id": type_id, "source_page": page, "record": {"pool_id": pool, "item": item, "time": time, "item_num": quantity}}


def document(records, **metadata):
    return {"schema_version": 1, "exported_at": "2026-07-26T17:57:48Z", "account_fingerprint": "sha256:" + "a" * 64,
            "endpoint_host": "gf2-gacha-record-us.sunborngame.com", "records": records, **metadata}


def manifest(doc, complete=True):
    types = {}
    for row in doc["records"]:
        entry = types.setdefault(str(row["source_type_id"]), {"records": 0, "pages": 0, "status": "complete" if complete else "error"})
        entry["records"] += 1
        entry["pages"] = max(entry["pages"], row["source_page"])
    return {"schema_version": doc["schema_version"], "started_at": doc["exported_at"], "completed_at": "2026-07-26T17:58:48Z", "complete": complete,
            "types": types, **{k: doc[k] for k in ("account_fingerprint", "endpoint_host", "server", "game_channel_id") if k in doc}}


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path), base_url="http://127.0.0.1:8000") as client:
        yield client


def profile(client, name="Commander"):
    response = client.post("/api/profiles", json={"name": name})
    assert response.status_code == 201
    return response.json()["id"]


def load(client, profile_id, doc, **kwargs):
    return client.post("/api/imports", json={"profile_id": profile_id, "records_document": doc, **kwargs})


def test_occurrence_merge_overlap_idempotence_and_type_isolation(client):
    p = profile(client)
    one = document([record(), record(), record(11008)])
    assert load(client, p, one).json()["added_count"] == 3
    assert load(client, p, one).json() == {**load(client, p, one).json(), "duplicate": True, "added_count": 0}
    overlap = document([record(), record(), record(), record(11009), record(type_id=6)])
    merged = load(client, p, overlap).json()
    assert merged["total"] == 6 and merged["added_count"] == 3
    assert load(client, p, document([record()])).json()["total"] == 6
    assert client.get("/api/history", params={"profile_id": p, "type_id": 6}).json()["total"] == 1


def test_stable_timestamp_order_survives_partial_imports_and_overlap(client):
    p = profile(client)
    assert load(client, p, document([record(11007), record(11008), record(11009)])).json()["added_count"] == 3
    # Interior subsets must not move their records to the front of a full group.
    load(client, p, document([record(11008)]))
    load(client, p, document([record(11006), record(11007), record(11008)]))
    load(client, p, document([record(11008), record(11010), record(11009)]))
    rows = client.get("/api/history", params={"profile_id": p}).json()["items"]
    assert [r["item_id"] for r in rows] == [11006, 11007, 11008, 11010, 11009]
    assert [r["timestamp_order"] for r in rows] == list(range(5))
    # Even contradictory source subsets cannot reverse the established order.
    load(client, p, document([record(11009), record(11007)]))
    assert client.get("/api/history", params={"profile_id": p}).json()["items"] == rows


def test_exilium_oldest_first_normalization_keeps_occurrences(client):
    p = profile(client)
    doc = document([record(11007), record(11008), record(11007), record(11009)],
                   external_source={"source": "https://exilium.xyz"})
    assert load(client, p, doc).json()["added_count"] == 4
    rows = client.get("/api/history", params={"profile_id": p}).json()["items"]
    assert [r["item_id"] for r in rows] == [11009, 11007, 11008, 11007]
    assert load(client, p, document([record(11009), record(11007), record(11008), record(11007)])).json()["added_count"] == 0
    assert client.get("/api/history", params={"profile_id": p}).json()["items"] == rows


def test_incremental_response_provenance_retains_overlap_without_importing_it(client):
    p = profile(client)
    doc = document([record()])
    pages = {
        "raw/type_3/page_1.json": json.dumps({"data": {"list": [record()["record"]]}}),
        "responses/type_3/page_1.json": json.dumps({"data": {"list": [record()["record"], record(11008)["record"]]}}),
    }
    assert load(client, p, doc, raw_pages=pages).json()["added_count"] == 1
    assert client.get("/api/history", params={"profile_id": p}).json()["total"] == 1
    pages["responses/type_3/page_1.json"] = json.dumps({"data": {"list": [], "token": "synthetic-secret"}})
    assert load(client, p, doc, raw_pages=pages).status_code == 422
    del pages["responses/type_3/page_1.json"]
    pages["responses/../page_1.json"] = json.dumps({"data": {"list": []}})
    assert load(client, p, doc, raw_pages=pages).status_code == 422


def test_v1_migration_recovers_source_order_and_is_repeatable(tmp_path, monkeypatch):
    with TestClient(create_app(tmp_path), base_url="http://127.0.0.1:8000") as client:
        p = profile(client)
        load(client, p, document([record(11007), record(11008), record(11007)],
                               external_source={"source": "https://exilium.xyz"}))
        load(client, p, document([record(11009), record(11007), record(11008), record(11007)]))
        engine = client.app.state.tracker.sessions.kw["bind"]
        path = engine.url.database
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE pulls DROP COLUMN timestamp_order"))
            connection.execute(text("PRAGMA user_version=1"))
    engine.dispose()
    def fail_backfill(connection):
        raise RuntimeError("Simulated backfill failure")
    with monkeypatch.context() as patch:
        patch.setattr(database, "backfill_timestamp_order", fail_backfill)
        with pytest.raises(RuntimeError, match="Simulated backfill failure"):
            open_database(path)
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 1
        assert "timestamp_order" not in {row[1] for row in connection.execute("PRAGMA table_info(pulls)")}
    for _ in range(2):
        migrated, sessions = open_database(path)
        with sessions() as session:
            assert session.execute(text("PRAGMA user_version")).scalar_one() == 2
            pulls = list(session.scalars(select(Pull).order_by(Pull.timestamp_order)))
            assert [pull.item_id for pull in pulls] == [11009, 11007, 11008, 11007]
            assert [pull.timestamp_order for pull in pulls] == list(range(4))
            assert len(list(session.scalars(select(Snapshot)))) == 2
        migrated.dispose()


def test_validation_rolls_back_identity_and_records(client):
    p = profile(client)
    doc = document([record(), record()], account_fingerprint="sha256:" + "b" * 64)
    doc["records"][1]["record"]["time"] = -1
    assert load(client, p, doc).status_code == 422
    assert client.get("/api/profiles").json()["profiles"][0]["account_fingerprint"] is None
    assert client.get("/api/history", params={"profile_id": p}).json()["total"] == 0
    assert client.get("/api/imports", params={"profile_id": p}).json()["imports"] == []


def test_database_failure_rolls_back_entire_snapshot(client):
    p = profile(client)
    def fail_insert(mapper, connection, target):
        raise RuntimeError("Simulated storage failure")
    event.listen(Pull, "before_insert", fail_insert)
    try:
        with pytest.raises(RuntimeError, match="Simulated storage failure"):
            client.app.state.tracker.import_snapshot(p, document([record()]))
    finally:
        event.remove(Pull, "before_insert", fail_insert)
    with client.app.state.tracker.sessions() as session:
        assert session.scalar(select(Snapshot)) is None
        assert session.scalar(select(Pull)) is None
        assert session.get(Profile, p).account_fingerprint is None


def test_profile_identity_and_legacy_explicit_assignment(client):
    p, other = profile(client), profile(client, "Second account")
    assert client.post("/api/imports", json={"records_document": document([])}).status_code == 422
    known = document([record()])
    assert load(client, p, known).status_code == 201
    assert load(client, p, {**known, "account_fingerprint": "sha256:" + "b" * 64}).status_code == 409
    assert load(client, other, {**known, "account_fingerprint": "sha256:" + "b" * 64}).status_code == 201
    version2 = {**known, "schema_version": 2, "server": "10", "game_channel_id": "5"}
    assert load(client, p, version2).status_code == 201
    assert load(client, p, {**version2, "server": "11"}).status_code == 409
    assert client.get("/api/history", params={"profile_id": other}).json()["total"] == 1


def test_partial_snapshot_and_raw_archive_roundtrip(client):
    p = profile(client)
    doc = document([record()])
    raw = {'raw/type_0003/page_0001.json': json.dumps({"code": 0, "data": {"list": [doc["records"][0]["record"]], "next": "opaque-cursor"}})}
    result = load(client, p, doc, manifest=manifest(doc, False), raw_pages=raw)
    assert result.status_code == 201 and result.json()["complete"] is False
    with client.app.state.tracker.sessions() as session:
        stored = session.get(Snapshot, result.json()["id"])
        assert json.loads(stored.document) == doc
        assert json.loads(stored.raw_pages) == raw
    stats = client.get("/api/statistics", params={"profile_id": p}).json()
    assert stats["latest_import_complete"] is False
    assert stats["coverage"] == "accessible_history_only"


@pytest.mark.parametrize("mutation", ["count", "page", "status", "status_type", "date", "raw_secret", "raw_path", "raw_mismatch", "raw_missing"])
def test_reject_inconsistent_archives(client, mutation):
    p = profile(client)
    doc = document([record()])
    meta = manifest(doc)
    raw = {"raw/type_0003/page_0001.json": {"data": {"list": [doc["records"][0]["record"]]}}}
    if mutation == "count": meta["types"]["3"]["records"] = 2
    if mutation == "page": meta["types"]["3"]["pages"] = 0
    if mutation == "status": meta["types"]["3"]["status"] = "in_progress"
    if mutation == "status_type": meta["types"]["3"]["status"] = []
    if mutation == "date": meta["started_at"] = "2026-01-01"
    if mutation == "raw_secret": raw = {"raw/type_0003/page_0001.json": '{"authorization":"secret","data":{"list":[]}}'}
    if mutation == "raw_path": raw = {"../../secret.json": raw.pop("raw/type_0003/page_0001.json")}
    if mutation == "raw_mismatch": raw["raw/type_0003/page_0001.json"]["data"]["list"] = []
    if mutation == "raw_missing": raw = {}
    assert load(client, p, doc, manifest=meta, raw_pages=raw).status_code == 422
    assert client.get("/api/imports", params={"profile_id": p}).json()["imports"] == []


def test_statistics_match_full_filtered_history_and_unknowns(client):
    p = profile(client)
    doc = document([record(), record(), record(11008), record(999999, type_id=6, quantity=50)])
    assert load(client, p, doc).status_code == 201
    params = {"profile_id": p, "q": "11007", "kind": "weapon", "type_id": 3, "pool_id": 224001, "date_from": "2026-07-23", "date_to": "2026-07-23"}
    history = client.get("/api/history", params={**params, "page_size": 1}).json()
    stats = client.get("/api/statistics", params=params).json()
    assert len(history["items"]) == 1 and history["total"] == stats["total"] == 2
    assert stats["known_total"] == 2 and sum(r["count"] for r in stats["rarities"]) == 2
    unknown = client.get("/api/history", params={"profile_id": p, "kind": "unknown"}).json()["items"][0]
    assert unknown["name"] == "Unknown item #999999" and unknown["rarity"] == "Unknown" and unknown["quantity"] == 50
    assert client.get("/api/statistics", params={"profile_id": p}).json()["total"] == 4
    assert client.get("/api/statistics", params={"profile_id": p, "date_from": "2026-08-01", "date_to": "2026-07-01"}).status_code == 422


def capture():
    metadata = base64.urlsafe_b64encode(json.dumps({"uid": 0, "tinx": 10, "expires": 4102444800}).encode()).decode()
    return ("POST https://gf2-gacha-record-us.sunborngame.com/list?game_channel_id=5&type_id=3&u=synthetic-account@example.invalid HTTP/1.1\r\n"
            "Host: gf2-gacha-record-us.sunborngame.com\r\n"
            f"Authorization: {metadata}.synthetic-secret-signature\r\n"
            "Content-Type: application/x-www-form-urlencoded\r\nContent-Length: 9\r\n\r\nserver=10")


class FakeClient:
    mode = "success"
    def __init__(self, prepared, **kwargs):
        self.prepared = prepared
        self.calls = 0

    def request(self, type_id, next_cursor=None):
        self.calls += 1
        if self.mode == "failed" or (self.mode == "partial" and self.calls > 1):
            raise collector.FetchError("synthetic-secret-signature synthetic-account@example.invalid")
        rows = [record()["record"]] if type_id == 3 else []
        body = json.dumps({"code": 0, "data": {"list": rows, "next": "next-page" if self.mode == "partial" else ""}}).encode()
        return collector.HttpResponse(200, "OK", {}, body)


@pytest.mark.parametrize("mode, expected, total", [("success", "completed", 1), ("failed", "failed", 0), ("partial", "partial", 1)])
def test_fetch_status_partial_retention_and_no_credential_persistence(tmp_path, mode, expected, total):
    factory = type("TestClient", (FakeClient,), {"mode": mode})
    with TestClient(create_app(tmp_path, client_factory=factory), base_url="http://127.0.0.1:8000") as client:
        p = profile(client)
        response = client.post("/api/fetch", json={"profile_id": p, "capture": capture()})
        assert response.status_code == 202, response.text
        for thread in client.app.state.jobs.threads:
            thread.join(timeout=10)
            assert not thread.is_alive()
        job = client.get(f'/api/jobs/{response.json()["id"]}').json()
        assert job["status"] == expected, job
        assert client.get("/api/history", params={"profile_id": p}).json()["total"] == total
    for path in tmp_path.rglob("*"):
        if path.is_file():
            contents = path.read_bytes()
            assert b"synthetic-secret-signature" not in contents
            assert b"synthetic-account@example.invalid" not in contents


def test_fetch_gate_and_identity_validation_before_network(tmp_path):
    gate, entered = Event(), Event()
    class BlockingClient(FakeClient):
        def request(self, *args, **kwargs):
            entered.set()
            assert gate.wait(10)
            return super().request(*args, **kwargs)
    with TestClient(create_app(tmp_path, client_factory=BlockingClient), base_url="http://127.0.0.1:8000") as client:
        p = profile(client)
        try:
            assert client.post("/api/fetch", json={"profile_id": p, "capture": capture()}).status_code == 202
            assert entered.wait(5)
            assert client.post("/api/fetch", json={"profile_id": p, "capture": capture()}).status_code == 409
        finally:
            gate.set()
            for thread in client.app.state.jobs.threads: thread.join(10)
        mismatched = capture().replace("synthetic-account@", "other-account@")
        assert client.post("/api/fetch", json={"profile_id": p, "capture": mismatched}).status_code == 409


def test_restart_marks_active_jobs_interrupted(tmp_path):
    with TestClient(create_app(tmp_path), base_url="http://127.0.0.1:8000") as client:
        p = profile(client)
        with client.app.state.tracker.sessions.begin() as session:
            session.add(Job(id="unfinished", profile_id=p, status="running", message="Collecting", records=5, pages=1, created_at=now(), updated_at=now()))
    with TestClient(create_app(tmp_path), base_url="http://127.0.0.1:8000") as client:
        job = client.get("/api/jobs/unfinished").json()
        assert job["status"] == "interrupted" and job["records"] == 5 and "fresh capture" in job["message"]


def test_local_security_and_validation_redaction(client):
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 400
    assert client.post("/api/profiles", json={"name": "x"}, headers={"origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/profiles", json={"name": "x"}, headers={"sec-fetch-site": "cross-site"}).status_code == 403
    assert client.post("/api/profiles", content='{"name":"x"}', headers={"content-type": "text/plain"}).status_code == 415
    bad = client.post("/api/fetch", json={"profile_id": "missing", "capture": {"secret": "do-not-echo"}})
    assert bad.status_code == 422 and "do-not-echo" not in bad.text
    assert client.post("/api/fetch", json={"profile_id": "missing", "capture": capture().replace("https://", "http://")}).status_code == 422
    malformed = capture().replace("sunborngame.com/list", "sunborngame.com:do-not-log-secret/list")
    result = client.post("/api/fetch", json={"profile_id": "missing", "capture": malformed})
    assert result.status_code == 422 and "do-not-log-secret" not in result.text
    with client.app.state.tracker.sessions() as session:
        assert session.execute(text("PRAGMA foreign_keys")).scalar_one() == 1


def test_new_collector_exports_have_nonsecret_server_channel_metadata(tmp_path):
    prepared = collector.prepare_request(collector.parse_capture(capture()))
    writer = collector.ExportWriter(tmp_path, prepared, start_type=1, consecutive_misses=10, max_type=1000, timeout=20, retries=3)
    saved = json.loads((writer.run_dir / "records.json").read_text())
    assert saved["schema_version"] == 2 and saved["server"] == "10" and saved["game_channel_id"] == "5"


def test_raw_bom_response_preserves_original_bytes(client):
    p = profile(client)
    doc = document([record()])
    raw = {"raw/type_0003/page_0001.json": "\ufeff" + json.dumps({"data": {"list": [doc["records"][0]["record"]]}})}
    result = load(client, p, doc, raw_pages=raw)
    assert result.status_code == 201
    with client.app.state.tracker.sessions() as session:
        assert json.loads(session.get(Snapshot, result.json()["id"]).raw_pages) == raw


def test_new_identical_tied_pull_preserves_complete_source_order(client):
    p = profile(client)
    assert load(client, p, document([record(11007), record(11008), record(11007)])).status_code == 201
    latest = document([record(11007), record(11007), record(11008), record(11007)])
    assert load(client, p, latest).json()["added_count"] == 1
    rows = client.get("/api/history", params={"profile_id": p}).json()["items"]
    assert [r["item_id"] for r in rows] == [11007, 11007, 11008, 11007]
    assert load(client, p, latest).json()["added_count"] == 0


def test_pity_gap_bridge_survives_filters_and_restart(client):
    p = profile(client)
    older = [record(11007, time=1700000002), record(1013, time=1700000001)]
    newer = [record(1015, time=1700000004), record(11007, time=1700000003)]
    for rows in (older, newer):
        assert load(client, p, document(rows)).status_code == 201
    params = {"profile_id": p, "rarity": "Elite", "page_size": 1}
    first = client.get("/api/history", params=params).json()["items"][0]
    assert first["pity"] == 3 and first["pity_uncertain"]
    bridge = document([newer[1], older[0]])
    assert load(client, p, bridge).json()["added_count"] == 0
    healed = client.get("/api/history", params=params).json()["items"][0]
    assert healed["pity"] == 3 and not healed["pity_uncertain"]
    # A new Tracker reconstructs coverage from persistent snapshots, not memory.
    from backend.tracker import Tracker
    tracker = Tracker(client.app.state.tracker.sessions)
    assert not tracker.history(p, {"rarity": "Elite"})[0]["pity_uncertain"]
