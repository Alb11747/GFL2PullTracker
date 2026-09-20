"""Background collection with credentials confined to each worker's memory."""
from dataclasses import replace
import json
from threading import Thread
from urllib.parse import parse_qsl
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select

from backend.database import Job
from backend.tracker import bind_identity, now, public, require_profile
from scripts import fetch_pull_history as collector


class Jobs:
    def __init__(self, tracker, data_dir, client_factory=None):
        self.tracker = tracker
        self.data_dir = data_dir
        self.client_factory = client_factory or collector.GachaClient
        self.threads = []
        with tracker.sessions.begin() as session:
            for job in session.scalars(select(Job).where(Job.status.in_(["queued", "running"]))):
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
            if session.scalar(select(Job.id).where(Job.profile_id == profile_id, Job.status.in_(["queued", "running"]))):
                raise HTTPException(409, "A collection is already active for this profile")
            bind_identity(profile, identity)
            job = Job(id=str(uuid4()), profile_id=profile_id, status="queued", message="Waiting to collect", records=0, pages=0, created_at=now(), updated_at=now())
            session.add(job)
            session.flush()
            result = public(job)
        thread = Thread(target=self.run, args=(job.id, profile_id, prepared), daemon=True)
        self.threads.append(thread)
        try:
            thread.start()
        except RuntimeError:
            self.update(job.id, status="failed", message="The collection worker could not start. Submit a fresh capture to retry.")
            raise HTTPException(503, "The collection worker could not start") from None
        return result

    def update(self, job_id, **values):
        with self.tracker.lock, self.tracker.sessions.begin() as session:
            job = session.get(Job, job_id)
            for key, value in values.items():
                setattr(job, key, value)
            job.updated_at = now()

    def run(self, job_id, profile_id, prepared):
        manager = self

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
            client = self.client_factory(prepared, timeout=collector.DEFAULT_TIMEOUT, retries=collector.DEFAULT_RETRIES)
            collector.PullHistoryCollector(client, writer, start_type=1, consecutive_misses=10, max_type=1000).run()
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
            imported = None
            if writer is not None:
                document = json.loads((writer.run_dir / "records.json").read_text(encoding="utf-8"))
                manifest = json.loads((writer.run_dir / "manifest.json").read_text(encoding="utf-8"))
                pages = {str(path.relative_to(writer.run_dir)).replace("\\", "/"): path.read_text(encoding="utf-8") for path in writer.run_dir.glob("raw/**/*.json")}
                imported = self.tracker.import_snapshot(profile_id, document, manifest, pages)
            status = "completed" if not failed else "partial" if imported and imported["record_count"] else "failed"
            self.update(job_id, status=status, import_id=imported["id"] if imported else None,
                        message="Collection complete. This covers accessible history, not necessarily lifetime pulls." if status == "completed" else
                        "Collection stopped. Any saved partial history is retained; submit a fresh capture to retry.")
        except Exception:
            self.update(job_id, status="failed", message="Collection could not be imported. Saved export pages are retained; submit a fresh capture to retry.")
