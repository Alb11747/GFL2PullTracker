"""Background collection with credentials confined to each worker's memory."""
from dataclasses import replace
import json
from threading import Event, Thread
from urllib.parse import parse_qsl
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select

from backend.database import Job, Pull, Snapshot
from backend.tracker import bind_identity, now, public, require_profile
from scripts import fetch_pull_history as collector


class Jobs:
    def __init__(self, tracker, data_dir, client_factory=None):
        self.tracker = tracker
        self.data_dir = data_dir
        self.client_factory = client_factory or collector.GachaClient
        self.threads = []
        self.cancellations = {}
        self.finalizing = set()
        self.results = {}
        with tracker.sessions.begin() as session:
            for job in session.scalars(select(Job).where(Job.status.in_(["queued", "running", "cancelling"]))):
                job.status = "interrupted"
                job.message = "Collection was interrupted. Saved export pages remain on disk. Submit a fresh capture to retry."
                job.updated_at = now()

    def start(self, profile_id, capture_text, server=None):
        try:
            capture = collector.parse_capture(capture_text)
            prepared = collector.prepare_request(capture, server)
            collector.check_token_expiry(prepared)
        except (collector.CollectorError, ValueError):
            # Parser exceptions may embed malformed input. Never return those to
            # the browser or let request-body validation echo the capture.
            raise HTTPException(422, "Capture is invalid or expired. Copy a fresh official HTTPS POST request and verify its server.") from None
        # Include auxiliary credential headers in response-echo protection too.
        extra = tuple(v for k, v in capture.headers.items() if any(x in k for x in ("cookie", "token", "auth", "key")))
        extra += tuple(part for part in capture.authorization.split(".") if len(part) >= 8)
        prepared = replace(prepared, secrets=tuple(dict.fromkeys((*prepared.secrets, *extra))))
        identity = dict(account_fingerprint=prepared.account_fingerprint, endpoint_host=capture.host,
                        server=dict(parse_qsl(prepared.body.decode("ascii")))["server"], game_channel_id=capture.game_channel_id)
        with self.tracker.lock, self.tracker.sessions.begin() as session:
            profile = require_profile(session, profile_id)
            if session.scalar(select(Job.id).where(Job.profile_id == profile_id, Job.status.in_(["queued", "running", "cancelling"]))):
                raise HTTPException(409, "A collection is already active for this profile")
            bind_identity(profile, identity)
            job = Job(id=str(uuid4()), profile_id=profile_id, status="queued", message="Waiting to collect", records=0, pages=0, created_at=now(), updated_at=now())
            session.add(job)
            session.flush()
            result = public(job)
            self.cancellations[job.id] = Event()
            self.threads = [thread for thread in self.threads if thread.is_alive()]
        thread = Thread(target=self.run, args=(job.id, profile_id, prepared), daemon=True)
        self.threads.append(thread)
        try:
            thread.start()
        except RuntimeError:
            with self.tracker.lock:
                self.cancellations.pop(job.id, None)
            self.update(job.id, status="failed", message="The collection worker could not start. Submit a fresh capture to retry.")
            raise HTTPException(503, "The collection worker could not start") from None
        return result

    def get(self, job_id):
        with self.tracker.lock, self.tracker.sessions() as session:
            job = session.get(Job, job_id)
            if job is None:
                raise HTTPException(404, "Job not found")
            require_profile(session, job.profile_id)
            result = public(job)
            if job.import_id:
                snapshot = session.get(Snapshot, job.import_id)
                summary = self.results.get(job_id)
                if summary is None and snapshot is not None:
                    summary = self.tracker.snapshot_public(snapshot)
                    duplicate = snapshot.imported_at < job.created_at
                    summary.update(duplicate=duplicate, added_count=0 if duplicate else snapshot.added_count,
                                   total=session.scalar(select(func.count(Pull.id)).where(Pull.profile_id == job.profile_id)))
                result['import_result'] = summary
            return result

    def cancel(self, job_id):
        # The same lock protects the decision to begin final persistence.
        with self.tracker.lock, self.tracker.sessions.begin() as session:
            job = session.get(Job, job_id)
            if job is None:
                raise HTTPException(404, "Job not found")
            require_profile(session, job.profile_id)
            event = self.cancellations.get(job_id)
            if event is not None and job_id not in self.finalizing and job.status in ('queued', 'running', 'cancelling'):
                event.set()
                job.status = 'cancelling'
                job.message = 'Stopping collection and preserving partial history'
                job.updated_at = now()
        return self.get(job_id)

    def update(self, job_id, **values):
        with self.tracker.lock, self.tracker.sessions.begin() as session:
            job = session.get(Job, job_id)
            if job.status == 'cancelling' and values.get('status', 'running') == 'running':
                values.pop('status', None)
                values.pop('message', None)
            for key, value in values.items():
                setattr(job, key, value)
            job.updated_at = now()

    def run(self, job_id, profile_id, prepared):
        manager = self
        event = self.cancellations[job_id]

        class ProgressWriter(collector.ExportWriter):
            active_type = None

            def start_type(self, type_id):
                self.active_type = type_id
                super().start_type(type_id)

            def checkpoint(self):
                super().checkpoint()
                manager.update(job_id, records=len(self.records), pages=sum(t["pages"] for t in self.manifest["types"].values()),
                               type_id=self.active_type, message="Collecting accessible history")

        writer = None
        failed = False
        self.update(job_id, status="running")
        try:
            writer = ProgressWriter(self.data_dir / "exports", prepared, start_type=1, consecutive_misses=10, max_type=1000,
                                    timeout=collector.DEFAULT_TIMEOUT, retries=collector.DEFAULT_RETRIES)
            client = self.client_factory(prepared, timeout=collector.DEFAULT_TIMEOUT, retries=collector.DEFAULT_RETRIES, cancel_event=event)

            class CancellableClient:
                def __init__(self):
                    self.prepared = prepared

                def request(self, type_id, next_cursor=None):
                    if event.is_set():
                        raise collector.CancelledError('Collection stopped by the user.')
                    response = client.request(type_id, next_cursor)
                    if event.is_set():
                        raise collector.CancelledError('Collection stopped by the user.')
                    return response

            collector.PullHistoryCollector(CancellableClient(), writer, start_type=1, consecutive_misses=10, max_type=1000).run()
        except collector.CancelledError:
            pass
        except Exception:
            failed = True
            if writer is not None and not writer.manifest["errors"]:
                try:
                    writer.fail_run("collection", "Collection failed; submit a fresh capture to retry.")
                except Exception:
                    # A storage failure must not prevent the job from leaving
                    # its active state; any already written pages remain intact.
                    pass
        try:
            with self.tracker.lock:
                cancelled = event.is_set()
                self.finalizing.add(job_id)
                self.update(job_id, message='Saving collected history')
            if cancelled and writer is not None:
                writer.fail_run('cancelled', 'Collection stopped by the user.')
            imported = None
            if writer is not None:
                document = json.loads((writer.run_dir / "records.json").read_text(encoding="utf-8"))
                manifest = json.loads((writer.run_dir / "manifest.json").read_text(encoding="utf-8"))
                pages = {str(path.relative_to(writer.run_dir)).replace("\\", "/"): path.read_text(encoding="utf-8") for path in writer.run_dir.glob("raw/**/*.json")}
                imported = self.tracker.import_snapshot(profile_id, document, manifest, pages)
            status = "cancelled" if cancelled else "completed" if not failed else "partial" if imported and imported["record_count"] else "failed"
            if imported:
                with self.tracker.lock:
                    self.results[job_id] = imported
            self.update(job_id, status=status, import_id=imported["id"] if imported else None,
                        message="Collection complete. This covers accessible history, not necessarily lifetime pulls." if status == "completed" else
                        "Collection stopped by you. Any collected partial history has been saved." if cancelled else
                        "Collection stopped. Any saved partial history is retained; submit a fresh capture to retry.")
        except Exception:
            self.update(job_id, status="failed", message="Collection could not be imported. Saved export pages are retained; submit a fresh capture to retry.")
        finally:
            with self.tracker.lock:
                self.cancellations.pop(job_id, None)
                self.finalizing.discard(job_id)
