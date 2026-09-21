"""Opt-out-aware error reports containing code locations, never application data."""
import builtins
import os
from pathlib import Path
import re

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
SOURCES = frozenset(path.resolve() for folder in ('backend', 'scripts')
                    for path in (ROOT / folder).glob('*.py'))
OPERATIONS = frozenset(('request', 'relay_start', 'relay_collect', 'relay_finalize'))
PROPERTIES = frozenset(('service', 'environment', 'release', 'operation', '$exception_list',
                        '$process_person_profile', '$geoip_disable', '$lib', '$lib_version', '$is_server'))


def permitted(request):
    """Only the frontend's normalized opt-out decision can enable reporting."""
    return request.headers.getlist('x-gfl2-telemetry') == ['1']


def exception_properties(error, operation, release):
    # Messages, causes, source text, locals and absolute paths may contain captures.
    # Inspect only executable metadata from this repository's known source files.
    frames = []
    trace = error.__traceback__
    while trace is not None:
        code = trace.tb_frame.f_code
        path = Path(code.co_filename).resolve()
        if path in SOURCES and re.fullmatch(r'[A-Za-z_][A-Za-z_0-9<>]{0,79}', code.co_name):
            frames.append({'platform': 'python', 'filename': path.relative_to(ROOT).as_posix(),
                           'function': code.co_name, 'lineno': trace.tb_lineno, 'in_app': True})
        trace = trace.tb_next
    kind = type(error).__name__
    if type(error).__module__ != 'builtins' or getattr(builtins, kind, None) is not type(error):
        kind = 'Error'
    return {'service': 'api', 'environment': 'production', 'release': release,
            'operation': operation, '$process_person_profile': False, '$geoip_disable': True,
            '$exception_list': [{'type': kind, 'value': 'Unexpected tracker service error',
                                 'mechanism': {'type': 'generic', 'handled': True},
                                 # Cymbal requires platform on each frame and a raw
                                 # stacktrace discriminator to create an error issue.
                                 'stacktrace': {'type': 'raw', 'frames': frames[-20:]}}]}


def before_send(event):
    """Drop SDK context enrichment outside our explicit property allowlist."""
    if event.get('event') != '$exception':
        return None
    return {key: value for key, value in {
        **event, 'distinct_id': 'gfl2-api',
        'properties': {key: value for key, value in event.get('properties', {}).items()
                       if key in PROPERTIES},
    }.items() if key in ('event', 'distinct_id', 'properties', 'timestamp', 'uuid')}


class Telemetry:
    def __init__(self, client=None, release='unknown'):
        self.client = client
        self.release = release

    @classmethod
    def from_environment(cls):
        key = os.environ.get('POSTHOG_KEY', '')
        host = os.environ.get('POSTHOG_HOST', 'https://us.i.posthog.com')
        # Tests must explicitly inject a recording client; never contact production.
        if (os.environ.get('GFL2_MODE') != 'public' or not key or
                'PYTEST_CURRENT_TEST' in os.environ or host != 'https://us.i.posthog.com'):
            return cls()
        release = os.environ.get('GFL2_RELEASE', '')
        release = release if re.fullmatch(r'[a-f0-9]{7,40}', release) else 'unknown'
        try:
            from posthog import Posthog
            client = Posthog(key, host=host, max_queue_size=20, flush_at=20, flush_interval=5,
                             timeout=1, max_retries=0, sync_mode=False, disable_geoip=True,
                             enable_exception_autocapture=False, capture_exception_code_variables=False,
                             log_captured_exceptions=False, enable_local_evaluation=False,
                             capture_trace_context=False, before_send=before_send)
            return cls(client, release)
        except Exception:
            # Optional monitoring cannot prevent the application from starting.
            return cls()

    def report(self, error, *, allowed=False, operation='request'):
        if allowed is not True or self.client is None or isinstance(error, HTTPException) or operation not in OPERATIONS:
            return
        try:
            self.client.capture('$exception', distinct_id='gfl2-api',
                                properties=exception_properties(error, operation, self.release))
        except Exception:
            # The error boundary must preserve the original response/job semantics.
            pass

    def close(self):
        client, self.client = self.client, None
        if client is not None:
            try:
                client.shutdown()
            except Exception:
                pass
