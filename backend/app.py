"""Loopback FastAPI application; frontend requests arrive through SvelteKit."""
from contextlib import asynccontextmanager
from datetime import date
import math
import os
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.database import Profile, Snapshot, open_database
from backend.jobs import Jobs
from backend.tracker import Tracker, now, public, require_profile


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProfileInput(StrictModel):
    name: str = Field(min_length=1, max_length=80)


class ProfileOutput(BaseModel):
    id: str
    name: str
    account_fingerprint: str | None
    endpoint_host: str | None
    server: str | None
    game_channel_id: str | None
    created_at: str


class ProfilesOutput(BaseModel):
    profiles: list[ProfileOutput]


class ImportInput(StrictModel):
    profile_id: str
    records_document: dict[str, Any]
    manifest: dict[str, Any] | None = None
    raw_pages: dict[str, Any] | None = None


class ImportOutput(BaseModel):
    id: str
    profile_id: str
    record_count: int
    added_count: int
    complete: bool | None
    imported_at: str


class ImportResult(ImportOutput):
    duplicate: bool
    total: int


class ImportsOutput(BaseModel):
    imports: list[ImportOutput]


class FetchInput(StrictModel):
    profile_id: str
    capture: str = Field(min_length=1, max_length=262_144, repr=False)
    server: str | None = Field(default=None, max_length=30)


class JobOutput(BaseModel):
    id: str
    profile_id: str
    status: Literal["queued", "running", "cancelling", "cancelled", "completed", "partial", "failed", "interrupted"]
    message: str
    records: int
    pages: int
    type_id: int | None
    import_id: str | None
    created_at: str
    updated_at: str
    import_result: ImportResult | None = None


class HistoryItem(BaseModel):
    id: int
    item_id: int
    name: str
    kind: str
    rarity: str
    region: str | None
    type_id: int
    pool_id: int
    timestamp: str
    timestamp_order: int
    pity: int
    pity_uncertain: bool
    gap_before: bool
    quantity: int
    source_page: int
    estimated_group_size: int


class HistoryOutput(BaseModel):
    items: list[HistoryItem]
    total: int
    page: int
    page_size: int
    pages: int


class LabelCount(BaseModel):
    label: str
    count: int


class IdCount(BaseModel):
    id: int
    count: int


class StatisticsOutput(BaseModel):
    total: int
    known_total: int
    unknown_total: int
    rarities: list[LabelCount]
    kinds: list[LabelCount]
    types: list[IdCount]
    pools: list[IdCount]
    date_from: str | None
    date_to: str | None
    last_import_at: str | None
    latest_import_complete: bool | None
    coverage: Literal["accessible_history_only"]
    estimated_multi_groups: int


class FiltersOutput(BaseModel):
    rarities: list[str]
    kinds: list[str]
    types: list[int]
    pools: list[int]


def filters(profile_id: str, q: str | None = Query(None, max_length=200), rarity: str | None = None,
            kind: str | None = None, type_id: int | None = Query(None, ge=1), pool_id: int | None = Query(None, ge=0),
            date_from: date | None = None, date_to: date | None = None):
    if date_from and date_to and date_from > date_to:
        raise HTTPException(422, "Start date must be on or before end date")
    return dict(profile_id=profile_id, q=q, rarity=rarity, kind=kind, type_id=type_id, pool_id=pool_id,
                date_from=date_from.isoformat() if date_from else None, date_to=date_to.isoformat() if date_to else None)


def create_app(data_dir=None, *, catalog_path=None, client_factory=None):
    if os.environ.get("GFL2_MODE", "local") == "public":
        from backend.public_app import create_public_app
        return create_public_app(data_dir, client_factory=client_factory)
    if os.environ.get("GFL2_MODE", "local") != "local":
        raise RuntimeError("GFL2_MODE must be local or public")
    data_dir = Path(data_dir or os.environ.get("GFL2_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))

    @asynccontextmanager
    async def lifespan(application):
        data_dir.mkdir(parents=True, exist_ok=True)
        engine, sessions = open_database(data_dir / "tracker.sqlite3")
        tracker = Tracker(sessions, catalog_path)
        application.state.tracker = tracker
        application.state.jobs = Jobs(tracker, data_dir, client_factory)
        yield
        # Daemon workers may be mid-request at process exit. Their saved status
        # is deliberately recovered as interrupted on the next startup.
        engine.dispose()

    application = FastAPI(title="GFL2 local pull tracker", version="0.1.0", lifespan=lifespan)
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]"])
    origins = {"http://127.0.0.1:5173", "http://127.0.0.1:3000", "http://localhost:5173", "http://localhost:3000"}
    if os.environ.get("GFL2_FRONTEND_ORIGIN"):
        origins.add(os.environ["GFL2_FRONTEND_ORIGIN"])

    @application.middleware("http")
    async def protect_local_writes(request, call_next):
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            if request.headers.get("origin") and request.headers["origin"] not in origins:
                return JSONResponse({"detail": "Foreign origins cannot modify the local tracker"}, status_code=403)
            if request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"detail": "Cross-site writes are not allowed"}, status_code=403)
            if request.headers.get("content-type", "").split(";")[0] != "application/json":
                return JSONResponse({"detail": "Use application/json"}, status_code=415)
            # Bound chunked bodies too; Content-Length alone is not sufficient.
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 64 * 1024 * 1024:
                    return JSONResponse({"detail": "Import exceeds the 64 MiB limit"}, status_code=413)
            request._body = bytes(body)
        return await call_next(request)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        return JSONResponse({"detail": "Invalid request fields or JSON. Check the required values and formats."}, status_code=422)

    def tracker(request: Request):
        return request.app.state.tracker

    @application.get("/api/health")
    def health():
        return {"status": "ok", "version": "0.1.0"}

    @application.get("/api/profiles", response_model=ProfilesOutput)
    def profiles(store: Tracker = Depends(tracker)):
        with store.sessions() as session:
            return {"profiles": [public(p) for p in session.scalars(select(Profile).where(Profile.owner_id == "local").order_by(Profile.created_at))]}

    @application.post("/api/profiles", response_model=ProfileOutput, status_code=201)
    def create_profile(body: ProfileInput, store: Tracker = Depends(tracker)):
        if not body.name.strip():
            raise HTTPException(422, "Give the profile a name")
        with store.lock, store.sessions.begin() as session:
            profile = Profile(id=str(uuid4()), owner_id="local", name=body.name.strip(), created_at=now())
            session.add(profile)
            session.flush()
            return public(profile)

    @application.post("/api/imports", response_model=ImportResult, status_code=201)
    def import_records(body: ImportInput, store: Tracker = Depends(tracker)):
        return store.import_snapshot(body.profile_id, body.records_document, body.manifest, body.raw_pages)

    @application.get("/api/imports", response_model=ImportsOutput)
    def imports(profile_id: str, store: Tracker = Depends(tracker)):
        with store.sessions() as session:
            require_profile(session, profile_id)
            return {"imports": [store.snapshot_public(s) for s in session.scalars(select(Snapshot).where(Snapshot.profile_id == profile_id).order_by(Snapshot.imported_at.desc()))]}

    @application.post("/api/fetch", response_model=JobOutput, status_code=202)
    def fetch(body: FetchInput, request: Request):
        return request.app.state.jobs.start(body.profile_id, body.capture, body.server)

    @application.get("/api/jobs/{job_id}", response_model=JobOutput)
    def job_status(job_id: str, request: Request):
        return request.app.state.jobs.get(job_id)

    @application.post("/api/jobs/{job_id}/cancel", response_model=JobOutput)
    def cancel_job(job_id: str, request: Request):
        return request.app.state.jobs.cancel(job_id)

    @application.get("/api/history", response_model=HistoryOutput)
    def history(selected: dict = Depends(filters), page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200), store: Tracker = Depends(tracker)):
        rows = store.history(selected["profile_id"], selected)
        return dict(items=rows[(page-1)*page_size:page*page_size], total=len(rows), page=page, page_size=page_size, pages=max(1, math.ceil(len(rows)/page_size)))

    @application.get("/api/statistics", response_model=StatisticsOutput)
    def statistics(selected: dict = Depends(filters), store: Tracker = Depends(tracker)):
        return store.statistics(selected["profile_id"], store.history(selected["profile_id"], selected))

    @application.get("/api/filters", response_model=FiltersOutput)
    def filter_options(profile_id: str, store: Tracker = Depends(tracker)):
        rows = store.history(profile_id, {})
        return dict(rarities=sorted({r["rarity"] for r in rows}), kinds=sorted({r["kind"] for r in rows}),
                    types=sorted({r["type_id"] for r in rows}), pools=sorted({r["pool_id"] for r in rows}))

    return application


app = create_app()
