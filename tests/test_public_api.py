"""Public security boundary tests use synthetic credentials only.

The test-only verifier represents an independently trusted provider identity;
it is not an implementation of real provider authentication.
"""
import base64
import hashlib
import json
import sqlite3
from threading import Event

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from backend.public_app import create_public_app
from backend.public_jobs import prepare, prepared_identity
from backend.public_store import PublicStore, account_key
from scripts import fetch_pull_history as collector

ORIGIN = 'https://tracker.example'
HOST = 'gf2-gacha-record-us.sunborngame.com'


def capture(account='synthetic-owner', expires=4102444800):
    metadata = base64.urlsafe_b64encode(json.dumps({'uid': 0, 'tinx': 10, 'expires': expires}).encode()).decode()
    return (f'POST https://{HOST}/list?game_channel_id=5&type_id=3&u={account} HTTP/1.1\r\n'
            f'Host: {HOST}\r\nAuthorization: {metadata}.synthetic-signature\r\n'
            'X-Private-Header: never-forward-me\r\nCookie: do-not-forward\r\n'
            'Content-Type: application/x-www-form-urlencoded\r\nContent-Length: 9\r\n\r\nserver=10')


def raw(item=11007, timestamp=1784800558):
    return dict(pool_id=224001, item=item, time=timestamp, item_num=1)


def snapshot(identity, records=None):
    return {'records_document': {'schema_version': 2, 'exported_at': '2026-07-26T17:57:48Z',
            **identity, 'records': [dict(source_type_id=3, source_page=1, record=r) for r in (records or [raw()])]}}


class FakeGame:
    def __init__(self, prepared, **kwargs):
        self.prepared = prepared
        assert set(prepared.forwarded_headers) == {'authorization', 'content-type'}

    def request(self, type_id, next_cursor=None):
        rows = [raw(), raw()] if type_id == 3 else []
        return collector.HttpResponse(200, 'OK', {}, json.dumps({'code': 0, 'data': {'list': rows, 'next': ''}}).encode())


def initialize(client):
    # Represents the trusted frontend on the otherwise unpublished API network.
    client.headers.setdefault('X-GFL2-Client-IP', '192.0.2.10')
    response = client.get('/api/public/config')
    assert response.status_code == 200, response.text
    client.headers.update({'Origin': ORIGIN, 'X-CSRF-Token': response.json()['csrf_token']})
    return response


@pytest.fixture
def client(tmp_path):
    with TestClient(create_public_app(tmp_path, origin=ORIGIN, client_factory=FakeGame), base_url=ORIGIN) as client:
        initialize(client)
        yield client


def test_public_routes_never_expose_desktop_store(client, tmp_path):
    for path in ('profiles', 'history', 'imports', 'statistics', 'filters', 'jobs/anything'):
        assert client.get('/api/' + path).status_code == 404
    assert not (tmp_path / 'tracker.sqlite3').exists()
    assert client.get('/api/health').json()['mode'] == 'public'


def test_session_cookie_and_hashed_storage(client, tmp_path):
    client.cookies.clear()
    response = initialize(client)
    cookie = response.headers['set-cookie']
    assert 'HttpOnly' in cookie and 'Secure' in cookie and 'SameSite=strict' in cookie
    token = client.cookies.get('gfl2_session')
    with sqlite3.connect(tmp_path / 'public-v2.sqlite3') as db:
        session = db.execute('SELECT hash,csrf_hash FROM sessions WHERE hash=?', (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        assert session and token not in session
    assert response.headers['cache-control'] == 'no-store'


def test_forged_metadata_and_accepted_list_are_not_ownership(client):
    config = client.get('/api/public/config').json()
    assert not config['features']['submit_history']
    assert config['features']['relay_import']
    for payload in ({'capture': capture()}, {'capture': capture('somebody-else')}):
        assert client.post('/api/public/verify', json=payload).status_code == 503
    assert client.post('/api/public/fetch', json={'capture': capture(), 'submit_history': True}).status_code == 503
    assert client.post('/api/public/fetch', json={'capture': capture(), 'contribute': True}).status_code == 422
    assert client.get('/api/public/backup?account_id=' + 'a'*64).status_code == 503


@pytest.mark.parametrize('headers', [{'origin':'https://evil.example'}, {'origin':''}, {'x-csrf-token':'wrong'}, {'sec-fetch-site':'cross-site'}])
def test_same_origin_and_csrf(client, headers):
    assert client.post('/api/public/fetch', json={'capture':capture()}, headers=headers).status_code == 403


def test_expired_session_and_input_redaction(client):
    assert client.post('/api/public/fetch', json={'capture':capture(expires=1)}).status_code == 422
    response = client.post('/api/public/fetch', json={'capture':capture(), 'token':'private-value'})
    assert response.status_code == 422 and 'private-value' not in response.text and 'synthetic' not in response.text
    with client.app.state.store.connect() as db:
        db.execute('UPDATE sessions SET expires=0')
    assert client.post('/api/public/fetch', json={'capture':capture()}).status_code == 401


def test_spoofed_host_redirect_and_body_limits(client):
    assert client.get('/api/public/config', headers={'Host':'evil.example'}).status_code == 400
    assert client.post('/api/public/fetch', json={'capture':capture().replace(HOST,'evil.example')}).status_code == 422
    assert client.post('/api/public/fetch', content=b'x'*300001, headers={'Content-Type':'application/json'}).status_code == 413
    assert client.post('/api/public/fetch', json={}, headers={'Content-Encoding':'gzip'}).status_code == 415


def test_relay_is_session_scoped_ephemeral_and_no_credentials(client, tmp_path):
    response = client.post('/api/public/fetch', json={'capture':capture()})
    assert response.status_code == 202, response.text
    identifier = response.json()['id']
    for thread in client.app.state.jobs.threads:
        thread.join(timeout=10)
    status = client.get('/api/public/jobs/' + identifier).json()
    assert status['status'] == 'completed', status
    result = client.get('/api/public/jobs/' + identifier + '/result')
    assert result.status_code == 200 and len(result.json()['records_document']['records']) == 2
    for secret in ('synthetic-owner', 'synthetic-signature', 'never-forward-me', 'do-not-forward'):
        assert secret not in result.text
        assert not any(secret.encode() in file.read_bytes() for file in tmp_path.rglob('*') if file.is_file())
    client.cookies.clear()
    initialize(client)
    assert client.get('/api/public/jobs/' + identifier).status_code == 404
    assert client.get('/api/public/jobs/' + identifier + '/result').status_code == 404
    assert client.get('/api/public/statistics').json()['total'] is None


def test_relay_concurrency_and_expiry(tmp_path):
    waiting, release = Event(), Event()

    class WaitingGame(FakeGame):
        def request(self, type_id, next_cursor=None):
            waiting.set()
            assert release.wait(5)
            return super().request(type_id, next_cursor)

    with TestClient(create_public_app(tmp_path, origin=ORIGIN, client_factory=WaitingGame), base_url=ORIGIN) as client:
        initialize(client)
        response = client.post('/api/public/fetch', json={'capture':capture()})
        identifier = response.json()['id']
        try:
            assert waiting.wait(2)
            assert client.post('/api/public/fetch', json={'capture':capture()}).status_code == 409
            assert client.get('/api/public/jobs/' + identifier + '/result').status_code == 409
        finally:
            release.set()
        for thread in client.app.state.jobs.threads:
            thread.join(timeout=5)
        client.app.state.jobs.jobs[identifier]['expires'] = 0
        assert client.get('/api/public/jobs/' + identifier).status_code == 404


def test_invalid_capture_attempts_are_rate_limited(client):
    for _ in range(10):
        assert client.post('/api/public/fetch', json={'capture':'invalid'}).status_code == 422
    assert client.post('/api/public/fetch', json={'capture':'invalid'}).status_code == 429


@pytest.mark.parametrize('address', ['', 'unknown', '192.0.2.1, 192.0.2.2', '192.0.2.1:1234',
                                     '[2001:db8::1]', 'fe80::1%eth0', ' 192.0.2.1'])
def test_internal_client_address_requires_one_bare_ip(client, address):
    response = client.get('/api/public/config', headers={'X-GFL2-Client-IP': address,
                                                       'X-Forwarded-For': '192.0.2.20'})
    assert response.status_code == 400


def test_missing_and_duplicate_internal_addresses_fail_closed(client):
    del client.headers['X-GFL2-Client-IP']
    assert client.get('/api/public/config', headers={'X-Real-IP': '192.0.2.20'}).status_code == 400
    assert client.get('/api/public/config', headers=[('X-GFL2-Client-IP', '192.0.2.1'),
                                                    ('X-GFL2-Client-IP', '192.0.2.2')]).status_code == 400


def test_new_session_limits_are_per_client_and_ignore_forwarded_headers(client):
    # The fixture consumed one of this address's 120 session creations.
    for _ in range(119):
        client.cookies.clear()
        assert client.get('/api/public/config').status_code == 200
    client.cookies.clear()
    assert client.get('/api/public/config', headers={'X-Forwarded-For': '192.0.2.20'}).status_code == 429
    assert client.get('/api/public/config', headers={'X-GFL2-Client-IP': '192.0.2.20'}).status_code == 200


def test_statistics_limits_are_per_client_and_ipv6_is_canonical(client):
    for _ in range(30):
        assert client.get('/api/public/statistics', headers={'X-GFL2-Client-IP': '2001:db8::1'}).status_code == 200
    assert client.get('/api/public/statistics', headers={'X-GFL2-Client-IP': '2001:0db8:0:0:0:0:0:1'}).status_code == 429
    assert client.get('/api/public/statistics').status_code == 200


def test_global_request_limit_remains_independent_of_client_identity(client):
    # The fixture's initial configuration request consumed one global slot.
    for index in range(599):
        assert client.get('/api/health', headers={'X-GFL2-Client-IP': f'2001:db8::{index + 1:x}'}).status_code == 200
    assert client.get('/api/health', headers={'X-GFL2-Client-IP': '192.0.2.99'}).status_code == 429


def test_upstream_failures_do_not_echo_secrets(tmp_path):
    class FailingGame(FakeGame):
        def request(self, type_id, next_cursor=None):
            raise collector.FetchError('synthetic-signature synthetic-owner')

    with TestClient(create_public_app(tmp_path, origin=ORIGIN, client_factory=FailingGame), base_url=ORIGIN) as client:
        initialize(client)
        identifier = client.post('/api/public/fetch', json={'capture':capture()}).json()['id']
        for thread in client.app.state.jobs.threads:
            thread.join(timeout=5)
        result = client.get('/api/public/jobs/' + identifier)
        assert result.json()['status'] == 'failed'
        assert 'synthetic' not in result.text
        assert client.get('/api/public/jobs/' + identifier + '/result').status_code == 404


def test_verified_sessions_cannot_cross_accounts_and_uploads_share_history(tmp_path):
    # Only this independently supplied identity is accepted by the test adapter.
    identity = {**prepared_identity(prepare(capture(), None)), 'uid': '123456'}
    app = create_public_app(tmp_path, origin=ORIGIN, client_factory=FakeGame, identity_verifier=lambda _: identity)
    with TestClient(app, base_url=ORIGIN) as client:
        initialize(client)
        assert client.post('/api/public/verify', json={'capture':capture('forged-owner')}).status_code == 403
        verified = client.post('/api/public/verify', json={'capture':capture()}).json()
        key = verified['account_id']
        payload = dict(account_id=key, name='Account', snapshots=[snapshot(identity)], expected_version=verified['history_version'])
        assert client.put('/api/public/backup', json=payload).status_code == 200
        wrong = snapshot({**identity, 'server':'11'})
        assert client.put('/api/public/backup', json={**payload, 'snapshots':[wrong]}).status_code == 409
        assert client.put('/api/public/contribution', json=dict(account_id=key, enabled=True)).status_code == 404
        assert client.get('/api/public/statistics').json()['contributors'] is None
        with app.state.store.connect() as db:
            assert db.execute('SELECT count(*) FROM pulls').fetchone()[0] == 1
        client.cookies.clear()
        initialize(client)
        assert client.get('/api/public/backup', params={'account_id':key}).status_code == 404
        assert client.delete('/api/public/backup', params={'account_id':key}, headers={'Content-Type':'application/json'}).status_code == 404
        assert client.put('/api/public/backup', json=payload).status_code == 404
        # Fresh accepted capture restores access, but no credentials are saved.
        assert client.post('/api/public/verify', json={'capture':capture()}).status_code == 200
        assert client.get('/api/public/backup', params={'account_id':key}).json()['snapshots'] == payload['snapshots']
        assert client.delete('/api/public/backup', params={'account_id':key}, headers={'Content-Type':'application/json'}).status_code == 200


def test_contribution_dedup_withdrawal_and_small_buckets(tmp_path):
    store = PublicStore(tmp_path / 'public-v2.sqlite3')
    base = {**prepared_identity(prepare(capture(), None)), 'uid': '123456'}
    for i in range(5):
        identity = {**base, 'uid': str(i + 1), 'account_fingerprint': 'sha256:' + str(i)*64}
        key = account_key(identity)
        source = snapshot(identity, [raw(), raw()] + ([raw(999999)] if i == 0 else []))
        store.put_backup(key, identity, 'Account', [source])
        store.put_backup(key, identity, 'Account', [source])
        if i < 4:
            assert store.statistics()['suppressed']
    stats = store.statistics()
    assert stats['total'] == 11 and stats['contributors'] == 5
    assert len(stats['breakdowns']) == 1
    assert stats['breakdowns'][0]['items'] == [{'item_id':11007, 'count':10}]
    version = store.backup_version(key)
    store.delete_backup(key)
    # Finishing a previously started job must not recreate deleted history.
    with pytest.raises(HTTPException):
        store.put_backup(key, identity, 'Account', [source], expected_version=version)
    assert store.statistics()['suppressed']
    assert store.statistics()['breakdowns'] == []


def test_storage_restart_and_wal(tmp_path):
    store = PublicStore(tmp_path / 'public-v2.sqlite3')
    identity = {**prepared_identity(prepare(capture(), None)), 'uid': '123456'}
    key = account_key(identity)
    store.put_backup(key, identity, 'Account', [snapshot(identity)])
    reopened = PublicStore(tmp_path / 'public-v2.sqlite3')
    assert reopened.get_backup(key)['name'] == 'Account'
    with reopened.connect() as db:
        assert db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'


@pytest.mark.parametrize('uid', [None, '', 123456, 'not-a-uid'])
def test_verifier_must_establish_actual_uid(tmp_path, uid):
    identity = {**prepared_identity(prepare(capture(), None)), 'uid': uid}
    with TestClient(create_public_app(tmp_path, origin=ORIGIN, identity_verifier=lambda _: identity),
                    base_url=ORIGIN) as client:
        initialize(client)
        assert client.post('/api/public/verify', json={'capture': capture()}).status_code == 403
        assert client.get('/api/public/config').json()['accounts'] == []


def test_recovery_is_read_only_and_deletion_invalidates_upload_generation(tmp_path):
    identity = {**prepared_identity(prepare(capture(), None)), 'uid': '123456'}

    class NoCollection:
        def __init__(self, *args, **kwargs):
            pytest.fail('Recovery must not collect game history')

    app = create_public_app(tmp_path, origin=ORIGIN, client_factory=NoCollection,
                            identity_verifier=lambda _: identity)
    with TestClient(app, base_url=ORIGIN) as client:
        initialize(client)
        verified = client.post('/api/public/verify', json={'capture': capture()}).json()
        payload = dict(account_id=verified['account_id'], expected_version=verified['history_version'],
                       snapshots=[snapshot(identity)])
        assert client.put('/api/public/backup', json=payload).status_code == 200
        for _ in range(2):
            assert client.get('/api/public/backup', params={'account_id': verified['account_id']}).json()['snapshots'] == payload['snapshots']
        assert app.state.jobs.jobs == {}
        assert client.delete('/api/public/backup', params={'account_id': verified['account_id']},
                             headers={'Content-Type': 'application/json'}).status_code == 200
        assert client.put('/api/public/backup', json=payload).status_code == 409
        assert client.get('/api/public/backup', params={'account_id': verified['account_id']}).status_code == 404
        fresh = client.get('/api/public/config').json()['accounts'][0]
        assert fresh['history_version'] == verified['history_version'] + 1
        assert client.put('/api/public/backup', json={**payload, 'expected_version': fresh['history_version']}).status_code == 200


def test_collection_and_upload_share_the_same_history(tmp_path):
    identity = {**prepared_identity(prepare(capture(), None)), 'uid': '123456'}
    app = create_public_app(tmp_path, origin=ORIGIN, client_factory=FakeGame,
                            identity_verifier=lambda _: identity)
    with TestClient(app, base_url=ORIGIN) as client:
        initialize(client)
        job = client.post('/api/public/fetch', json={'capture': capture(), 'submit_history': True}).json()
        for thread in app.state.jobs.threads:
            thread.join(timeout=10)
            assert not thread.is_alive()
        result = client.get('/api/public/jobs/' + job['id'] + '/result').json()
        status = client.get('/api/public/jobs/' + job['id']).json()
        assert status['status'] == 'completed' and 'storage failed' not in status['message']
        account = client.get('/api/public/config').json()['accounts'][0]
        saved = client.get('/api/public/backup', params={'account_id': account['account_id']}).json()
        assert saved['snapshots'] == [result]
        response = client.put('/api/public/backup', json=dict(account_id=account['account_id'],
            expected_version=account['history_version'], snapshots=[result]))
        assert response.status_code == 200, response.text
        assert response.json()['record_count'] == 2
        assert response.json()['snapshot_count'] == 1


def test_new_public_database_preserves_previous_store(tmp_path):
    old = tmp_path / 'public.sqlite3'
    old.write_bytes(b'previous private database preserved')
    with TestClient(create_public_app(tmp_path, origin=ORIGIN), base_url=ORIGIN) as client:
        initialize(client)
    assert old.read_bytes() == b'previous private database preserved'
    assert (tmp_path / 'public-v2.sqlite3').exists()


@pytest.mark.parametrize('failure', ['delete', 'disk'])
def test_collection_retains_result_when_server_save_cannot_complete(tmp_path, monkeypatch, failure):
    identity = {**prepared_identity(prepare(capture(), None)), 'uid': '123456'}
    entered, release = Event(), Event()

    class WaitingGame(FakeGame):
        def request(self, *args, **kwargs):
            entered.set()
            assert release.wait(10)
            return super().request(*args, **kwargs)

    app = create_public_app(tmp_path, origin=ORIGIN, client_factory=WaitingGame,
                            identity_verifier=lambda _: identity)
    with TestClient(app, base_url=ORIGIN) as client:
        initialize(client)
        job = client.post('/api/public/fetch', json={'capture': capture(), 'submit_history': True}).json()
        try:
            assert entered.wait(5)
            account = client.get('/api/public/config').json()['accounts'][0]
            if failure == 'delete':
                assert client.delete('/api/public/backup', params={'account_id': account['account_id']},
                                     headers={'Content-Type': 'application/json'}).status_code == 200
            else:
                def unavailable(*args, **kwargs):
                    raise sqlite3.OperationalError('synthetic storage failure')
                monkeypatch.setattr(app.state.store, 'put_backup', unavailable)
        finally:
            release.set()
        for thread in app.state.jobs.threads:
            thread.join(timeout=10)
            assert not thread.is_alive()
        status = client.get('/api/public/jobs/' + job['id']).json()
        assert status['status'] == 'completed'
        assert 'Server storage failed' in status['message']
        result = client.get('/api/public/jobs/' + job['id'] + '/result')
        assert result.status_code == 200
        assert len(result.json()['records_document']['records']) == 2
        assert client.get('/api/public/backup', params={'account_id': account['account_id']}).status_code == 404


def test_deletion_prevents_inflight_backup_resurrection(tmp_path):
    store = PublicStore(tmp_path / 'public-v2.sqlite3')
    identity = {**prepared_identity(prepare(capture(), None)), 'uid': '123456'}
    key = account_key(identity)
    version = store.backup_version(key)
    store.put_backup(key, identity, 'Account', [snapshot(identity)])
    store.delete_backup(key)
    with pytest.raises(HTTPException) as error:
        store.put_backup(key, identity, 'Account', [snapshot(identity)], expected_version=version)
    assert error.value.status_code == 409
    with pytest.raises(HTTPException):
        store.get_backup(key)


@pytest.mark.parametrize('field,value', [('access_token','private'), ('refreshToken','private'), ('session_id','private'),
    ('csrf','private'), ('server_verified',True), ('url','https://example.invalid/list?u=private')])
def test_backup_rejects_secret_and_trust_metadata(tmp_path, field, value):
    store = PublicStore(tmp_path / 'public-v2.sqlite3')
    identity = {**prepared_identity(prepare(capture(), None)), 'uid': '123456'}
    source = snapshot(identity)
    source['records_document'][field] = value
    with pytest.raises(HTTPException) as error:
        store.put_backup(account_key(identity), identity, 'Account', [source])
    assert error.value.status_code == 422


def test_backup_rejects_deep_data_before_recursive_validation(tmp_path):
    store = PublicStore(tmp_path / 'public-v2.sqlite3')
    identity = {**prepared_identity(prepare(capture(), None)), 'uid': '123456'}
    source = snapshot(identity)
    nested = {}
    source['records_document']['extra'] = nested
    for _ in range(50):
        nested['extra'] = {}
        nested = nested['extra']
    with pytest.raises(HTTPException) as error:
        store.put_backup(account_key(identity), identity, 'Account', [source])
    assert error.value.status_code == 422


@pytest.mark.parametrize('origin', ['', 'http://tracker.example', 'https://tracker.example/path', 'https://user@tracker.example', 'https://localhost'])
def test_unsafe_public_configuration_fails_closed(tmp_path, monkeypatch, origin):
    monkeypatch.delenv('GFL2_FRONTEND_ORIGIN', raising=False)
    monkeypatch.delenv('PUBLIC_ORIGIN', raising=False)
    with pytest.raises(RuntimeError):
        create_public_app(tmp_path, origin=origin)
