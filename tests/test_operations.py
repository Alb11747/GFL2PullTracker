from contextlib import closing
import sqlite3

import pytest

from scripts.backup_database import backup, restore


def create_database(path, values=('original',)):
    with closing(sqlite3.connect(path)) as connection:
        connection.execute('CREATE TABLE sample(value TEXT)')
        connection.executemany('INSERT INTO sample VALUES (?)', [(value,) for value in values])
        connection.commit()


def rows(path):
    with closing(sqlite3.connect(path)) as connection:
        return connection.execute('SELECT value FROM sample ORDER BY rowid').fetchall()


def test_backup_includes_committed_live_wal(tmp_path):
    source = tmp_path / 'source.sqlite3'
    destination = tmp_path / 'backup.sqlite3'
    with closing(sqlite3.connect(source)) as connection:
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('CREATE TABLE sample(value TEXT)')
        connection.execute("INSERT INTO sample VALUES ('committed')")
        connection.commit()
        backup(source, destination)
    assert rows(destination) == [('committed',)]


def test_backup_never_overwrites_existing_copy(tmp_path):
    source = tmp_path / 'source.sqlite3'
    destination = tmp_path / 'backup.sqlite3'
    create_database(source)
    destination.write_bytes(b'valuable previous backup')
    with pytest.raises(ValueError, match='already exists'):
        backup(source, destination)
    assert destination.read_bytes() == b'valuable previous backup'


def test_malformed_source_is_closed_and_failed_output_removed(tmp_path):
    source = tmp_path / 'corrupt.sqlite3'
    destination = tmp_path / 'backup.sqlite3'
    source.write_bytes(b'not a SQLite database')
    with pytest.raises(sqlite3.DatabaseError):
        backup(source, destination)
    assert not destination.exists()
    # On Windows this also checks no failed integrity-check connection leaked.
    source.unlink()


@pytest.mark.parametrize('suffix', ['-wal', '-shm', '-journal'])
def test_restore_refuses_database_with_live_sidecars(tmp_path, suffix):
    source = tmp_path / 'backup.sqlite3'
    destination = tmp_path / 'live.sqlite3'
    create_database(source)
    create_database(destination, ('newer',))
    destination.with_name(destination.name + suffix).touch()
    with pytest.raises(ValueError, match='sidecars'):
        restore(source, destination)
    assert rows(destination) == [('newer',)]


def test_restore_preserves_previous_database_and_refuses_recovery_overwrite(tmp_path):
    source = tmp_path / 'backup.sqlite3'
    destination = tmp_path / 'live.sqlite3'
    create_database(source)
    create_database(destination, ('newer', 'important'))
    restore(source, destination)
    assert rows(destination) == [('original',)]
    recovery = destination.with_name(destination.name + '.pre-restore')
    assert rows(recovery) == [('newer',), ('important',)]
    with pytest.raises(ValueError, match='already exists'):
        restore(source, destination)
    assert rows(recovery) == [('newer',), ('important',)]
