"""Cancellation preserves validated pages and never crosses an owner's boundary."""
import json
from threading import Event, Thread

from fastapi.testclient import TestClient
import pytest

from backend.app import create_app
from backend.public_app import create_public_app
from scripts import fetch_pull_history as collector
from tests.test_tracker import FakeClient, capture, profile
from tests.test_public_api import FakeGame, ORIGIN, capture as public_capture, initialize


@pytest.mark.parametrize('public', [False, True])
@pytest.mark.parametrize('stop_after_page', [False, True])
def test_cancel_retains_only_saved_pages_and_is_idempotent(tmp_path, public, stop_after_page):
    entered, release = Event(), Event()
    base = FakeGame if public else FakeClient

    class WaitingClient(base):
        def __init__(self, prepared, **kwargs):
            super().__init__(prepared, **kwargs)
            self.requests = 0

        def request(self, type_id, next_cursor=None):
            self.requests += 1
            if self.requests == (2 if stop_after_page else 1):
                entered.set()
                assert release.wait(5)
            response = super().request(type_id, next_cursor)
            payload = json.loads(response.body)
            payload['data']['next'] = 'another-page'
            return collector.HttpResponse(200, 'OK', {}, json.dumps(payload).encode())

    app = (create_public_app(tmp_path, origin=ORIGIN, client_factory=WaitingClient) if public
           else create_app(tmp_path, client_factory=WaitingClient))
    prefix = '/api/public' if public else '/api'
    with TestClient(app, base_url=ORIGIN if public else 'http://127.0.0.1:8000') as client:
        if public:
            initialize(client)
            payload = {'capture': public_capture()}
        else:
            payload = {'capture': capture(), 'profile_id': profile(client)}
        identifier = client.post(prefix + '/fetch', json=payload).json()['id']
        try:
            assert entered.wait(3)
            stopped = client.post(f'{prefix}/jobs/{identifier}/cancel', json={})
            assert stopped.status_code == 200
            assert stopped.json()['status'] == 'cancelling'
            assert client.post(f'{prefix}/jobs/{identifier}/cancel', json={}).json()['status'] == 'cancelling'
            assert client.post(prefix + '/fetch', json=payload).status_code == 409
            if public:
                app.state.jobs.jobs[identifier]['expires'] = 0
                assert client.get(f'{prefix}/jobs/{identifier}').status_code == 200
                assert client.get(f'{prefix}/jobs/{identifier}/result').status_code == 409
        finally:
            release.set()
            for thread in app.state.jobs.threads:
                thread.join(5)
                assert not thread.is_alive()
        job = client.get(f'{prefix}/jobs/{identifier}').json()
        assert job['status'] == 'cancelled'
        assert client.post(f'{prefix}/jobs/{identifier}/cancel', json={}).json()['status'] == 'cancelled'
        expected = (2 if public else 1) if stop_after_page else 0
        assert job['records'] == expected
        if public:
            result = client.get(f'{prefix}/jobs/{identifier}/result').json()
            assert len(result['records_document']['records']) == expected
            assert result['manifest']['complete'] is False
            assert app.state.jobs.jobs[identifier]['cancel_event'] is None
            assert app.state.jobs.slots.acquire(blocking=False)
            assert app.state.jobs.slots.acquire(blocking=False)
            app.state.jobs.slots.release()
            app.state.jobs.slots.release()
        else:
            assert job['import_result']['record_count'] == expected
            assert job['import_result']['added_count'] == expected
            assert job['import_result']['total'] == expected
            assert job['import_result']['complete'] is False
            assert not app.state.jobs.cancellations and not app.state.jobs.finalizing
            assert client.get('/api/history', params={'profile_id': payload['profile_id']}).json()['total'] == expected
        serialized = json.dumps(job) + (json.dumps(result) if public else '')
        assert 'synthetic-signature' not in serialized
        assert 'synthetic-secret-signature' not in serialized


@pytest.mark.parametrize('public', [False, True])
def test_cancel_before_worker_collects_makes_no_requests(tmp_path, monkeypatch, public):
    from backend.jobs import Jobs
    from backend.public_jobs import PublicJobs
    manager = PublicJobs if public else Jobs
    original = manager.run
    entered, release = Event(), Event()

    def delayed(self, *args):
        entered.set()
        assert release.wait(5)
        original(self, *args)

    class NoRequests:
        def __init__(self, prepared, **kwargs):
            self.prepared = prepared

        def request(self, *args):
            pytest.fail('A cancelled queued job must not contact the provider')

    monkeypatch.setattr(manager, 'run', delayed)
    app = (create_public_app(tmp_path, origin=ORIGIN, client_factory=NoRequests) if public
           else create_app(tmp_path, client_factory=NoRequests))
    prefix = '/api/public' if public else '/api'
    with TestClient(app, base_url=ORIGIN if public else 'http://127.0.0.1:8000') as client:
        if public:
            initialize(client)
            payload = {'capture': public_capture()}
        else:
            payload = {'capture': capture(), 'profile_id': profile(client)}
        identifier = client.post(prefix + '/fetch', json=payload).json()['id']
        try:
            assert entered.wait(3)
            assert client.post(f'{prefix}/jobs/{identifier}/cancel', json={}).json()['status'] == 'cancelling'
        finally:
            release.set()
            for thread in app.state.jobs.threads:
                thread.join(5)
        assert client.get(f'{prefix}/jobs/{identifier}').json()['status'] == 'cancelled'


@pytest.mark.parametrize('public', [False, True])
def test_cancel_cannot_interrupt_final_persistence(tmp_path, monkeypatch, public):
    entered, release = Event(), Event()
    app = (create_public_app(tmp_path, origin=ORIGIN, client_factory=FakeGame) if public
           else create_app(tmp_path, client_factory=FakeClient))
    prefix = '/api/public' if public else '/api'
    with TestClient(app, base_url=ORIGIN if public else 'http://127.0.0.1:8000') as client:
        if public:
            from backend import public_jobs
            target, name = public_jobs, 'validate_document'
            initialize(client)
            payload = {'capture': public_capture()}
        else:
            target, name = app.state.tracker, 'import_snapshot'
            payload = {'capture': capture(), 'profile_id': profile(client)}
        original = getattr(target, name)

        def delayed(*args, **kwargs):
            entered.set()
            assert release.wait(5)
            return original(*args, **kwargs)

        monkeypatch.setattr(target, name, delayed)
        identifier = client.post(prefix + '/fetch', json=payload).json()['id']
        try:
            assert entered.wait(3)
            response = client.post(f'{prefix}/jobs/{identifier}/cancel', json={})
            assert response.json()['status'] == 'running'
            assert 'Saving' in response.json()['message']
        finally:
            release.set()
            for thread in app.state.jobs.threads:
                thread.join(5)
        assert client.get(f'{prefix}/jobs/{identifier}').json()['status'] == 'completed'


def test_public_cancel_enforces_session_origin_and_csrf(tmp_path):
    with TestClient(create_public_app(tmp_path, origin=ORIGIN, client_factory=FakeGame), base_url=ORIGIN) as client:
        initialize(client)
        identifier = client.post('/api/public/fetch', json={'capture': public_capture()}).json()['id']
        for thread in client.app.state.jobs.threads:
            thread.join(5)
        url = f'/api/public/jobs/{identifier}/cancel'
        for headers in ({'X-CSRF-Token': 'wrong'}, {'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}):
            assert client.post(url, json={}, headers=headers).status_code == 403
        client.cookies.clear()
        initialize(client)
        assert client.post(url, json={}).status_code == 404


def test_retry_wait_is_interruptible_and_never_retries_cancelled_capture():
    cancelled, waiting = Event(), Event()
    requests = []
    outcomes = []

    class ObservableEvent:
        def is_set(self):
            return cancelled.is_set()

        def wait(self, seconds):
            waiting.set()
            return cancelled.wait(seconds)

    def request(*args):
        requests.append(args)
        return collector.HttpResponse(429, 'Retry later', {'retry-after': '30'}, b'')

    client = collector.GachaClient(collector.prepare_request(collector.parse_capture(capture())),
                                  retries=3, request_once=request, cancel_event=ObservableEvent())

    def run():
        try:
            client.request(3)
        except collector.CancelledError:
            outcomes.append('cancelled')

    thread = Thread(target=run)
    thread.start()
    try:
        assert waiting.wait(2)
        cancelled.set()
        thread.join(2)
        assert not thread.is_alive()
        assert outcomes == ['cancelled'] and len(requests) == 1
    finally:
        cancelled.set()
        thread.join(2)


@pytest.mark.parametrize('public', [False, True])
def test_accepted_stop_overrides_collector_completion_before_persistence(tmp_path, monkeypatch, public):
    entered, release = Event(), Event()
    original = collector.ExportWriter.complete_run

    def complete_then_wait(writer):
        original(writer)
        entered.set()
        assert release.wait(5)

    monkeypatch.setattr(collector.ExportWriter, 'complete_run', complete_then_wait)
    app = (create_public_app(tmp_path, origin=ORIGIN, client_factory=FakeGame) if public
           else create_app(tmp_path, client_factory=FakeClient))
    prefix = '/api/public' if public else '/api'
    with TestClient(app, base_url=ORIGIN if public else 'http://127.0.0.1:8000') as client:
        if public:
            initialize(client)
            payload = {'capture': public_capture()}
        else:
            payload = {'capture': capture(), 'profile_id': profile(client)}
        identifier = client.post(prefix + '/fetch', json=payload).json()['id']
        try:
            assert entered.wait(3)
            assert client.post(f'{prefix}/jobs/{identifier}/cancel', json={}).json()['status'] == 'cancelling'
        finally:
            release.set()
            for thread in app.state.jobs.threads:
                thread.join(5)
        job = client.get(f'{prefix}/jobs/{identifier}').json()
        assert job['status'] == 'cancelled'
        if public:
            assert client.get(f'{prefix}/jobs/{identifier}/result').json()['manifest']['complete'] is False
        else:
            assert job['import_result']['complete'] is False


def test_cancel_during_response_read_closes_connection(monkeypatch):
    stopped = Event()
    closed = []
    reads = []

    class Response:
        def read1(self, limit):
            reads.append(limit)
            stopped.set()
            return b'partial response'

    class Connection:
        def __init__(self, *args, **kwargs):
            pass

        def request(self, *args, **kwargs):
            pass

        def getresponse(self):
            return Response()

        def close(self):
            closed.append(True)

    monkeypatch.setattr(collector.http.client, 'HTTPSConnection', Connection)
    client = collector.GachaClient(collector.prepare_request(collector.parse_capture(capture())), cancel_event=stopped)
    with pytest.raises(collector.CancelledError):
        client.request(3)
    assert len(reads) == 1 and closed == [True]


def test_local_import_summary_survives_restart(tmp_path):
    with TestClient(create_app(tmp_path, client_factory=FakeClient), base_url='http://127.0.0.1:8000') as client:
        identifier = client.post('/api/fetch', json={'capture': capture(), 'profile_id': profile(client)}).json()['id']
        for thread in client.app.state.jobs.threads:
            thread.join(5)
        summary = client.get(f'/api/jobs/{identifier}').json()['import_result']
        assert summary['added_count'] == summary['total'] == 1
    with TestClient(create_app(tmp_path), base_url='http://127.0.0.1:8000') as client:
        assert client.get(f'/api/jobs/{identifier}').json()['import_result'] == summary


def test_public_worker_setup_failure_releases_capacity(tmp_path, monkeypatch):
    from backend.public_jobs import PublicJobs, prepare
    from backend.public_store import PublicStore
    from fastapi import HTTPException

    store = PublicStore(tmp_path / 'public.sqlite3')
    manager = PublicJobs(store, FakeGame)

    def broken_backup_version(*args):
        raise RuntimeError('storage unavailable')

    monkeypatch.setattr(store, 'backup_version', broken_backup_version)
    try:
        with pytest.raises(HTTPException) as error:
            manager.start('synthetic-session', prepare(public_capture(), None), account_id='synthetic-account', save_backup=True)
        assert error.value.status_code == 503
        assert not manager.jobs and not manager.threads
        assert manager.slots.acquire(blocking=False)
        assert manager.slots.acquire(blocking=False)
        manager.slots.release()
        manager.slots.release()
    finally:
        manager.close()
