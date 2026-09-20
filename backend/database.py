"""Persistent model and sequential schema migrations for the local store."""
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
        if version > 1:
            raise RuntimeError("This database needs a newer version of the tracker")
        if version == 0:
            Base.metadata.create_all(connection)
            connection.execute(text("PRAGMA user_version=1"))
    return engine, sessionmaker(engine, expire_on_commit=False)
