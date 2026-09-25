"""Telemetry tests use recording clients and synthetic credentials only."""
import json

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from backend.public_app import create_public_app, public_origin
from backend.public_jobs import PublicJobs, prepare
from backend.public_store import PublicStore
from backend.telemetry import Telemetry, before_send
from scripts import fetch_pull_history as collector
from tests.test_public_api import ORIGIN, FakeGame, capture, initialize

SENTINEL = 'private-capture-authorization-account-google-token'


class Recorder:
    def __init__(self):
        self.events = []
        self.closed = False

    def capture(self, event, **kwargs):
        self.events.append({'event': event, **kwargs})

    def shutdown(self):
        self.closed = True


def test_only_sanitized_exception_metadata_leaves_process():
    client = Recorder()
    telemetry = Telemetry(client, 'a' * 40)
    try:
        try:
            raise ValueError(SENTINEL)
        except ValueError as cause:
            raise RuntimeError('https://provider.example/?token=' + SENTINEL) from cause
    except RuntimeError as error:
        telemetry.report(error, allowed=True)
    assert len(client.events) == 1
    serialized = json.dumps(client.events)
    assert SENTINEL not in serialized
    assert 'provider.example' not in serialized
    assert 'test_telemetry' not in serialized
    properties = client.events[0]['properties']
    assert properties['$exception_list'][0]['type'] == 'RuntimeError'
    assert properties['$exception_list'][0]['value'] == 'Unexpected tracker service error'
    assert properties['$process_person_profile'] is False
    assert properties['service'] == 'api'
    assert properties['release'] == 'a' * 40
    assert client.events[0]['distinct_id'] == 'gfl2-api'
    telemetry.report(HTTPException(503, SENTINEL), allowed=True)
    telemetry.report(RuntimeError(SENTINEL), allowed=False)
    assert len(client.events) == 1
    telemetry.close()
    assert client.closed


def test_sdk_context_is_removed_at_final_send_boundary():
    event = before_send({'event': '$exception', 'distinct_id': SENTINEL,
                         'properties': {'$current_url': SENTINEL, '$ip': SENTINEL,
                                        'service': 'api', '$process_person_profile': False},
                         'groups': {'account': SENTINEL}})
    assert SENTINEL not in json.dumps(event)
    assert event['distinct_id'] == 'gfl2-api'
    assert before_send({'event': '$pageview'}) is None


@pytest.mark.parametrize('headers,expected', [([], 0), ([('x-gfl2-telemetry', '0')], 0),
    ([('x-gfl2-telemetry', 'true')], 0), ([('x-gfl2-telemetry', '1,1')], 0),
    ([('x-gfl2-telemetry', '1'), ('x-gfl2-telemetry', '0')], 0),
    ([('x-gfl2-telemetry', '1')], 1)])
def test_request_error_opt_out_and_sanitized_response(tmp_path, headers, expected):
    recorder = Recorder()
    app = create_public_app(tmp_path, origin=ORIGIN, telemetry=Telemetry(recorder))

    @app.get('/api/public/synthetic-failure')
    def failure():
        raise ValueError(SENTINEL)

    with TestClient(app, base_url=ORIGIN) as client:
        initialize(client)
        response = client.get('/api/public/synthetic-failure', headers=headers)
        assert response.status_code == 500
        assert SENTINEL not in response.text
        assert response.headers['cache-control'] == 'no-store'
        assert len(recorder.events) == expected
        assert SENTINEL not in json.dumps(recorder.events)
        client.post('/api/public/verify', json={'capture': capture()}, headers={'x-gfl2-telemetry': '1'})
        assert len(recorder.events) == expected
    assert recorder.closed


@pytest.mark.parametrize('allowed', [True, False])
@pytest.mark.parametrize('stage', ['collection', 'finalization', 'cancellation', 'both'])
def test_worker_failures_use_submission_preference_once(tmp_path, monkeypatch, allowed, stage):
    recorder = Recorder()
    telemetry = Telemetry(recorder)
    jobs = PublicJobs(PublicStore(tmp_path / 'public.sqlite3'), FakeGame, telemetry=telemetry)

    def fail(*args, **kwargs):
        if stage == 'cancellation':
            raise collector.CancelledError(SENTINEL)
        raise RuntimeError(SENTINEL)

    if stage in ('collection', 'cancellation', 'both'):
        monkeypatch.setattr(collector.PullHistoryCollector, 'run', fail)
    if stage in ('finalization', 'both'):
        monkeypatch.setattr('backend.public_jobs.validate_document', fail)
    try:
        jobs.start('secret-session-' + SENTINEL, prepare(capture(), None), telemetry_allowed=allowed)
        for thread in jobs.threads:
            thread.join(timeout=5)
            assert not thread.is_alive()
        assert len(recorder.events) == int(allowed and stage != 'cancellation')
        assert SENTINEL not in json.dumps(recorder.events)
        if recorder.events:
            frames = recorder.events[0]['properties']['$exception_list'][0]['stacktrace']['frames']
            assert any(frame['filename'] == 'backend/public_jobs.py' for frame in frames)
    finally:
        jobs.close()
        telemetry.close()


def test_monitoring_failure_does_not_change_api_failure_response(tmp_path):
    class Broken(Recorder):
        def capture(self, *args, **kwargs):
            raise RuntimeError('telemetry unavailable')

        def shutdown(self):
            raise RuntimeError('shutdown unavailable')

    app = create_public_app(tmp_path, origin=ORIGIN, telemetry=Telemetry(Broken()))

    @app.get('/api/public/synthetic-failure')
    def failure():
        raise RuntimeError(SENTINEL)

    with TestClient(app, base_url=ORIGIN) as client:
        initialize(client)
        response = client.get('/api/public/synthetic-failure', headers={'x-gfl2-telemetry': '1'})
        assert response.status_code == 500
        assert SENTINEL not in response.text


def test_runtime_configuration_is_disabled_locally_and_in_tests(monkeypatch):
    monkeypatch.setenv('POSTHOG_KEY', 'synthetic')
    monkeypatch.setenv('GFL2_MODE', 'local')
    assert Telemetry.from_environment().client is None
    monkeypatch.setenv('GFL2_MODE', 'public')
    assert Telemetry.from_environment().client is None
    monkeypatch.delenv('PYTEST_CURRENT_TEST')
    monkeypatch.setenv('POSTHOG_HOST', 'https://untrusted.example')
    assert Telemetry.from_environment().client is None
    monkeypatch.delenv('POSTHOG_HOST')
    monkeypatch.delenv('POSTHOG_KEY')
    assert Telemetry.from_environment().client is None


@pytest.mark.parametrize('environment,expected', [
    ('production', 'production'), ('development', 'development'), ('staging', 'staging'),
    ('test', 'test'), (None, 'development'), (SENTINEL, 'development')])
def test_runtime_environment_labels_are_safe(monkeypatch, environment, expected):
    recorder = Recorder()
    monkeypatch.setenv('GFL2_MODE', 'public')
    monkeypatch.setenv('POSTHOG_KEY', 'synthetic')
    monkeypatch.setenv('POSTHOG_HOST', 'https://us.i.posthog.com')
    monkeypatch.delenv('PYTEST_CURRENT_TEST')
    if environment is None:
        monkeypatch.delenv('GFL2_TELEMETRY_ENVIRONMENT', raising=False)
    else:
        monkeypatch.setenv('GFL2_TELEMETRY_ENVIRONMENT', environment)
    monkeypatch.setattr('posthog.Posthog', lambda *args, **kwargs: recorder)
    telemetry = Telemetry.from_environment()
    telemetry.report(RuntimeError(SENTINEL), allowed=True)
    sent = before_send(recorder.events[0])
    assert sent['properties']['environment'] == expected
    assert SENTINEL not in json.dumps(sent)
    telemetry.close()


def test_sdk_configuration_and_shutdown_order(tmp_path, monkeypatch):
    options = {}
    recorder = Recorder()

    def factory(key, **kwargs):
        assert key == 'synthetic'
        options.update(kwargs)
        return recorder

    monkeypatch.setenv('GFL2_MODE', 'public')
    monkeypatch.setenv('POSTHOG_KEY', 'synthetic')
    monkeypatch.setenv('GFL2_RELEASE', 'a' * 40)
    monkeypatch.delenv('PYTEST_CURRENT_TEST')
    monkeypatch.setattr('posthog.Posthog', factory)
    order = []
    original_close = PublicJobs.close

    def close_jobs(jobs):
        original_close(jobs)
        order.append('jobs')

    monkeypatch.setattr(PublicJobs, 'close', close_jobs)
    monkeypatch.setattr(recorder, 'shutdown', lambda: order.append('telemetry'))
    with TestClient(create_public_app(tmp_path, origin=ORIGIN), base_url=ORIGIN):
        assert options['max_queue_size'] == 20
        assert options['sync_mode'] is False
        assert options['max_retries'] == 0
        assert options['timeout'] == 1
        assert options['enable_exception_autocapture'] is False
        assert options['capture_exception_code_variables'] is False
    assert order == ['jobs', 'telemetry']


@pytest.mark.parametrize('header,expected', [('1', True), ('0', False), ('yes', False)])
def test_api_passes_only_normalized_permission_to_worker(tmp_path, monkeypatch, header, expected):
    received = []

    def start(self, *args, account_identity=None, telemetry_allowed=False):
        received.append(telemetry_allowed)
        return {'status': 'queued'}

    monkeypatch.setattr(PublicJobs, 'start', start)
    with TestClient(create_public_app(tmp_path, origin=ORIGIN), base_url=ORIGIN) as client:
        initialize(client)
        response = client.post('/api/public/fetch', json={'capture': capture()},
                               headers={'x-gfl2-telemetry': header})
        assert response.status_code == 202
    assert received == [expected]


def test_real_sdk_send_boundary_omits_system_and_identity_context():
    from posthog import Posthog

    events = []

    def inspect(event):
        safe = before_send(event)
        events.append(safe)
        return safe

    client = Posthog('synthetic', send=False, before_send=inspect, enable_exception_autocapture=False)
    telemetry = Telemetry(client)
    try:
        telemetry.report(RuntimeError(SENTINEL), allowed=True)
        assert len(events) == 1
        assert SENTINEL not in json.dumps(events)
        assert '$os' not in events[0]['properties']
        assert events[0]['properties']['$process_person_profile'] is False
        assert events[0]['properties']['$geoip_disable'] is True
        assert events[0]['distinct_id'] == 'gfl2-api'
    finally:
        telemetry.close()


def test_manual_exception_has_ingestion_stack_schema_without_private_context():
    """An ingested event must also deserialize into an error-tracking issue."""
    recorder = Recorder()
    telemetry = Telemetry(recorder)
    try:
        public_origin('https://example.com/' + SENTINEL)
    except RuntimeError as error:
        telemetry.report(error, allowed=True)
    exception = recorder.events[0]['properties']['$exception_list'][0]
    assert exception['mechanism'] == {'type': 'generic', 'handled': True}
    assert exception['stacktrace']['type'] == 'raw'
    frames = exception['stacktrace']['frames']
    assert frames, 'Use a real application traceback to exercise frame serialization'
    for frame in frames:
        assert frame['platform'] == 'python'
        assert isinstance(frame['lineno'], int) and frame['lineno'] > 0
        assert frame['filename'].startswith(('backend/', 'scripts/'))
        assert set(frame) == {'platform', 'filename', 'function', 'lineno', 'in_app'}
    assert SENTINEL not in json.dumps(recorder.events)
