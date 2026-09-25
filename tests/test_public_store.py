"""Unified server history preserves occurrence order and recovery evidence."""
from copy import deepcopy
import json
import sqlite3

from fastapi import HTTPException
import pytest

from backend import public_store
from backend.public_store import PublicStore, account_key

HOST = 'gf2-gacha-record-us.sunborngame.com'


def identity(uid='00123'):
    return dict(uid=uid, endpoint_host=HOST, server='10', game_channel_id='5',
                account_fingerprint='sha256:' + 'a' * 64)


def snapshot(items, *, owner=None, pages=None, timestamp=1733184000, tag=None):
    document = dict(schema_version=2, exported_at='2026-01-01T00:00:00Z', **(owner or identity()),
        records=[dict(source_type_id=3, source_page=pages[index] if pages else 1,
                      record=dict(item=item, pool_id=1, time=timestamp, item_num=1))
                 for index, item in enumerate(items)])
    if tag is not None:
        document['tag'] = tag
    return {'records_document': document}


@pytest.fixture
def store(tmp_path):
    value = PublicStore(tmp_path / 'public-v2.sqlite3')
    value.catalog = {item: {'id': item, 'rarity': 'Elite' if item in (2, 5) else 'Standard'}
                     for item in range(1, 21)}
    return value


def save(store, snapshots, **kwargs):
    owner = kwargs.pop('identity', identity())
    return store.put_backup(account_key(owner), owner, 'Account', snapshots, **kwargs)


def rows(store, owner=None):
    with store.connect() as db:
        return [dict(row) for row in db.execute('SELECT * FROM pulls WHERE account_id=? ORDER BY timestamp DESC,timestamp_order',
                                               (account_key(owner or identity()),))]


def test_uid_namespace_and_fingerprint_is_not_account_key():
    owner = identity()
    assert account_key(owner) == account_key({**owner, 'account_fingerprint': 'sha256:' + 'b' * 64})
    for field, value in [('uid', '123'), ('endpoint_host', 'gf2-gacha-record-asia.haoplay.com'),
                         ('server', '11'), ('game_channel_id', '6')]:
        assert account_key(owner) != account_key({**owner, field: value})
    with pytest.raises(HTTPException):
        account_key({key: value for key, value in owner.items() if key != 'uid'})


def test_equal_time_ten_pull_order_duplicates_partial_repeat_reopen(store):
    items = [10, 9, 10, 8, 7, 6, 5, 4, 3, 2]
    full = snapshot(items)
    partial = snapshot([9, 10, 8])
    result = save(store, [full])
    assert result == dict(account_id=account_key(identity()), name='Account', snapshot_count=1, record_count=10)
    save(store, [partial, full])
    save(store, [full], source='collected')
    actual = rows(store)
    assert [row['item_id'] for row in actual] == items
    assert [row['timestamp_order'] for row in actual] == list(range(10))
    assert [row['occurrence'] for row in actual if row['item_id'] == 10] == [1, 2]
    assert all(json.loads(row['sources']) == ['collected', 'upload'] for row in actual)
    assert not any(row['gap_before'] for row in actual)
    assert [row['pity'] for row in actual] == [6, 5, 4, 3, 2, 1, 3, 2, 1, 1]
    reopened = PublicStore(store.path)
    assert [row['item_id'] for row in rows(reopened)] == items
    assert reopened.get_backup(account_key(identity()))['snapshots'] == [full, partial]
    with reopened.connect() as db:
        assert db.execute('SELECT uid FROM accounts').fetchone()[0] == '00123'
        saved = db.execute('SELECT sequence,sources FROM snapshots ORDER BY sequence').fetchall()
        assert [row['sequence'] for row in saved] == [1, 2]
        assert json.loads(saved[0]['sources']) == ['collected', 'upload']
        assert db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert not names & {'backups', 'contributions', 'preferences'}


def test_partial_first_then_full_retains_indistinguishable_multiplicity(store):
    save(store, [snapshot([10, 8])])
    save(store, [snapshot([10, 9, 10, 8])])
    assert [row['item_id'] for row in rows(store)] == [10, 9, 10, 8]
    assert save(store, [snapshot([10, 8])])['record_count'] == 4


def test_recovery_retains_separate_windows_and_bridge_repairs_gap(store):
    old = snapshot([3, 2, 1], timestamp=1733184000)
    new = snapshot([6, 5, 4], timestamp=1733270400)
    save(store, [old, new])
    assert [row['item_id'] for row in rows(store) if row['gap_before']] == [4]
    recovered = store.get_backup(account_key(identity()))['snapshots']
    assert recovered == [old, new]
    other = PublicStore(store.path.parent / 'restored.sqlite3')
    other.catalog = store.catalog
    save(other, recovered)
    assert rows(other) == rows(store)
    bridge = snapshot([4, 3], timestamp=1733270400)
    bridge['records_document']['records'][1]['record']['time'] = 1733184000
    save(store, [bridge])
    assert not any(row['gap_before'] for row in rows(store))


def test_missing_pages_need_validated_empty_page_evidence(store):
    source = snapshot([4, 3, 2, 1], pages=[1, 1, 3, 3])
    save(store, [source])
    assert [row['item_id'] for row in rows(store) if row['gap_before']] == [3]
    source['raw_pages'] = {f'raw/type_3/page_{page}.json': {'data': {'list': [entry['record']
        for entry in source['records_document']['records'] if entry['source_page'] == page]}} for page in (1, 2, 3)}
    save(store, [source])
    assert not any(row['gap_before'] for row in rows(store))


def test_association_is_explicit_preserves_payload_and_rejects_conflicts(store):
    source = snapshot([1, 2])
    for field in identity():
        source['records_document'].pop(field)
    with pytest.raises(HTTPException) as error:
        save(store, [source])
    assert error.value.status_code == 409
    save(store, [source], associate=True)
    assert store.get_backup(account_key(identity()))['snapshots'] == [source]
    conflicting = deepcopy(source)
    conflicting['records_document']['server'] = '999'
    with pytest.raises(HTTPException) as error:
        save(store, [conflicting], associate=True)
    assert error.value.status_code == 409


def exilium(uid='00123'):
    source = snapshot([1, 2, 2, 3])
    for field in identity():
        source['records_document'].pop(field)
    source['records_document']['schema_version'] = 1
    source['records_document']['external_source'] = dict(source='https://exilium.xyz',
        recovered_store={'version': 1, 'state': {'profilesData': {'one': {'pulls': {
            '3': [dict(uid=uid, server='Global', item=item) for item in [1, 2, 2, 3]]}}}}})
    return source


def test_exilium_uid_checked_and_original_oldest_first_preserved(store):
    source = exilium()
    save(store, [source], associate=True)
    assert [row['item_id'] for row in rows(store)] == [3, 2, 2, 1]
    assert store.get_backup(account_key(identity()))['snapshots'] == [source]
    with pytest.raises(HTTPException) as error:
        save(store, [exilium('different')], associate=True)
    assert error.value.status_code == 409


def test_statistics_reads_only_normalized_pulls_and_suppresses_small_buckets(store, monkeypatch):
    for index in range(5):
        owner = identity(str(index))
        source = snapshot([1, 2, 1] + ([20] if index == 0 else []), owner=owner)
        save(store, [source], identity=owner, source='collected' if index % 2 else 'upload')
        if index < 4:
            assert store.statistics()['suppressed']
    monkeypatch.setattr(public_store, 'merged_history', lambda *args: pytest.fail('Analytics reconstructed snapshots'))
    stats = store.statistics()
    assert stats['total'] == 16 and stats['contributors'] == 5
    assert stats['breakdowns'][0]['items'] == [{'item_id': 1, 'count': 10}, {'item_id': 2, 'count': 5}]
    # One account's extra older reward changes its pity: four is suppressed.
    assert stats['breakdowns'][0]['pity'] == []
    store.delete_backup(account_key(identity('4')))
    assert store.statistics()['suppressed'] and not store.statistics()['breakdowns']


def test_catalog_change_refreshes_persisted_rarity_pity_and_cache(store):
    for index in range(5):
        owner = identity(str(index))
        save(store, [snapshot([3, 2, 1], owner=owner)], identity=owner)
    assert store.statistics()['breakdowns'][0]['pity'] == [{'pulls': 2, 'count': 5}]
    store.catalog[2]['rarity'] = 'Standard'
    store.catalog[3]['rarity'] = 'Elite'
    assert store.statistics()['breakdowns'][0]['pity'] == [{'pulls': 3, 'count': 5}]
    assert rows(store, identity('0'))[0]['rarity'] == 'Elite'


def test_delete_generation_rejects_inflight_save_and_cascades(store):
    key = account_key(identity())
    generation = store.backup_version(key)
    save(store, [snapshot([1, 2])])
    store.delete_backup(key)
    with pytest.raises(HTTPException) as error:
        save(store, [snapshot([3])], expected_version=generation)
    assert error.value.status_code == 409
    with store.connect() as db:
        for table in ('accounts', 'snapshots', 'pulls'):
            assert db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0
    assert store.backup_version(key) == generation + 1
    assert save(store, [snapshot([3])], expected_version=generation + 1)['record_count'] == 1


def test_snapshot_count_limit_is_per_request_not_cumulative(store):
    save(store, [snapshot([1], tag=index) for index in range(100)])
    assert save(store, [snapshot([2], tag=100)])['snapshot_count'] == 101
    with pytest.raises(HTTPException) as error:
        save(store, [snapshot([1])] * 101)
    assert error.value.status_code == 422


@pytest.mark.parametrize('configured', ['0', '-1', '1.5', 'abc', ' 1024'])
def test_capacity_configuration_requires_positive_integer(tmp_path, monkeypatch, configured):
    monkeypatch.setenv('GFL2_PUBLIC_DATABASE_MAX_BYTES', configured)
    with pytest.raises(RuntimeError):
        PublicStore(tmp_path / 'invalid.sqlite3')


def test_capacity_growth_rolls_back_entire_save(store):
    original = snapshot([1, 2])
    save(store, [original])
    with store.connect() as db:
        store.max_database_bytes = db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0]
    large = snapshot([3], tag='x' * 200_000)
    with pytest.raises(HTTPException) as error:
        save(store, [large])
    assert error.value.status_code == 507
    assert store.get_backup(account_key(identity()))['snapshots'] == [original]
    assert [row['item_id'] for row in rows(store)] == [1, 2]


def test_source_claims_in_upload_do_not_grant_collected_provenance(store):
    source = snapshot([1])
    source['sources'] = ['collected']
    save(store, [source])
    assert json.loads(rows(store)[0]['sources']) == ['upload']
    with store.connect() as db:
        assert json.loads(db.execute('SELECT sources FROM snapshots').fetchone()[0]) == ['upload']


def test_changed_fingerprint_cannot_rebind_existing_history(store):
    original = snapshot([1])
    save(store, [original])
    changed = {**identity(), 'account_fingerprint': 'sha256:' + 'b' * 64}
    with pytest.raises(HTTPException) as error:
        save(store, [snapshot([2], owner=changed)], identity=changed)
    assert error.value.status_code == 409
    assert store.get_backup(account_key(identity()))['snapshots'] == [original]


def test_capacity_failure_does_not_create_partial_account(store):
    with store.connect() as db:
        store.max_database_bytes = db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0]
    with pytest.raises(HTTPException) as error:
        save(store, [snapshot([1], tag='x' * 200_000)])
    assert error.value.status_code == 507
    with store.connect() as db:
        for table in ('accounts', 'snapshots', 'pulls'):
            assert db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0


def test_request_size_limit_does_not_restrict_account_total(store, monkeypatch):
    first = snapshot([1], tag='x' * 800)
    second = snapshot([2], tag='y' * 800)
    monkeypatch.setattr(public_store, 'MAX_REQUEST_BYTES', len(json.dumps([first]).encode()) + 20)
    save(store, [first])
    assert save(store, [second])['snapshot_count'] == 2
    with pytest.raises(HTTPException) as error:
        save(store, [first, second])
    assert error.value.status_code == 413


def test_fresh_schema_version_and_legacy_database_rejected(tmp_path):
    path = tmp_path / 'public-v2.sqlite3'
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE backups(account_id TEXT PRIMARY KEY, snapshots TEXT)')
        db.execute("INSERT INTO backups VALUES('legacy','[]')")
    with pytest.raises(RuntimeError, match='fresh version 2'):
        PublicStore(path)
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT count(*) FROM backups').fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM sqlite_master WHERE name='accounts'").fetchone()[0] == 0
    fresh = PublicStore(tmp_path / 'fresh.sqlite3')
    with fresh.connect() as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 2
