"""Validated snapshots, occurrence merging, and a shared filtered history view."""
from collections import Counter, defaultdict
from datetime import UTC, datetime
import hashlib
import json
import re
from pathlib import Path
from threading import RLock
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select

from backend.coverage import annotate_history
from backend.database import Profile, Pull, Snapshot, merge_source_order, source_records_newest_first
from scripts.fetch_pull_history import OFFICIAL_HOSTS


def now():
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def public(model):
    return {column.name: getattr(model, column.name) for column in model.__table__.columns}


IDENTITY = ("account_fingerprint", "endpoint_host", "server", "game_channel_id")


def bind_identity(profile, identity):
    for key in IDENTITY:
        value = identity.get(key)
        current = getattr(profile, key)
        if value is not None and current is not None and value != current:
            raise HTTPException(409, "This export or capture belongs to a different account, server, or channel. Choose another profile.")
    for key in IDENTITY:
        if identity.get(key) is not None:
            setattr(profile, key, identity[key])


def require_profile(session, profile_id):
    profile = session.get(Profile, profile_id)
    if profile is None or profile.owner_id != "local":
        raise HTTPException(404, "Profile not found")
    return profile


def no_credentials(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in {"authorization", "cookie", "token", "capture", "account_value", "original_url", "headers"}:
                raise HTTPException(422, "Import contains request credentials or headers; use collector exports only")
            no_credentials(child)
    elif isinstance(value, list):
        for child in value:
            no_credentials(child)


def positive_int(value, field, zero=False):
    if type(value) is not int or value < (0 if zero else 1) or value > 2**63 - 1:
        raise HTTPException(422, f"Invalid {field} in export")
    return value


def validate_date(value, label):
    try:
        if not isinstance(value, str) or datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, f"Invalid {label}: use an ISO timestamp with timezone") from None


def validate_document(document, manifest, raw_pages):
    no_credentials(document)
    no_credentials(manifest)
    no_credentials(raw_pages)
    if type(document.get("schema_version")) is not int or document["schema_version"] not in (1, 2):
        raise HTTPException(422, "Unsupported export schema version; expected 1 or 2")
    validate_date(document.get("exported_at"), "export date")
    records = document.get("records")
    if not isinstance(records, list) or len(records) > 500_000:
        raise HTTPException(422, "Export records must be an array of at most 500,000 records")
    identity = {}
    for key in IDENTITY:
        value = document.get(key)
        if value is not None and (not isinstance(value, str) or not value or len(value) > 200):
            raise HTTPException(422, "Invalid export profile metadata")
        identity[key] = value
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", identity.get("account_fingerprint") or "") or identity.get("endpoint_host") not in OFFICIAL_HOSTS:
        raise HTTPException(422, "Export needs its collector account fingerprint and official endpoint host")
    if document["schema_version"] == 2 and any(not re.fullmatch(r"\d+", identity.get(key) or "") for key in ("server", "game_channel_id")):
        raise HTTPException(422, "Version 2 exports need numeric server and channel metadata")
    if manifest is not None:
        if type(manifest.get("schema_version")) is not int or manifest["schema_version"] != document["schema_version"]:
            raise HTTPException(422, "Manifest schema version does not match the records")
        if type(manifest.get("complete")) is not bool:
            raise HTTPException(422, "Manifest must state whether collection completed")
        validate_date(manifest.get("started_at"), "manifest start date")
        if manifest.get("completed_at") is not None:
            validate_date(manifest["completed_at"], "manifest completion date")
        if manifest["complete"] and manifest.get("completed_at") is None:
            raise HTTPException(422, "Completed manifest needs a completion date")
        if manifest["started_at"] != document["exported_at"]:
            raise HTTPException(422, "Manifest and records are from different collection runs")
        for key in IDENTITY:
            if manifest.get(key) is not None and manifest[key] != identity.get(key):
                raise HTTPException(422, "Manifest identity does not match the records")
    normalized = []
    for entry in source_records_newest_first(document):
        if not isinstance(entry, dict) or not isinstance(entry.get("record"), dict):
            raise HTTPException(422, "Each export record needs its raw record and source provenance")
        raw = entry["record"]
        type_id = positive_int(entry.get("source_type_id"), "source type")
        page = positive_int(entry.get("source_page"), "source page")
        item = positive_int(raw.get("item"), "item ID", zero=True)
        pool = positive_int(raw.get("pool_id"), "pool ID", zero=True)
        quantity = positive_int(raw.get("item_num"), "item quantity", zero=True)
        timestamp = positive_int(raw.get("time"), "timestamp", zero=True)
        try:
            date = datetime.fromtimestamp(timestamp, UTC).isoformat().replace("+00:00", "Z")
            raw_json = canonical(raw)
        except (ValueError, OverflowError, OSError, TypeError):
            raise HTTPException(422, "Invalid record data or timestamp") from None
        normalized.append(dict(type_id=type_id, source_page=page, item_id=item, pool_id=pool,
                               quantity=quantity, timestamp=date, raw_record=raw_json,
                               record_key=hashlib.sha256(raw_json.encode()).hexdigest()))
    if manifest is not None:
        types = manifest.get("types")
        if not isinstance(types, dict):
            raise HTTPException(422, "Manifest needs type collection status and counts")
        counts = Counter(row["type_id"] for row in normalized)
        for type_key, entry in types.items():
            if not re.fullmatch(r"[1-9][0-9]{0,18}", type_key) or not isinstance(entry, dict):
                raise HTTPException(422, "Invalid manifest type information")
            positive_int(entry.get("records"), "manifest record count", zero=True)
            positive_int(entry.get("pages"), "manifest page count", zero=True)
            if not isinstance(entry.get("status"), str) or entry["status"] not in {"complete", "empty", "unavailable", "in_progress", "error"}:
                raise HTTPException(422, "Invalid manifest type status")
            if entry["records"] != counts[int(type_key)]:
                raise HTTPException(422, "Manifest record counts do not match this snapshot")
            if manifest["complete"] and entry.get("status") not in {"complete", "empty", "unavailable"}:
                raise HTTPException(422, "Completed manifest contains an unfinished type")
        for row in normalized:
            entry = types.get(str(row["type_id"]))
            if entry is None or row["source_page"] > entry["pages"]:
                raise HTTPException(422, "Record provenance exceeds the manifest pages")
    if raw_pages is not None:
        expected = {}
        for entry in records:
            expected.setdefault((entry["source_type_id"], entry["source_page"]), []).append(entry["record"])
        actual = {}
        for name, contents in raw_pages.items():
            match = re.fullmatch(r"raw/type_(\d+)/page_(\d+)\.json", name)
            if not match:
                raise HTTPException(422, "Invalid raw page archive name")
            try:
                parsed = json.loads(contents.lstrip("\ufeff")) if isinstance(contents, str) else contents
                no_credentials(parsed)
                page_records = parsed["data"]["list"]
                if not isinstance(page_records, list):
                    raise ValueError()
            except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                raise HTTPException(422, "Raw pages must contain valid collector response JSON") from None
            pair = tuple(int(value) for value in match.groups())
            if pair in actual or page_records != expected.get(pair, []):
                raise HTTPException(422, "Raw page records do not match snapshot provenance")
            actual[pair] = page_records
        if not expected.keys() <= actual.keys():
            raise HTTPException(422, "Raw archive is missing pages referenced by the snapshot")
    # Serialize the entire input before entering the transaction so invalid JSON
    # cannot leave an identity binding or a partly imported snapshot behind.
    try:
        canonical([document, manifest, raw_pages])
    except (ValueError, TypeError):
        raise HTTPException(422, "Export must contain valid finite JSON values") from None
    return identity, normalized


class Tracker:
    def __init__(self, sessions, catalog_path=None):
        self.sessions = sessions
        self.lock = RLock()
        path = Path(catalog_path or Path(__file__).with_name("catalog.json"))
        self.catalog = {item["id"]: item for item in json.loads(path.read_text(encoding="utf-8"))["items"]} if path.exists() else {}

    def import_snapshot(self, profile_id, document, manifest=None, raw_pages=None):
        identity, rows = validate_document(document, manifest, raw_pages)
        digest = hashlib.sha256(canonical([document, manifest, raw_pages]).encode()).hexdigest()
        with self.lock, self.sessions.begin() as session:
            profile = require_profile(session, profile_id)
            bind_identity(profile, identity)
            existing = session.scalar(select(Snapshot).where(Snapshot.profile_id == profile_id, Snapshot.digest == digest))
            if existing:
                result = self.snapshot_public(existing)
                result.update(duplicate=True, added_count=0, total=len(list(session.scalars(select(Pull.id).where(Pull.profile_id == profile_id)))))
                return result
            snapshot = Snapshot(id=str(uuid4()), profile_id=profile_id, digest=digest,
                                document=canonical(document), manifest=canonical(manifest) if manifest is not None else None,
                                raw_pages=canonical(raw_pages) if raw_pages is not None else None,
                                record_count=len(rows), added_count=0, complete=manifest.get("complete") if manifest else None, imported_at=now())
            session.add(snapshot)
            session.flush()
            saved = list(session.scalars(select(Pull).where(Pull.profile_id == profile_id).order_by(Pull.timestamp_order, Pull.id)))
            previous = Counter((pull.type_id, pull.record_key) for pull in saved)
            by_identity = {(pull.type_id, pull.record_key, pull.occurrence): pull for pull in saved}
            groups = defaultdict(list)
            for pull in saved:
                groups[(pull.type_id, pull.timestamp)].append((pull.type_id, pull.record_key, pull.occurrence))
            incoming = defaultdict(list)
            observed = Counter()
            for row in rows:
                key = (row["type_id"], row["record_key"])
                observed[key] += 1
                identity = (*key, observed[key])
                incoming[(row["type_id"], row["timestamp"])].append(identity)
                if observed[key] > previous[key]:
                    pull = Pull(profile_id=profile_id, snapshot_id=snapshot.id, occurrence=observed[key], **row)
                    session.add(pull)
                    by_identity[identity] = pull
                    snapshot.added_count += 1
            for group, ordered in incoming.items():
                for position, identity in enumerate(merge_source_order(groups[group], ordered)):
                    by_identity[identity].timestamp_order = position
            result = self.snapshot_public(snapshot)
            result.update(duplicate=False, total=sum(previous.values()) + snapshot.added_count)
            return result

    @staticmethod
    def snapshot_public(snapshot):
        return {key: getattr(snapshot, key) for key in ("id", "profile_id", "record_count", "added_count", "complete", "imported_at")}

    def history(self, profile_id, filters):
        with self.sessions() as session:
            profile = require_profile(session, profile_id)
            endpoint_host = profile.endpoint_host
            documents = []
            for snapshot in session.scalars(select(Snapshot).where(Snapshot.profile_id == profile_id)):
                document = json.loads(snapshot.document)
                # Incremental archives retain empty overlap pages; these prove
                # that page-number jumps do not necessarily omit any pulls.
                empty_pages = defaultdict(list)
                for path, contents in json.loads(snapshot.raw_pages or "{}").items():
                    match = re.fullmatch(r"raw/type_(\d+)/page_(\d+)\.json", path)
                    payload = json.loads(contents.lstrip("\ufeff")) if isinstance(contents, str) else contents
                    if match and payload["data"]["list"] == []:
                        empty_pages[str(int(match[1]))].append(int(match[2]))
                document["_coverage_empty_pages"] = empty_pages
                documents.append(document)
            pulls = list(session.scalars(select(Pull).where(Pull.profile_id == profile_id).order_by(Pull.timestamp.desc(), Pull.timestamp_order, Pull.type_id, Pull.id)))
        groups = Counter((p.type_id, p.pool_id, p.timestamp) for p in pulls)
        all_rows = []
        for pull in pulls:
            item = self.catalog.get(pull.item_id, {})
            row = dict(id=pull.id, item_id=pull.item_id, name=item.get("name", f"Unknown item #{pull.item_id}"),
                       kind=item.get("kind", "unknown"), rarity=item.get("rarity", "Unknown"), region=item.get("region"),
                       type_id=pull.type_id, pool_id=pull.pool_id, timestamp=pull.timestamp, timestamp_order=pull.timestamp_order, quantity=pull.quantity,
                       source_page=pull.source_page, record_key=pull.record_key, occurrence=pull.occurrence, estimated_group_size=groups[(pull.type_id, pull.pool_id, pull.timestamp)])
            all_rows.append(row)
        annotate_history(all_rows, documents, endpoint_host)
        result = []
        for row in all_rows:
            row.pop("record_key")
            row.pop("occurrence")
            if filters.get("q") and filters["q"].casefold() not in f'{row["name"]} {row["item_id"]}'.casefold():
                continue
            if any(filters.get(key) is not None and row[key] != filters[key] for key in ("rarity", "kind", "type_id", "pool_id")):
                continue
            if filters.get("date_from") and row["timestamp"][:10] < filters["date_from"]:
                continue
            if filters.get("date_to") and row["timestamp"][:10] > filters["date_to"]:
                continue
            result.append(row)
        return result

    def statistics(self, profile_id, rows):
        with self.sessions() as session:
            latest = session.scalar(select(Snapshot).where(Snapshot.profile_id == profile_id).order_by(Snapshot.imported_at.desc()))
        known = [row for row in rows if row["kind"] in ("doll", "weapon")]
        distribution = lambda key, values, label: [{label: value, "count": count} for value, count in sorted(Counter(row[key] for row in values).items())]
        return dict(total=len(rows), known_total=len(known), unknown_total=len(rows)-len(known),
                    rarities=distribution("rarity", known, "label"), kinds=distribution("kind", rows, "label"),
                    types=distribution("type_id", rows, "id"), pools=distribution("pool_id", rows, "id"),
                    date_from=min((row["timestamp"] for row in rows), default=None), date_to=max((row["timestamp"] for row in rows), default=None),
                    last_import_at=latest.imported_at if latest else None, latest_import_complete=latest.complete if latest else None,
                    coverage="accessible_history_only", estimated_multi_groups=sum(count > 1 for count in Counter((row["type_id"], row["pool_id"], row["timestamp"]) for row in rows).values()))
