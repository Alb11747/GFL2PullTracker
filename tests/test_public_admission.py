"""Relay admission does not grant caller-supplied account names shared authority."""
import time
from threading import Event

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from backend.public_app import create_public_app
from backend.public_jobs import PublicJobs, RESULT_TTL, prepare, prepared_identity
from backend.public_store import PublicStore, digest
from scripts import fetch_pull_history as collector
from tests.test_public_api import FakeGame, ORIGIN, capture, client, initialize


class RejectedGame(FakeGame):
    def request(self, *args, **kwargs):
        raise collector.FetchError('Rejected synthetic credential')


def finish(jobs):
    for thread in list(jobs.threads):
        thread.join(5)
        assert not thread.is_alive()


def new_session(client, address=None):
    client.cookies.clear()
    if address is not None:
        client.headers['X-GFL2-Client-IP'] = address
    initialize(client)


def test_rejected_captures_do_not_consume_another_visitors_account_quota(tmp_path):
    class CredentialsGame(FakeGame):
        def request(self, *args, **kwargs):
            if self.prepared.capture.authorization.endswith('invalid-signature'):
                raise collector.FetchError('Rejected synthetic credential')
            return super().request(*args, **kwargs)

    app = create_public_app(tmp_path, origin=ORIGIN, client_factory=CredentialsGame)
    with TestClient(app, base_url=ORIGIN) as client:
        initialize(client)
        spoof = capture('target').replace('synthetic-signature', 'invalid-signature')
        for _ in range(10):
            response = client.post('/api/public/fetch', json={'capture': spoof})
            assert response.status_code == 202, response.text
            finish(app.state.jobs)
            assert client.get('/api/public/jobs/' + response.json()['id']).json()['status'] == 'failed'
        assert client.post('/api/public/fetch', json={'capture': spoof}).status_code == 429
        # An unrelated session/IP using the actual credential still has quota
        # and capacity, despite ten failures naming the same unverified account.
        new_session(client, '192.0.2.99')
        response = client.post('/api/public/fetch', json={'capture': capture('target')})
        assert response.status_code == 202, response.text
        finish(app.state.jobs)
        assert client.get('/api/public/jobs/' + response.json()['id']).json()['status'] == 'completed'


def test_relay_ip_quota_survives_session_rotation_and_precedes_capture_parsing(client):
    for _ in range(6):
        new_session(client)
        for _ in range(10):
            assert client.post('/api/public/fetch', json={'capture': 'invalid'}).status_code == 422
    new_session(client)
    assert client.post('/api/public/fetch', json={'capture': 'invalid'},
                       headers={'X-Forwarded-For': '192.0.2.99'}).status_code == 429
    # The session has not used its ten-attempt quota; only the trusted IP differs.
    assert client.post('/api/public/fetch', json={'capture': 'invalid'},
                       headers={'X-GFL2-Client-IP': '192.0.2.99'}).status_code == 422


@pytest.mark.parametrize('verified', [False, True])
def test_active_exclusion_requires_verified_identity_and_retains_worker_limits(tmp_path, verified):
    entered, release = Event(), Event()

    class WaitingGame(FakeGame):
        def request(self, *args, **kwargs):
            entered.set()
            assert release.wait(5)
            return super().request(*args, **kwargs)

    identity = prepared_identity(prepare(capture(), None))
    app = create_public_app(tmp_path, origin=ORIGIN, client_factory=WaitingGame,
                            identity_verifier=(lambda _: identity) if verified else None)
    with TestClient(app, base_url=ORIGIN) as client:
        initialize(client)
        payload = {'capture': capture(), 'save_backup': verified}
        try:
            assert client.post('/api/public/fetch', json=payload).status_code == 202
            assert entered.wait(2)
            assert client.post('/api/public/fetch', json=payload).status_code == 409
            new_session(client, '192.0.2.20')
            second = client.post('/api/public/fetch', json=payload)
            assert second.status_code == (409 if verified else 202), second.text
            if not verified:
                new_session(client, '192.0.2.30')
                third = client.post('/api/public/fetch', json={'capture': capture('other')})
                assert third.status_code == 429
                assert 'workers are busy' in third.json()['detail']
        finally:
            release.set()
            finish(app.state.jobs)


def test_account_quota_requires_successful_verification_and_spans_sessions(tmp_path):
    identity = prepared_identity(prepare(capture(), None))

    def verifier(prepared):
        if prepared.capture.authorization.endswith('invalid-signature'):
            raise ValueError('Rejected synthetic credential')
        return identity

    app = create_public_app(tmp_path, origin=ORIGIN, client_factory=RejectedGame,
                            identity_verifier=verifier)
    with TestClient(app, base_url=ORIGIN) as client:
        initialize(client)
        for _ in range(10):
            response = client.post('/api/public/fetch', json={
                'capture': capture().replace('synthetic-signature', 'invalid-signature'), 'save_backup': True})
            assert response.status_code == 403
        for index in range(10):
            new_session(client, f'192.0.2.{index + 20}')
            response = client.post('/api/public/fetch', json={'capture': capture(), 'save_backup': True})
            assert response.status_code == 202, response.text
            finish(app.state.jobs)
        new_session(client, '192.0.2.99')
        response = client.post('/api/public/fetch', json={'capture': capture(), 'save_backup': True})
        assert response.status_code == 429


def test_eight_results_still_reserve_capacity_until_expiry(tmp_path):
    jobs = PublicJobs(PublicStore(tmp_path / 'public.sqlite3'), FakeGame)
    prepared = prepare(capture(), None)
    try:
        identifiers = []
        for _ in range(8):
            identifiers.append(jobs.start('owner', prepared)['id'])
            finish(jobs)
        assert all(jobs.get('owner', key, result=True)['records_document'] for key in identifiers)
        with pytest.raises(HTTPException) as error:
            jobs.start('other-owner', prepared)
        assert error.value.status_code == 503
        jobs.jobs[identifiers[0]]['expires'] = 0
        assert jobs.start('other-owner', prepared)['id']
        finish(jobs)
    finally:
        jobs.close()


def test_terminal_status_eviction_preserves_active_jobs_and_result_payloads(tmp_path):
    jobs = PublicJobs(PublicStore(tmp_path / 'public.sqlite3'), RejectedGame)
    now = time.time()

    def entry(key, expires, status='failed', result=None):
        return dict(id=key, owner=digest('owner'), scope=None, expires=expires,
                    status=status, result=result, message='Synthetic', records=0, pages=0)

    try:
        with jobs.lock:
            jobs.jobs = {f'status-{i:02}': entry(f'status-{i:02}', now + RESULT_TTL) for i in range(64)}
            jobs.jobs['older'] = entry('older', now + 100)
            jobs.jobs['payload'] = entry('payload', now + 50, 'completed', {'retained': True})
            jobs.jobs['active'] = entry('active', 0, 'running')
            jobs.jobs['finishing'] = entry('finishing', now + RESULT_TTL + 1, 'running')
            # The terminal transition itself must enforce the cap, before a
            # subsequent request or maintenance cycle can invoke cleanup.
            jobs.update('finishing', status='failed')
            assert len(jobs.jobs) == 66
            assert 'older' not in jobs.jobs and 'status-00' not in jobs.jobs
            assert jobs.jobs['payload']['result'] == {'retained': True}
            assert 'active' in jobs.jobs
        assert jobs.get('owner', 'finishing')['status'] == 'failed'
        with pytest.raises(HTTPException) as error:
            jobs.get('owner', 'older')
        assert error.value.status_code == 404
        jobs.jobs['status-01']['expires'] = 0
        jobs.jobs['payload']['expires'] = 0
        jobs.cleanup()
        assert 'status-01' not in jobs.jobs and 'payload' not in jobs.jobs
        assert 'active' in jobs.jobs
    finally:
        jobs.close()
