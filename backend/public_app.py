"""Public deployment API: browser-owned histories and gated account recovery.

No deployed provider verifier is supplied intentionally. An accepted pull-list
request does not prove that its credential owns the caller-supplied UID. A future
adapter must independently obtain authoritative identity from an official service
or validate the provider's signed binding before returning an identity. Merely
setting an environment flag cannot enable ownership features.
"""
from collections import deque
from contextlib import asynccontextmanager
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
from threading import RLock
import time
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.public_jobs import PublicJobs, prepare, prepared_identity
from backend.public_store import PublicStore, account_key, digest
from backend.tracker import IDENTITY

COOKIE = 'gfl2_session'
SESSION_SECONDS = 7200
UNAVAILABLE = ('Server backup, game-account recovery, and contribution are unavailable: '
               'this provider has no audited credential-to-account binding verifier. '
               'Use browser storage, compressed downloads, or Google Drive. Relay import remains available.')


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class CaptureInput(Strict):
    capture: str = Field(min_length=1, max_length=262_144, repr=False)
    server: str | None = Field(default=None, max_length=30)


class FetchInput(CaptureInput):
    save_backup: bool = False
    contribute: bool = False


class SnapshotInput(Strict):
    records_document: dict
    manifest: dict | None = None
    raw_pages: dict | None = None


class BackupInput(Strict):
    account_id: str = Field(pattern=r'^[0-9a-f]{64}$')
    name: str = Field(default='Game account', min_length=1, max_length=80)
    snapshots: list[SnapshotInput] = Field(min_length=1, max_length=100)


class ContributionInput(Strict):
    account_id: str = Field(pattern=r'^[0-9a-f]{64}$')
    enabled: bool


class RateLimit:
    """Bounded process-local limiter; proxy must rate-limit its real client IPs.

    Never trusts user-supplied X-Forwarded-For. Behind the frontend proxy the
    network bucket protects the entire relay, and session buckets add fairness.
    """
    def __init__(self):
        self.events = {}
        self.lock = RLock()
        self.key = secrets.token_bytes(32)

    def take(self, identity, maximum, period):
        key = hmac.new(self.key, identity.encode(), hashlib.sha256).digest()
        now = time.monotonic()
        with self.lock:
            self.events = {k: (p, q) for k, (p, q) in self.events.items() if q and q[-1] > now-p}
            if key not in self.events and len(self.events) >= 4096:
                raise HTTPException(429, 'Request capacity reached; retry later')
            _, queue = self.events.setdefault(key, (period, deque()))
            while queue and queue[0] <= now-period:
                queue.popleft()
            if len(queue) >= maximum:
                raise HTTPException(429, 'Too many requests; retry later')
            queue.append(now)


def public_origin(value):
    parsed = urlsplit(value or '')
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or parsed.hostname in ('localhost', '127.0.0.1', '::1')):
        raise RuntimeError('Public mode requires an explicit HTTPS GFL2_FRONTEND_ORIGIN without a path')
    return value.rstrip('/')


def create_public_app(data_dir=None, *, origin=None, client_factory=None, identity_verifier=None):
    origin = public_origin(origin or os.environ.get('GFL2_FRONTEND_ORIGIN') or os.environ.get('PUBLIC_ORIGIN'))
    directory = Path(data_dir or os.environ.get('GFL2_DATA_DIR', Path(__file__).resolve().parents[1] / 'data'))
    limiter = RateLimit()

    @asynccontextmanager
    async def lifespan(application):
        directory.mkdir(parents=True, exist_ok=True)
        store = PublicStore(directory / 'public.sqlite3')
        store.cleanup()
        application.state.store = store
        application.state.jobs = PublicJobs(store, client_factory)
        yield
        application.state.jobs.close()

    application = FastAPI(title='GFL2 public tracker', version='0.2.0', lifespan=lifespan,
                          docs_url=None, redoc_url=None, openapi_url=None)
    hosts = os.environ.get('GFL2_API_ALLOWED_HOSTS', 'api,localhost,127.0.0.1,' + urlsplit(origin).hostname).split(',')
    if any(not host.strip() or '*' in host or '/' in host for host in hosts):
        raise RuntimeError('GFL2_API_ALLOWED_HOSTS must list explicit hosts without wildcards')
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=[host.strip() for host in hosts])

    @application.middleware('http')
    async def protect(request, call_next):
        try:
            if request.url.query and re.search(r'(?:capture|token|authorization|uid|openid)=', request.url.query, re.I):
                raise HTTPException(400, 'Credentials must never be supplied in API URLs')
            ip = request.client.host if request.client else 'unknown'
            limiter.take('network:' + ip, 600, 60)
            if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
                if request.headers.get('origin') != origin or request.headers.get('sec-fetch-site') == 'cross-site':
                    raise HTTPException(403, 'An exact same-origin request is required')
                if request.headers.get('content-type', '').split(';')[0] != 'application/json':
                    raise HTTPException(415, 'Use application/json')
                if request.headers.get('content-encoding', 'identity') != 'identity':
                    raise HTTPException(415, 'Compressed request bodies are not accepted')
                token = request.cookies.get(COOKIE)
                session = request.app.state.store.session(token)
                if session is None:
                    raise HTTPException(401, 'Session expired. Reload settings and use a fresh capture.')
                csrf = request.headers.get('x-csrf-token', '')
                if not hmac.compare_digest(digest(csrf), session['csrf_hash']):
                    raise HTTPException(403, 'Invalid CSRF token')
                limiter.take('writes:' + digest(token), 60, 60)
                limit = 16*1024*1024 if request.url.path == '/api/public/backup' else 300_000
                body = bytearray()
                async for chunk in request.stream():
                    if len(body) + len(chunk) > limit:
                        raise HTTPException(413, 'Request exceeds the endpoint size limit')
                    body.extend(chunk)
                request._body = bytes(body)
            response = await call_next(request)
        except HTTPException as exc:
            response = JSONResponse({'detail': exc.detail}, status_code=exc.status_code)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        return response

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        return JSONResponse({'detail': 'Invalid request fields or JSON; no capture data was retained.'}, status_code=422)

    def session_token(request):
        token = request.cookies.get(COOKIE)
        if request.app.state.store.session(token) is None:
            raise HTTPException(401, 'Session expired. Reload settings and verify the account again.')
        return token

    def require_verifier():
        if identity_verifier is None:
            raise HTTPException(503, UNAVAILABLE)

    def verify_prepared(request, prepared):
        require_verifier()
        limiter.take('verify:' + digest(session_token(request)), 10, 3600)
        try:
            identity = identity_verifier(prepared)
        except Exception:
            raise HTTPException(403, 'Provider could not verify credential ownership; copy a fresh capture.') from None
        expected = prepared_identity(prepared)
        if not isinstance(identity, dict) or any(not isinstance(identity.get(k), str) or identity[k] != expected[k] for k in IDENTITY):
            raise HTTPException(403, 'Provider identity does not match the requested account')
        key = request.app.state.store.grant(session_token(request), expected)
        return key, expected

    def owned(request, key):
        require_verifier()
        return request.app.state.store.require_account(session_token(request), key)

    @application.get('/api/health')
    def health():
        return {'status': 'ok', 'version': '0.2.0', 'mode': 'public'}

    @application.get('/api/public/config')
    def config(request: Request, response: Response):
        token = request.cookies.get(COOKIE)
        if request.app.state.store.session(token) is None:
            limiter.take('new-session:' + (request.client.host if request.client else 'unknown'), 120, 3600)
            token = secrets.token_urlsafe(32)
            csrf = digest(token + ':csrf')
            request.app.state.store.create_session(token, csrf, time.time()+SESSION_SECONDS)
            response.set_cookie(COOKIE, token, secure=True, httponly=True, samesite='strict',
                                max_age=SESSION_SECONDS, path='/api/public')
        else:
            csrf = digest(token + ':csrf')
        enabled = identity_verifier is not None
        return dict(mode='public', csrf_token=csrf, features=dict(server_backup=enabled, community_contribution=enabled, relay_import=True),
                    identity_verification=dict(available=enabled, reason=None if enabled else UNAVAILABLE),
                    accounts=request.app.state.store.accounts(token),
                    limits=dict(request_bytes=16*1024*1024, capture_bytes=262_144, collection_seconds=180,
                                collection_records=50_000, result_lifetime_seconds=900, session_seconds=SESSION_SECONDS))

    @application.post('/api/public/verify')
    def verify(body: CaptureInput, request: Request):
        require_verifier()
        key, identity = verify_prepared(request, prepare(body.capture, body.server))
        return dict(account_id=key, identity=identity)

    @application.post('/api/public/fetch', status_code=202)
    def fetch(body: FetchInput, request: Request):
        token = session_token(request)
        limiter.take('fetch:' + digest(token), 10, 3600)
        if body.save_backup or body.contribute:
            require_verifier()
        prepared = prepare(body.capture, body.server)
        limiter.take('account-fetch:' + account_key(prepared_identity(prepared)), 10, 3600)
        account_id = None
        if body.save_backup or body.contribute:
            account_id, _ = verify_prepared(request, prepared)
            request.app.state.store.preference(account_id, body.contribute)
        return request.app.state.jobs.start(token, prepared, account_id, body.save_backup, body.contribute)

    @application.get('/api/public/jobs/{identifier}')
    def job(identifier: str, request: Request):
        return request.app.state.jobs.get(session_token(request), identifier)

    @application.get('/api/public/jobs/{identifier}/result')
    def result(identifier: str, request: Request):
        return request.app.state.jobs.get(session_token(request), identifier, result=True)

    @application.post('/api/public/jobs/{identifier}/cancel')
    def cancel_job(identifier: str, request: Request):
        return request.app.state.jobs.cancel(session_token(request), identifier)

    @application.get('/api/public/backup')
    def backup(account_id: str, request: Request):
        owned(request, account_id)
        return request.app.state.store.get_backup(account_id)

    @application.put('/api/public/backup')
    def save_backup(body: BackupInput, request: Request):
        identity = owned(request, body.account_id)
        return request.app.state.store.put_backup(body.account_id, identity, body.name,
                                                [snapshot.model_dump(exclude_none=True) for snapshot in body.snapshots])

    @application.delete('/api/public/backup')
    def delete_backup(account_id: str, request: Request):
        owned(request, account_id)
        request.app.state.store.delete_backup(account_id)
        return {'deleted': True}

    @application.put('/api/public/contribution')
    def contribution(body: ContributionInput, request: Request):
        owned(request, body.account_id)
        request.app.state.store.preference(body.account_id, body.enabled)
        return {'enabled': body.enabled}

    @application.delete('/api/public/contribution')
    def withdraw(account_id: str, request: Request):
        owned(request, account_id)
        request.app.state.store.preference(account_id, False)
        return {'enabled': False}

    @application.get('/api/public/statistics')
    def statistics(request: Request):
        limiter.take('statistics:' + (request.client.host if request.client else 'unknown'), 30, 60)
        return request.app.state.store.statistics()

    return application
