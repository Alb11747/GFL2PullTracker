"""Create or restore a consistent SQLite backup without copying live WAL files."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sqlite3
import tempfile


def checked_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Database integrity check failed")
    except Exception:
        connection.close()
        raise
    return connection


def backup(source: Path, destination: Path) -> None:
    if destination.exists():
        raise ValueError("Destination already exists; choose a new backup filename")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # The exclusive creation prevents accidentally replacing a valuable backup.
    with destination.open("xb"):
        pass
    try:
        with checked_database(source) as incoming, sqlite3.connect(destination) as outgoing:
            incoming.backup(outgoing)
            if outgoing.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Backup integrity check failed")
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        if "incoming" in locals():
            incoming.close()
        if "outgoing" in locals():
            outgoing.close()
    os.chmod(destination, 0o600)


def restore(source: Path, destination: Path) -> None:
    """Caller must stop the service; refuse a live/unclean destination."""
    if any(Path(str(destination) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Database sidecars exist; stop the service cleanly before restoring")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gfl2-restore-", dir=destination.parent) as work:
        staged = Path(work) / "restored.sqlite3"
        backup(source, staged)
        if destination.exists():
            recovery = destination.with_name(destination.name + ".pre-restore")
            backup(destination, recovery)
        os.replace(staged, destination)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("backup", "restore"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--service-stopped", action="store_true",
                        help="Required for restore: confirms every database writer is stopped")
    args = parser.parse_args()
    if args.source.resolve() == args.destination.resolve():
        parser.error("Source and destination must differ")
    if args.operation == "restore" and not args.service_stopped:
        parser.error("Stop the API first, then pass --service-stopped")
    try:
        (backup if args.operation == "backup" else restore)(args.source, args.destination)
    except (OSError, ValueError, sqlite3.Error) as exc:
        parser.exit(1, f"Database operation failed: {exc}\n")
    print(f"{args.operation.capitalize()} verified: {args.destination}")


if __name__ == "__main__":
    main()
