"""Persistent model and sequential schema migrations for the local store."""
from collections import Counter, defaultdict
from datetime import UTC, datetime
import hashlib
import json
from sqlalchemy import Column, Integer, String, Text, Boolean, ForeignKey, UniqueConstraint, create_engine, text, event
from sqlalchemy.orm import declarative_base, sessionmaker

Base = declarative_base()


class Profile(Base):
    __tablename__ = "profiles"
    id = Column(String, primary_key=True)
    owner_id = Column(String, nullable=False, default="local")
    name = Column(String, nullable=False)
    account_fingerprint = Column(String)
    endpoint_host = Column(String)
    server = Column(String)
    game_channel_id = Column(String)
    created_at = Column(String, nullable=False)


class Snapshot(Base):
    __tablename__ = "snapshots"
    __table_args__ = (UniqueConstraint("profile_id", "digest"),)
    id = Column(String, primary_key=True)
    profile_id = Column(String, ForeignKey("profiles.id"), nullable=False, index=True)
    digest = Column(String, nullable=False)
    document = Column(Text, nullable=False)
    manifest = Column(Text)
    raw_pages = Column(Text)
    record_count = Column(Integer, nullable=False)
    added_count = Column(Integer, nullable=False)
    complete = Column(Boolean)
    imported_at = Column(String, nullable=False)


class Pull(Base):
    __tablename__ = "pulls"
    __table_args__ = (UniqueConstraint("profile_id", "type_id", "record_key", "occurrence"),)
    id = Column(Integer, primary_key=True)
    profile_id = Column(String, ForeignKey("profiles.id"), nullable=False, index=True)
    snapshot_id = Column(String, ForeignKey("snapshots.id"), nullable=False)
    type_id = Column(Integer, nullable=False)
    record_key = Column(String, nullable=False)
    occurrence = Column(Integer, nullable=False)
    raw_record = Column(Text, nullable=False)
    source_page = Column(Integer, nullable=False)
    item_id = Column(Integer, nullable=False)
    pool_id = Column(Integer, nullable=False)
    timestamp = Column(String, nullable=False)
    timestamp_order = Column(Integer, nullable=False, default=0)
    quantity = Column(Integer, nullable=False)


class Job(Base):
    __tablename__ = "jobs"
    id = Column(String, primary_key=True)
    profile_id = Column(String, ForeignKey("profiles.id"), nullable=False, index=True)
    status = Column(String, nullable=False)
    message = Column(String, nullable=False)
    records = Column(Integer, nullable=False, default=0)
    pages = Column(Integer, nullable=False, default=0)
    type_id = Column(Integer)
    import_id = Column(String)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)


def source_records_newest_first(document):
    """Exilium's converted browser store preserves its oldest-first pull arrays."""
    source = document.get("external_source")
    if isinstance(source, dict) and source.get("source") == "https://exilium.xyz":
        return reversed(document["records"])
    return iter(document["records"])


def merge_source_order(existing, incoming):
    """Insert unseen occurrences around shared anchors without disturbing known order.

    Inputs are newest-first within one timestamp. A truncated snapshot must not
    replace a previously saved full group's order. A group covering every saved
    occurrence is authoritative, including new identical occurrences. Partial
    groups retain established anchors; unanchored records follow known records.
    """
    merged = list(existing)
    known = set(existing)
    if known.issubset(incoming):
        return list(incoming)
    pending = []
    for token in incoming:
        if token in known:
            if pending:
                index = merged.index(token)
                merged[index:index] = pending
                pending = []
        else:
            pending.append(token)
            known.add(token)
    merged.extend(pending)
    return merged


def backfill_timestamp_order(connection):
    pulls = connection.execute(text("SELECT id, profile_id, type_id, timestamp, record_key, occurrence FROM pulls ORDER BY id")).mappings().all()
    identities = {(p["profile_id"], p["type_id"], p["record_key"], p["occurrence"]): p["id"] for p in pulls}
    groups = defaultdict(list)
    for snapshot in connection.execute(text("SELECT profile_id, document FROM snapshots ORDER BY imported_at, id")).mappings():
        occurrences = Counter()
        incoming = defaultdict(list)
        for entry in source_records_newest_first(json.loads(snapshot["document"])):
            raw = entry["record"]
            key = hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()
            identity = (snapshot["profile_id"], entry["source_type_id"], key)
            occurrences[identity] += 1
            pull_id = identities.get((*identity, occurrences[identity]))
            if pull_id is not None:
                timestamp = datetime.fromtimestamp(raw["time"], UTC).isoformat().replace("+00:00", "Z")
                incoming[(snapshot["profile_id"], entry["source_type_id"], timestamp)].append(pull_id)
        for group, ordered in incoming.items():
            groups[group] = merge_source_order(groups[group], ordered)
    # Retain any legacy row without snapshot provenance in deterministic ID order.
    for pull in pulls:
        group = (pull["profile_id"], pull["type_id"], pull["timestamp"])
        if pull["id"] not in groups[group]:
            groups[group].append(pull["id"])
    updates = [{"id": pull_id, "position": position} for ordered in groups.values() for position, pull_id in enumerate(ordered)]
    if updates:
        connection.execute(text("UPDATE pulls SET timestamp_order=:position WHERE id=:id"), updates)


def open_database(path):
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False, "timeout": 30})
    @event.listens_for(engine, "connect")
    def configure_connection(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")
    # user_version is the ordered migration cursor. Future changes add explicit
    # version steps here; create_all alone must never stand in for an upgrade.
    with engine.begin() as connection:
        connection.execute(text("PRAGMA foreign_keys=ON"))
        version = connection.execute(text("PRAGMA user_version")).scalar_one()
        if version > 2:
            raise RuntimeError("This database needs a newer version of the tracker")
        if version == 0:
            connection.exec_driver_sql("BEGIN")
            Base.metadata.create_all(connection)
            connection.execute(text("PRAGMA user_version=2"))
        elif version == 1:
            # sqlite3's legacy transaction mode does not start a transaction for
            # DDL. Include ALTER and backfill in one rollback-safe migration.
            connection.exec_driver_sql("BEGIN")
            connection.execute(text("ALTER TABLE pulls ADD COLUMN timestamp_order INTEGER NOT NULL DEFAULT 0"))
            backfill_timestamp_order(connection)
            connection.execute(text("PRAGMA user_version=2"))
    return engine, sessionmaker(engine, expire_on_commit=False)
