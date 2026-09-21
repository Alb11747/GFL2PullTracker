"""Bounded, ephemeral public relay jobs with no cross-user export cache."""
from dataclasses import replace
import json
from pathlib import Path
import tempfile
from threading import BoundedSemaphore, Event, RLock, Thread
import time
from urllib.parse import parse_qsl
from uuid import uuid4

from fastapi import HTTPException

from backend.public_store import account_key, digest, validate_portable
from backend.tracker import canonical, validate_document
from scripts import fetch_pull_history as collector

MAX_RESULT_BYTES = 16 * 1024 * 1024
MAX_RECORDS = 50_000
RESULT_TTL = 900
JOB_SECONDS = 180


def prepare(capture_text, server):
    try:
        capture = collector.parse_capture(capture_text)
        request = collector.prepare_request(capture, server)
        collector.check_token_expiry(request)
        extra = tuple(v for k, v in capture.headers.items() if any(x in k.lower() for x in ('cookie', 'token', 'auth', 'key')))
        extra += tuple(part for part in capture.authorization.split('.') if len(part) >= 8)
        return replace(request, secrets=tuple(dict.fromkeys((*request.secrets, *extra))),
                       forwarded_headers={'authorization': capture.authorization,
                                          'content-type': 'application/x-www-form-urlencoded'})
    except (collector.CollectorError, ValueError, TypeError):
        raise HTTPException(422, 'Invalid or expired capture. Copy a fresh official HTTPS POST request.') from None


def prepared_identity(prepared):
    return dict(account_fingerprint=prepared.account_fingerprint, endpoint_host=prepared.capture.host,
                server=dict(parse_qsl(prepared.body.decode('ascii')))['server'], game_channel_id=prepared.capture.game_channel_id)


class PublicJobs:
    def __init__(self, store, client_factory=None):
        self.store = store
        self.client_factory = client_factory or collector.GachaClient
        self.lock = RLock()
        self.slots = BoundedSemaphore(2)
        self.jobs = {}
        self.threads = []
        self.stopping = Event()
        self.maintenance = Thread(target=self._maintain, daemon=True)
        self.maintenance.start()

    def _maintain(self):
        while not self.stopping.wait(30):
            self.cleanup()
            self.store.cleanup()

    def cleanup(self):
        with self.lock:
            self.jobs = {key: value for key, value in self.jobs.items()
                         if value['expires'] > time.time() or value['status'] in ('queued', 'running', 'cancelling')}
            self.threads = [thread for thread in self.threads if thread.is_alive()]

    def close(self):
        self.stopping.set()
        with self.lock:
            for job in self.jobs.values():
                if not job.get('finalizing') and job.get('cancel_event') is not None:
                    job['cancel_event'].set()
        for thread in self.threads:
            thread.join(timeout=12)
        self.maintenance.join(timeout=1)
        with self.lock:
            self.jobs.clear()

    def public(self, job):
        return {key: job[key] for key in ('id', 'status', 'message', 'records', 'pages')}

    def start(self, token, prepared, account_id=None, save_backup=False, contribute=False):
        self.cleanup()
        with self.lock:
            owner = digest(token)
            scope = account_key(prepared_identity(prepared))
            if self.stopping.is_set() or len(self.jobs) >= 8:
                raise HTTPException(503, 'Relay capacity reached. Try again after existing results expire.')
            if any((job['owner'] == owner or job['scope'] == scope) and job['status'] in ('queued', 'running', 'cancelling') for job in self.jobs.values()):
                raise HTTPException(409, 'A collection is already active for this session or account')
            if not self.slots.acquire(blocking=False):
                raise HTTPException(429, 'Collection workers are busy; retry later with a fresh capture')
            identifier = str(uuid4())
            job = dict(id=identifier, owner=owner, scope=scope, status='queued', message='Waiting to collect', records=0,
                       pages=0, expires=time.time()+RESULT_TTL, result=None, cancel_event=Event(), finalizing=False)
            self.jobs[identifier] = job
            thread = None
            try:
                backup_version = self.store.backup_version(account_id) if account_id and save_backup else None
                thread = Thread(target=self.run, args=(identifier, prepared, account_id, save_backup, contribute, backup_version), daemon=True)
                self.threads.append(thread)
                thread.start()
            except Exception:
                self.jobs.pop(identifier)
                if thread in self.threads:
                    self.threads.remove(thread)
                self.slots.release()
                raise HTTPException(503, 'Worker could not start. Submit a fresh capture to retry.') from None
            return self.public(job)

    def get(self, token, identifier, result=False):
        self.cleanup()
        with self.lock:
            job = self.jobs.get(identifier)
            if not job or job['owner'] != digest(token):
                raise HTTPException(404, 'Collection not found or expired. Interrupted jobs require a fresh capture.')
            if result:
                if job['status'] in ('queued', 'running', 'cancelling'):
                    raise HTTPException(409, 'Collection is still running')
                if not job['result']:
                    raise HTTPException(404, 'No collection result is available; submit a fresh capture')
                return job['result']
            return self.public(job)

    def cancel(self, token, identifier):
        with self.lock:
            self.get(token, identifier)
            job = self.jobs[identifier]
            if job['status'] in ('queued', 'running', 'cancelling') and not job['finalizing']:
                job['cancel_event'].set()
                job.update(status='cancelling', message='Stopping collection and preserving partial history')
            return self.public(job)

    def update(self, identifier, **changes):
        with self.lock:
            if identifier in self.jobs:
                if self.jobs[identifier]['status'] == 'cancelling' and changes.get('status', 'running') == 'running':
                    changes.pop('status', None)
                    changes.pop('message', None)
                self.jobs[identifier].update(changes)

    def run(self, identifier, prepared, account_id, save_backup, contribute, backup_version):
        manager = self
        deadline = time.monotonic() + JOB_SECONDS
        writer = None
        event = self.jobs[identifier]['cancel_event']

        def budget():
            if event.is_set():
                raise collector.CancelledError('Collection stopped by the user.')
            if manager.stopping.is_set() or time.monotonic() >= deadline:
                raise collector.FetchError('Public collection time limit reached')

        class BoundedWriter(collector.ExportWriter):
            def save_page(self, type_id, page, raw, records):
                budget()
                if len(raw) > 2 * 1024 * 1024 or len(self.records) + len(records) > MAX_RECORDS:
                    raise collector.FetchError('Public collection size limit reached')
                if sum(p.stat().st_size for p in self.run_dir.rglob('*') if p.is_file()) + len(raw) > MAX_RESULT_BYTES:
                    raise collector.FetchError('Public collection storage limit reached')
                super().save_page(type_id, page, raw, records)

            def checkpoint(self):
                # No upstream error text needs to be returned by a public relay.
                for entry in self.manifest['types'].values():
                    if 'message' in entry:
                        entry['message'] = 'The provider could not supply this source type.'
                for error in self.manifest['errors']:
                    error['message'] = ('Collection stopped by the user.' if error['kind'] == 'cancelled'
                                        else 'Collection stopped; submit a fresh capture to retry.')
                super().checkpoint()
                manager.update(identifier, records=len(self.records), pages=sum(t['pages'] for t in self.manifest['types'].values()))

        self.update(identifier, status='running', message='Collecting accessible history')
        try:
            # Each collection has its own root, so incremental disk discovery
            # can never see another player's snapshots. No captures are written.
            with tempfile.TemporaryDirectory(prefix='gfl2-relay-') as temp:
                writer = BoundedWriter(Path(temp), prepared, start_type=1, consecutive_misses=10, max_type=1000,
                                       timeout=10, retries=0)
                inner = self.client_factory(prepared, timeout=10, retries=0, max_response_bytes=2*1024*1024,
                                            max_total_bytes=MAX_RESULT_BYTES, max_requests=1000, max_seconds=JOB_SECONDS,
                                            cancel_event=event)

                class BoundedClient:
                    def __init__(self):
                        self.prepared = prepared

                    def request(self, type_id, next_cursor=None):
                        budget()
                        response = inner.request(type_id, next_cursor)
                        budget()
                        if len(response.body) > 2 * 1024 * 1024:
                            raise collector.FetchError('Upstream response exceeded the size limit')
                        return response

                failed = False
                try:
                    collector.PullHistoryCollector(BoundedClient(), writer, start_type=1, consecutive_misses=10,
                                                   max_type=1000, baseline={}).run()
                except collector.CancelledError:
                    pass
                except Exception:
                    failed = True
                    writer.fail_run('collection', 'Collection stopped; submit a fresh capture to retry.')
                # Close the cancellation window before snapshot validation and
                # persistence. A stop accepted first must force incomplete coverage.
                with self.lock:
                    cancelled = event.is_set()
                    self.jobs[identifier]['finalizing'] = True
                    self.update(identifier, message='Saving collected history')
                if cancelled:
                    writer.fail_run('cancelled', 'Collection stopped by the user.')
                document = json.loads((writer.run_dir / 'records.json').read_text(encoding='utf-8'))
                manifest = json.loads((writer.run_dir / 'manifest.json').read_text(encoding='utf-8'))
                pages = {p.relative_to(writer.run_dir).as_posix(): p.read_text(encoding='utf-8') for p in writer.run_dir.glob('raw/**/*.json')}
                result = dict(records_document=document, manifest=manifest, raw_pages=pages)
                validate_portable(result)
                for page in pages.values():
                    validate_portable(json.loads(page.lstrip('\ufeff')))
                validate_document(document, manifest, pages)
                if len(canonical(result).encode()) > MAX_RESULT_BYTES:
                    raise collector.FetchError('Collection result exceeded the size limit')
                status = 'cancelled' if cancelled else 'partial' if failed and document['records'] else 'failed' if failed else 'completed'
                persistence_error = False
                if status != 'failed' and account_id:
                    identity = prepared_identity(prepared)
                    try:
                        if save_backup:
                            self.store.put_backup(account_id, identity, 'Game account', [result], expected_version=backup_version)
                        if contribute:
                            self.store.contribute_collected(account_id, identity, result)
                    except HTTPException:
                        persistence_error = True
                message = ('Collection complete. Accessible history may not include lifetime pulls.' if status == 'completed'
                           else 'Collection stopped by you. Any collected partial history is available to import.' if cancelled
                           else 'Collection stopped. Import the available partial history and use a fresh capture to retry.')
                if persistence_error:
                    message += ' Server storage failed; download this result to preserve it.'
                self.update(identifier, result=result if status != 'failed' else None, status=status,
                            message=message, expires=time.time()+RESULT_TTL)
        except Exception:
            self.update(identifier, status='failed', message='Collection could not complete safely. Submit a fresh capture to retry.',
                        expires=time.time()+RESULT_TTL)
        finally:
            with self.lock:
                if identifier in self.jobs:
                    self.jobs[identifier]['cancel_event'] = None
            self.slots.release()
