#!/usr/bin/env python3
"""Download every accessible GFL2 pull-history page from a copied HTTP request.

The capture may be pasted interactively or read from a file or stdin. Credentials
and the account identifier are used only in memory and never written to the export.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import json
import os
import re
import socket
import sys
import tempfile
import time
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Sequence
from urllib.parse import parse_qsl, quote, urlencode, urlsplit


SCHEMA_VERSION = 2
DEFAULT_START_TYPE = 1
DEFAULT_CONSECUTIVE_MISSES = 10
DEFAULT_MAX_TYPE = 1000
DEFAULT_TIMEOUT = 20.0
DEFAULT_RETRIES = 3

EXIT_OK = 0
EXIT_INPUT = 2
EXIT_CONTROL = 3
EXIT_INCOMPLETE = 4

OFFICIAL_HOSTS = frozenset(
    {
        "gf2-gacha-record-us.sunborngame.com",
        "gf2-gacha-record.sunborngame.com",
        "gf2-gacha-record-asia.haoplay.com",
        "gf2-gacha-record-jp.haoplay.com",
        "gf2-gacha-record-kr.haoplay.com",
        "gf2-gacha-record-intl.haoplay.com",
    }
)

BLOCKED_FORWARD_HEADERS = frozenset(
    {
        "accept-encoding",
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)

REQUEST_LINE_RE = re.compile(r"^(POST)\s+(\S+)\s+HTTP/\d(?:\.\d)?$", re.IGNORECASE)
RESPONSE_LINE_RE = re.compile(r"^HTTP/\d(?:\.\d)?\s+\d{3}(?:\s|$)", re.IGNORECASE)
HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
AUTH_HEADER_RE = re.compile(r"(?i)(authorization\s*[:=]\s*)[^\s,;]+")
QUERY_USER_RE = re.compile(r"(?i)([?&]u=)[^&\s]+")


class CollectorError(Exception):
    """Base exception for collector failures."""


class InputError(CollectorError):
    """The supplied capture or command-line configuration is invalid."""


class ControlError(CollectorError):
    """The known captured type cannot validate the credential or protocol."""


class FetchError(CollectorError):
    """A request or response failed unexpectedly."""


@dataclass(frozen=True)
class Capture:
    scheme: str
    host: str
    path: str
    query_pairs: tuple[tuple[str, str], ...]
    headers: dict[str, str]
    authorization: str
    account_value: str
    game_channel_id: str
    captured_type_id: int
    captured_body: str
    content_length: int | None
    original_url: str


@dataclass(frozen=True)
class PreparedRequest:
    capture: Capture
    body: bytes
    forwarded_headers: dict[str, str]
    token_metadata: dict[str, Any] | None
    account_fingerprint: str
    secrets: tuple[str, ...]


@dataclass(frozen=True)
class HttpResponse:
    status: int
    reason: str
    headers: dict[str, str]
    body: bytes


@dataclass(frozen=True)
class TypeOutcome:
    type_id: int
    status: str
    pages: int
    records: int

    @property
    def has_records(self) -> bool:
        return self.records > 0


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso_utc(value: datetime | None = None) -> str:
    current = value or utc_now()
    return current.isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_capture(text: str) -> Capture:
    """Parse the first HTTP request block from copied request/response text."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")

    request_index = next(
        (index for index, line in enumerate(lines) if REQUEST_LINE_RE.match(line.strip())),
        None,
    )
    if request_index is None:
        raise InputError("No absolute POST request line was found in the capture.")

    request_match = REQUEST_LINE_RE.match(lines[request_index].strip())
    assert request_match is not None
    request_url = request_match.group(2)

    headers: dict[str, str] = {}
    header_end: int | None = None
    for index in range(request_index + 1, len(lines)):
        line = lines[index]
        if not line.strip():
            header_end = index
            break
        if line[:1].isspace():
            raise InputError("Folded HTTP headers are not supported.")
        if ":" not in line:
            raise InputError(f"Malformed request header on line {index + 1}.")
        name, value = line.split(":", 1)
        name = name.strip()
        if not HEADER_NAME_RE.fullmatch(name):
            raise InputError(f"Invalid request header name on line {index + 1}.")
        lower_name = name.lower()
        if lower_name in headers:
            raise InputError(f"Duplicate request header: {name}")
        headers[lower_name] = value.strip()

    if header_end is None:
        header_end = len(lines)

    body_lines = lines[header_end + 1 :]
    response_index = next(
        (index for index, line in enumerate(body_lines) if RESPONSE_LINE_RE.match(line.strip())),
        len(body_lines),
    )
    captured_body = "\n".join(body_lines[:response_index]).strip()

    parsed_url = urlsplit(request_url)
    if parsed_url.scheme.lower() != "https":
        raise InputError("The captured request URL must use HTTPS.")
    if parsed_url.username or parsed_url.password:
        raise InputError("Credentials in the request URL are not allowed.")
    host = (parsed_url.hostname or "").lower()
    if host not in OFFICIAL_HOSTS:
        raise InputError("The captured request does not target an official GFL2 gacha host.")
    if parsed_url.port not in (None, 443):
        raise InputError("Only the default HTTPS port is allowed.")
    if parsed_url.path != "/list":
        raise InputError("The captured request must target the /list endpoint.")

    captured_host = headers.get("host")
    if captured_host and captured_host.lower().removesuffix(":443") != host:
        raise InputError("The Host header does not match the request URL.")

    authorization = headers.get("authorization", "")
    if not authorization:
        raise InputError("The capture is missing the Authorization header.")

    query_pairs = tuple(parse_qsl(parsed_url.query, keep_blank_values=True))

    def require_query_value(name: str) -> str:
        values = [value for key, value in query_pairs if key == name]
        if len(values) != 1 or not values[0]:
            raise InputError(f"The request URL must contain exactly one non-empty {name} value.")
        return values[0]

    game_channel_id = require_query_value("game_channel_id")
    account_value = require_query_value("u")
    type_value = require_query_value("type_id")
    try:
        captured_type_id = int(type_value)
    except ValueError as exc:
        raise InputError("The captured type_id must be an integer.") from exc
    if captured_type_id < 1:
        raise InputError("The captured type_id must be positive.")

    content_length: int | None = None
    if "content-length" in headers:
        try:
            content_length = int(headers["content-length"])
        except ValueError as exc:
            raise InputError("Content-Length must be an integer.") from exc
        if content_length < 0:
            raise InputError("Content-Length cannot be negative.")

    return Capture(
        scheme="https",
        host=host,
        path=parsed_url.path,
        query_pairs=query_pairs,
        headers=headers,
        authorization=authorization,
        account_value=account_value,
        game_channel_id=game_channel_id,
        captured_type_id=captured_type_id,
        captured_body=captured_body,
        content_length=content_length,
        original_url=request_url,
    )


def decode_token_metadata(authorization: str) -> dict[str, Any]:
    """Decode the non-secret metadata segment without validating its signature."""
    token = authorization.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    segment = token.split(".", 1)[0]
    if not segment:
        raise InputError("Authorization token metadata is missing.")
    padded = segment + ("=" * (-len(segment) % 4))
    try:
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
        metadata = json.loads(decoded.decode("utf-8"))
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise InputError("Authorization token metadata could not be decoded.") from exc
    if not isinstance(metadata, dict):
        raise InputError("Authorization token metadata is not a JSON object.")
    return metadata


def _single_form_value(body: str, name: str) -> str | None:
    if not body:
        return None
    values = [value for key, value in parse_qsl(body, keep_blank_values=True) if key == name]
    if not values:
        return None
    if len(values) != 1 or not values[0]:
        raise InputError(f"The captured form body has an invalid {name} value.")
    return values[0]


def _validate_server_value(value: Any) -> str:
    server = str(value).strip()
    if not server or not server.isdecimal():
        raise InputError("The server value must be a non-negative integer.")
    return server


def prepare_request(capture: Capture, server_override: str | None = None) -> PreparedRequest:
    """Choose the server form value, sanitize headers, and prepare secrets."""
    metadata: dict[str, Any] | None = None
    try:
        metadata = decode_token_metadata(capture.authorization)
    except InputError:
        if server_override is None and _single_form_value(capture.captured_body, "server") is None:
            raise

    captured_server = _single_form_value(capture.captured_body, "server")
    token_server = metadata.get("tinx") if metadata is not None else None

    if server_override is not None:
        server = _validate_server_value(server_override)
        override_explains_length_mismatch = True
    elif captured_server is not None:
        server = _validate_server_value(captured_server)
        override_explains_length_mismatch = False
        if token_server is not None and server != _validate_server_value(token_server):
            raise InputError("The captured server value does not match token metadata.")
    elif token_server is not None:
        server = _validate_server_value(token_server)
        override_explains_length_mismatch = False
    else:
        raise InputError("Could not derive the server value; pass --server explicitly.")

    body = urlencode({"server": server}).encode("ascii")
    if (
        capture.content_length is not None
        and capture.content_length != len(body)
        and not override_explains_length_mismatch
    ):
        raise InputError(
            "The reconstructed form body does not match the captured Content-Length; "
            "pass --server only after verifying the correct server value."
        )

    forwarded_headers = {
        name: value
        for name, value in capture.headers.items()
        if name not in BLOCKED_FORWARD_HEADERS
    }
    forwarded_headers.setdefault("content-type", "application/x-www-form-urlencoded")

    fingerprint = hashlib.sha256(capture.account_value.encode("utf-8")).hexdigest()
    secrets = tuple(
        dict.fromkeys(
            value
            for value in (
                capture.authorization,
                capture.account_value,
                quote(capture.account_value, safe=""),
                capture.original_url,
            )
            if value
        )
    )
    return PreparedRequest(
        capture=capture,
        body=body,
        forwarded_headers=forwarded_headers,
        token_metadata=metadata,
        account_fingerprint=f"sha256:{fingerprint}",
        secrets=secrets,
    )


def check_token_expiry(prepared: PreparedRequest, now: datetime | None = None) -> None:
    metadata = prepared.token_metadata
    if not metadata or "expires" not in metadata:
        return
    try:
        expires = int(metadata["expires"])
    except (TypeError, ValueError):
        return
    current = int((now or utc_now()).timestamp())
    if expires <= current:
        expiry = datetime.fromtimestamp(expires, UTC).isoformat(timespec="seconds")
        raise ControlError(f"Authorization token expired at {expiry}; capture fresh headers.")


def redact(text: str, secrets: Sequence[str]) -> str:
    result = text
    for secret in sorted((value for value in secrets if value), key=len, reverse=True):
        result = result.replace(secret, "[REDACTED]")
    result = AUTH_HEADER_RE.sub(r"\1[REDACTED]", result)
    result = QUERY_USER_RE.sub(r"\1[REDACTED]", result)
    return result[:500]


def contains_secret(raw: bytes, secrets: Sequence[str]) -> bool:
    for secret in secrets:
        if not secret:
            continue
        encoded = secret.encode("utf-8")
        if encoded in raw:
            return True
    return False


class GachaClient:
    """Small HTTPS client that never follows redirects."""

    def __init__(
        self,
        prepared: PreparedRequest,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        retries: int = DEFAULT_RETRIES,
        request_once: Callable[[str, dict[str, str], bytes, float], HttpResponse] | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        self.prepared = prepared
        self.timeout = timeout
        self.retries = retries
        self._request_once_override = request_once
        self._sleep = sleep_fn

    def _target_for(self, type_id: int, next_cursor: str | None) -> str:
        pairs = [
            (key, value)
            for key, value in self.prepared.capture.query_pairs
            if key not in {"type_id", "next"}
        ]
        pairs.append(("type_id", str(type_id)))
        if next_cursor:
            pairs.append(("next", next_cursor))
        return f"{self.prepared.capture.path}?{urlencode(pairs)}"

    def _request_once(
        self,
        target: str,
        headers: dict[str, str],
        body: bytes,
        timeout: float,
    ) -> HttpResponse:
        if self._request_once_override is not None:
            return self._request_once_override(target, headers, body, timeout)

        connection = http.client.HTTPSConnection(
            self.prepared.capture.host,
            port=443,
            timeout=timeout,
        )
        try:
            connection.request("POST", target, body=body, headers=headers)
            response = connection.getresponse()
            response_body = response.read()
            response_headers = {name.lower(): value for name, value in response.getheaders()}
            return HttpResponse(
                status=response.status,
                reason=response.reason or "",
                headers=response_headers,
                body=response_body,
            )
        finally:
            connection.close()

    @staticmethod
    def _retry_delay(response: HttpResponse | None, attempt: int) -> float:
        if response is not None:
            retry_after = response.headers.get("retry-after", "")
            try:
                return min(max(float(retry_after), 0.0), 30.0)
            except ValueError:
                pass
        return min(float(2**attempt), 8.0)

    def request(self, type_id: int, next_cursor: str | None = None) -> HttpResponse:
        target = self._target_for(type_id, next_cursor)
        last_problem = "request failed"
        for attempt in range(self.retries + 1):
            response: HttpResponse | None = None
            try:
                response = self._request_once(
                    target,
                    dict(self.prepared.forwarded_headers),
                    self.prepared.body,
                    self.timeout,
                )
            except (TimeoutError, socket.timeout, OSError, http.client.HTTPException) as exc:
                last_problem = f"network error: {type(exc).__name__}"
            else:
                if response.status not in {408, 429} and response.status < 500:
                    return response
                last_problem = f"HTTP {response.status}"

            if attempt < self.retries:
                self._sleep(self._retry_delay(response, attempt))

        raise FetchError(f"{last_problem} after {self.retries + 1} attempts")


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
            temporary_name = temporary.name
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def record_key(record: Any) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), allow_nan=False)


def newest_first(records: Sequence[Any]) -> bool:
    times = [record.get("time") if isinstance(record, dict) else None for record in records]
    return bool(times) and all(type(value) is int and value >= 0 for value in times) and all(
        left >= right for left, right in zip(times, times[1:])
    )


@dataclass(frozen=True)
class CachedType:
    export_name: str
    pages: tuple[bytes, ...]
    records: tuple[dict[str, Any], ...]


def load_baseline(root: Path, prepared: PreparedRequest) -> dict[int, CachedType]:
    """Use only completed, internally consistent exports for the exact identity."""
    identity = {
        "endpoint_host": prepared.capture.host,
        "account_fingerprint": prepared.account_fingerprint,
        "server": dict(parse_qsl(prepared.body.decode("ascii")))["server"],
        "game_channel_id": prepared.capture.game_channel_id,
    }
    result: dict[int, CachedType] = {}
    for path in sorted(root.glob("*/manifest.json"), reverse=True):
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
            if (manifest.get("complete") is not True or not manifest.get("completed_at")
                    or manifest.get("errors") or manifest.get("schema_version") != SCHEMA_VERSION
                    or any(manifest.get(key) != value for key, value in identity.items())):
                continue
            document = json.loads((path.parent / "records.json").read_text(encoding="utf-8"))
            if (document.get("schema_version") != SCHEMA_VERSION
                    or document.get("exported_at") != manifest.get("started_at")
                    or any(document.get(key) != value for key, value in identity.items())):
                continue
            entries = document["records"]
            if not isinstance(entries, list) or not all(isinstance(row, dict) for row in entries):
                continue
            for type_key, meta in manifest["types"].items():
                type_id = int(type_key)
                if (type_id in result or type_id < 1 or meta["status"] != "complete"
                        or type(meta["pages"]) is not int or meta["pages"] < 1):
                    continue
                expected = [row for row in entries if row.get("source_type_id") == type_id]
                pages: list[bytes] = []
                actual: list[dict[str, Any]] = []
                for page in range(1, meta["pages"] + 1):
                    raw = (path.parent / "raw" / f"type_{type_id:04d}" / f"page_{page:04d}.json").read_bytes()
                    code, rows, _ = parse_envelope(HttpResponse(200, "cached", {}, raw))
                    if code not in (0, "0") or contains_secret(raw, prepared.secrets):
                        raise ValueError("Invalid cached page")
                    if rows:
                        pages.append(raw)
                    actual.extend({"source_type_id": type_id, "source_page": page, "record": row} for row in rows)
                records = tuple(row["record"] for row in actual)
                if actual == expected and len(actual) == meta["records"] and newest_first(records):
                    # Canonicalization also rejects non-finite JSON values before comparison.
                    for record in records:
                        record_key(record)
                    result[type_id] = CachedType(path.parent.name, tuple(pages), records)
        except (OSError, UnicodeError, ValueError, TypeError, KeyError, AttributeError, FetchError):
            # A broken or concurrently written cache must never shorten a network scan.
            continue
    return result


def incremental_new_records(cached: CachedType, current: Sequence[Any]) -> list[Any] | None:
    """Require two complete timestamp groups, retaining occurrence multiplicity."""
    if not newest_first(current):
        return None
    frontier = cached.records[0]["time"]
    older = next((row["time"] for row in cached.records if row["time"] < frontier), None)
    # Crossing the older timestamp proves that both overlap groups are complete,
    # even when a ten-pull or identical rewards span several API pages.
    if older is None or current[-1]["time"] >= older:
        return None
    saved_head = Counter(record_key(row) for row in cached.records if row["time"] == frontier)
    live_head = Counter(record_key(row) for row in current if row["time"] == frontier)
    boundary = current[-1]["time"]
    saved_older = Counter(record_key(row) for row in cached.records if boundary < row["time"] < frontier)
    live_older = Counter(record_key(row) for row in current if boundary < row["time"] < frontier)
    saved_boundary = Counter(record_key(row) for row in cached.records if row["time"] == boundary)
    live_boundary = Counter(record_key(row) for row in current if row["time"] == boundary)
    if (not saved_head <= live_head or saved_older != live_older
            or not live_boundary <= saved_boundary):
        return None
    extras = live_head - saved_head
    new = []
    for row in current:
        if row["time"] > frontier:
            new.append(row)
        elif row["time"] == frontier and extras[record_key(row)]:
            new.append(row)
            extras[record_key(row)] -= 1
    # Reusing pages must preserve the API's order within equal timestamps too.
    # Counts alone cannot prove this when ties reorder or a new reward appears
    # inside a saved group. In those cases fetch the remaining pages normally.
    merged_prefix = new + list(cached.records[:len(current) - len(new)])
    if [record_key(row) for row in current] != [record_key(row) for row in merged_prefix]:
        return None
    return new


class ExportWriter:
    def __init__(
        self,
        root: Path,
        prepared: PreparedRequest,
        *,
        start_type: int,
        consecutive_misses: int,
        max_type: int,
        timeout: float,
        retries: int,
    ) -> None:
        started = utc_now()
        folder_name = started.strftime("%Y%m%dT%H%M%S.%fZ")
        self.run_dir = root / folder_name
        self.run_dir.mkdir(parents=True, exist_ok=False)
        self.prepared = prepared
        self.records: list[dict[str, Any]] = []
        self.manifest: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "started_at": iso_utc(started),
            "completed_at": None,
            "complete": False,
            "endpoint_host": prepared.capture.host,
            "account_fingerprint": prepared.account_fingerprint,
            "server": dict(parse_qsl(prepared.body.decode("ascii")))["server"],
            "game_channel_id": prepared.capture.game_channel_id,
            "scan": {
                "captured_type_id": prepared.capture.captured_type_id,
                "start_type": start_type,
                "consecutive_misses": consecutive_misses,
                "max_type": max_type,
                "timeout_seconds": timeout,
                "retries": retries,
            },
            "probe": {"last_type_id": None, "consecutive_misses": 0},
            "types": {},
            "errors": [],
        }
        self.checkpoint()

    def _type_entry(self, type_id: int) -> dict[str, Any]:
        key = str(type_id)
        return self.manifest["types"].setdefault(
            key,
            {"status": "in_progress", "pages": 0, "records": 0},
        )

    def start_type(self, type_id: int) -> None:
        entry = self._type_entry(type_id)
        entry.update({"status": "in_progress", "pages": 0, "records": 0})
        entry.pop("http_status", None)
        entry.pop("api_code", None)
        entry.pop("message", None)
        self.checkpoint()

    def save_page(self, type_id: int, page: int, raw: bytes, records: list[Any]) -> None:
        if contains_secret(raw, self.prepared.secrets):
            raise FetchError("response contained a sensitive request value and was not persisted")
        raw_path = self.run_dir / "raw" / f"type_{type_id:04d}" / f"page_{page:04d}.json"
        atomic_write(raw_path, raw)
        for record in records:
            self.records.append(
                {"source_type_id": type_id, "source_page": page, "record": record}
            )
        entry = self._type_entry(type_id)
        entry["pages"] = page
        entry["records"] += len(records)
        self.checkpoint()

    def finish_type(
        self,
        type_id: int,
        status: str,
        *,
        http_status: int | None = None,
        api_code: Any = None,
        message: str | None = None,
    ) -> TypeOutcome:
        entry = self._type_entry(type_id)
        entry["status"] = status
        if http_status is not None:
            entry["http_status"] = http_status
        if api_code is not None:
            entry["api_code"] = api_code
        if message:
            entry["message"] = redact(message, self.prepared.secrets)
        self.checkpoint()
        return TypeOutcome(type_id, status, entry["pages"], entry["records"])

    def reuse_history(self, type_id: int, cached: CachedType, new: list[Any]) -> TypeOutcome:
        """Build an importable merged snapshot, retaining original response receipts."""
        entry = self._type_entry(type_id)
        fetched_pages = entry["pages"]
        wanted = Counter(record_key(row) for row in new)
        merged: list[dict[str, Any]] = []
        for page in range(1, fetched_pages + 1):
            relative = Path(f"type_{type_id:04d}") / f"page_{page:04d}.json"
            path = self.run_dir / "raw" / relative
            raw = path.read_bytes()
            payload = json.loads(raw.decode("utf-8-sig"))
            retained = []
            for row in payload["data"]["list"]:
                key = record_key(row)
                if wanted[key]:
                    retained.append(row)
                    wanted[key] -= 1
            if retained != payload["data"]["list"]:
                atomic_write(self.run_dir / "responses" / relative, raw)
                payload["data"]["list"] = retained
                payload["_collector"] = {
                    "transformation": "retain_new_occurrences",
                    "source_export": self.run_dir.name,
                    "original_response": f"responses/{relative.as_posix()}",
                }
                atomic_write(path, json_bytes(payload))
            merged.extend({"source_type_id": type_id, "source_page": page, "record": row} for row in retained)
        for page, raw in enumerate(cached.pages, start=fetched_pages + 1):
            _, rows, _ = parse_envelope(HttpResponse(200, "cached", {}, raw))
            atomic_write(self.run_dir / "raw" / f"type_{type_id:04d}" / f"page_{page:04d}.json", raw)
            merged.extend({"source_type_id": type_id, "source_page": page, "record": row} for row in rows)
        self.records = [row for row in self.records if row["source_type_id"] != type_id] + merged
        entry.update({
            "pages": fetched_pages + len(cached.pages), "records": len(merged),
            "fetched_pages": fetched_pages, "new_records": len(new),
            "reused_records": len(cached.records), "baseline_export": cached.export_name,
        })
        return self.finish_type(type_id, "complete")

    def fail_type(self, type_id: int, message: str) -> None:
        entry = self._type_entry(type_id)
        entry["status"] = "error"
        entry["message"] = redact(message, self.prepared.secrets)
        self.checkpoint()

    def update_probe(self, last_type_id: int, consecutive_misses: int) -> None:
        self.manifest["probe"] = {
            "last_type_id": last_type_id,
            "consecutive_misses": consecutive_misses,
        }
        self.checkpoint()

    def fail_run(self, kind: str, message: str) -> None:
        for entry in self.manifest["types"].values():
            if entry["status"] == "in_progress":
                entry["status"] = "error"
                entry["message"] = redact(message, self.prepared.secrets)
        self.manifest["errors"].append(
            {"kind": kind, "message": redact(message, self.prepared.secrets)}
        )
        self.manifest["completed_at"] = iso_utc()
        self.manifest["complete"] = False
        self.checkpoint()

    def complete_run(self) -> None:
        self.manifest["completed_at"] = iso_utc()
        self.manifest["complete"] = True
        self.checkpoint()

    def checkpoint(self) -> None:
        records_document = {
            "schema_version": SCHEMA_VERSION,
            "exported_at": self.manifest["started_at"],
            "endpoint_host": self.manifest["endpoint_host"],
            "account_fingerprint": self.manifest["account_fingerprint"],
            "server": self.manifest["server"],
            "game_channel_id": self.manifest["game_channel_id"],
            "records": self.records,
        }
        manifest_raw = json_bytes(self.manifest)
        records_raw = json_bytes(records_document)
        if contains_secret(manifest_raw, self.prepared.secrets) or contains_secret(
            records_raw, self.prepared.secrets
        ):
            raise FetchError("refusing to write an export containing sensitive request data")
        atomic_write(self.run_dir / "records.json", records_raw)
        # Write the manifest last so it acts as the checkpoint's commit marker.
        atomic_write(self.run_dir / "manifest.json", manifest_raw)


def parse_envelope(response: HttpResponse) -> tuple[Any, list[Any], str]:
    try:
        payload = json.loads(response.body.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise FetchError("server returned malformed JSON") from exc
    if not isinstance(payload, dict):
        raise FetchError("server returned a non-object JSON response")

    code = payload.get("code")
    if code not in (0, "0"):
        message = payload.get("message", payload.get("msg", "API rejected the request"))
        return code, [], str(message)

    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("list"), list):
        raise FetchError("successful API response is missing data.list")
    next_value = data.get("next", "")
    if next_value is None:
        next_cursor = ""
    elif isinstance(next_value, (str, int)):
        next_cursor = str(next_value)
    else:
        raise FetchError("successful API response has an invalid data.next cursor")
    return code, data["list"], next_cursor


class PullHistoryCollector:
    def __init__(
        self,
        client: GachaClient,
        writer: ExportWriter,
        *,
        start_type: int,
        consecutive_misses: int,
        max_type: int,
        baseline: dict[int, CachedType] | None = None,
    ) -> None:
        self.client = client
        self.writer = writer
        self.control_type = client.prepared.capture.captured_type_id
        self.start_type = start_type
        self.consecutive_misses = consecutive_misses
        self.max_type = max_type
        self.baseline = load_baseline(writer.run_dir.parent, client.prepared) if baseline is None else baseline

    def _collect_type(self, type_id: int, *, control: bool) -> TypeOutcome:
        self.writer.start_type(type_id)
        page = 0
        next_cursor: str | None = None
        seen_cursors: set[str] = set()
        current: list[Any] = []
        try:
            while True:
                response = self.client.request(type_id, next_cursor)
                if not 200 <= response.status < 300:
                    if not control and page == 0 and 400 <= response.status < 500:
                        return self.writer.finish_type(
                            type_id,
                            "unavailable",
                            http_status=response.status,
                            message=f"HTTP {response.status}",
                        )
                    raise FetchError(f"HTTP {response.status} while collecting type {type_id}")

                code, records, next_value = parse_envelope(response)
                if code not in (0, "0"):
                    if not control and page == 0:
                        return self.writer.finish_type(
                            type_id,
                            "unavailable",
                            http_status=response.status,
                            api_code=code,
                            message=next_value,
                        )
                    raise FetchError(f"API rejected type {type_id} with code {code}: {next_value}")

                page += 1
                self.writer.save_page(type_id, page, response.body, records)
                current.extend(records)
                if next_value and next_value in seen_cursors:
                    raise FetchError(f"pagination cursor repeated for type {type_id}")
                cached = self.baseline.get(type_id)
                if cached is not None and next_value:
                    new = incremental_new_records(cached, current)
                    if new is not None:
                        return self.writer.reuse_history(type_id, cached, new)
                if not next_value:
                    status = "complete" if self.writer._type_entry(type_id)["records"] else "empty"
                    return self.writer.finish_type(type_id, status)
                seen_cursors.add(next_value)
                next_cursor = next_value
        except FetchError as exc:
            self.writer.fail_type(type_id, str(exc))
            raise

    def _control_is_available(self) -> bool:
        try:
            response = self.client.request(self.control_type)
            if not 200 <= response.status < 300:
                return False
            code, _, _ = parse_envelope(response)
            return code in (0, "0")
        except FetchError:
            return False

    def run(self) -> None:
        try:
            control_outcome = self._collect_type(self.control_type, control=True)
        except FetchError as exc:
            message = f"Control request failed: {exc}"
            self.writer.fail_run("control", message)
            raise ControlError(message) from exc

        outcomes = {self.control_type: control_outcome}
        misses = 0
        type_id = self.start_type

        try:
            while misses < self.consecutive_misses or type_id <= max(self.baseline, default=0):
                if type_id > self.max_type:
                    raise FetchError(
                        f"probe reached max type {self.max_type} before the miss threshold"
                    )

                if type_id in outcomes:
                    outcome = outcomes[type_id]
                else:
                    outcome = self._collect_type(type_id, control=False)
                    outcomes[type_id] = outcome
                    if outcome.status == "unavailable" and not self._control_is_available():
                        raise FetchError(
                            f"type {type_id} was unavailable and the control type no longer validates"
                        )

                misses = 0 if outcome.has_records else misses + 1
                self.writer.update_probe(type_id, misses)
                type_id += 1
        except KeyboardInterrupt as exc:
            self.writer.fail_run("interrupted", "Collection interrupted by the user.")
            raise FetchError("Collection interrupted by the user.") from exc
        except FetchError as exc:
            self.writer.fail_run("collection", str(exc))
            raise

        self.writer.complete_run()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch all accessible GFL2 pull-history pages from a copied HTTP request. "
            "Omit the capture path to paste interactively, or use '-' to read stdin."
        )
    )
    parser.add_argument(
        "capture",
        nargs="?",
        help="Path to the copied HTTP capture, or '-' for stdin (default: paste window)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "exports",
        help="Parent directory for timestamped exports (default: repository data/exports)",
    )
    parser.add_argument("--server", help="Explicit numeric server form value")
    parser.add_argument("--start-type", type=int, default=DEFAULT_START_TYPE)
    parser.add_argument(
        "--consecutive-misses", type=int, default=DEFAULT_CONSECUTIVE_MISSES
    )
    parser.add_argument("--max-type", type=int, default=DEFAULT_MAX_TYPE)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    parser.add_argument("--full", action="store_true", help="Fetch all pages without using saved history")
    return parser


def validate_args(args: argparse.Namespace) -> None:
    if args.start_type < 1:
        raise InputError("--start-type must be positive.")
    if args.consecutive_misses < 1:
        raise InputError("--consecutive-misses must be positive.")
    if args.max_type < args.start_type:
        raise InputError("--max-type must be greater than or equal to --start-type.")
    if args.timeout <= 0:
        raise InputError("--timeout must be greater than zero.")
    if args.retries < 0:
        raise InputError("--retries cannot be negative.")


def prompt_capture(server_override: str | None = None) -> str:
    """Accept a whole paste before detecting headers, keeping leftovers out of the shell."""
    try:
        import tkinter as tk
        from tkinter import ttk
    except ImportError as exc:
        raise InputError("The paste window requires Tkinter. Use a capture file or '-' instead.") from exc

    try:
        root = tk.Tk()
    except tk.TclError as exc:
        raise InputError("Could not open the paste window. Use a capture file or '-' instead.") from exc
    root.title("GFL2 - Paste request")
    root.geometry("760x420")
    result: list[str] = []
    ttk.Label(
        root,
        text="Paste the full HTTP request below. Fetching starts automatically when detected.",
        padding=12,
    ).pack(anchor="w")
    editor = tk.Text(root, wrap="word", undo=False)
    editor.pack(fill="both", expand=True, padx=12)
    status = tk.StringVar(value="Waiting for a request URL and Authorization header...")
    ttk.Label(root, textvariable=status, padding=12).pack(anchor="w")

    def detect(_event: object = None) -> None:
        if not editor.edit_modified():
            return
        editor.edit_modified(False)
        text = editor.get("1.0", "end-1c")
        try:
            prepare_request(parse_capture(text), server_override)
        except (InputError, ValueError):
            status.set("Paste a complete official HTTP POST request, including Authorization.")
            return
        result.append(text)
        root.quit()

    # Modified fires after the complete paste is inserted, including trailing headers.
    editor.bind("<<Modified>>", detect)
    root.protocol("WM_DELETE_WINDOW", root.quit)
    editor.focus_set()
    try:
        root.mainloop()
    except KeyboardInterrupt as exc:
        raise InputError("Paste cancelled.") from exc
    finally:
        root.destroy()
    if not result:
        raise InputError("Paste cancelled.")
    return result[0]


def read_capture(path: str | None, server_override: str | None = None) -> str:
    if path is None and sys.stdin.isatty():
        return prompt_capture(server_override)
    if path is None or path == "-":
        return sys.stdin.read()
    try:
        return Path(path).read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise InputError(f"Could not read the capture file: {exc.strerror or type(exc).__name__}") from exc


def print_error(message: str) -> None:
    print(message, file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    prepared: PreparedRequest | None = None
    writer: ExportWriter | None = None
    try:
        validate_args(args)
        capture = parse_capture(read_capture(args.capture, args.server))
        prepared = prepare_request(capture, args.server)
        check_token_expiry(prepared)

        try:
            writer = ExportWriter(
                args.output_dir,
                prepared,
                start_type=args.start_type,
                consecutive_misses=args.consecutive_misses,
                max_type=args.max_type,
                timeout=args.timeout,
                retries=args.retries,
            )
        except OSError as exc:
            raise InputError(
                f"Could not create the export directory: {exc.strerror or type(exc).__name__}"
            ) from exc
        client = GachaClient(
            prepared,
            timeout=args.timeout,
            retries=args.retries,
        )
        collector = PullHistoryCollector(
            client,
            writer,
            start_type=args.start_type,
            consecutive_misses=args.consecutive_misses,
            max_type=args.max_type,
            baseline={} if args.full else None,
        )
        collector.run()
    except InputError as exc:
        print_error(f"Input error: {redact(str(exc), prepared.secrets if prepared else ())}")
        return EXIT_INPUT
    except ControlError as exc:
        print_error(redact(str(exc), prepared.secrets if prepared else ()))
        if writer is not None:
            print_error(f"Partial export: {writer.run_dir}")
        return EXIT_CONTROL
    except FetchError as exc:
        if writer is not None and not writer.manifest["errors"]:
            writer.fail_run("collection", str(exc))
        print_error(f"Collection incomplete: {redact(str(exc), prepared.secrets if prepared else ())}")
        if writer is not None:
            print_error(f"Partial export: {writer.run_dir}")
        return EXIT_INCOMPLETE

    assert writer is not None
    print(f"Export complete: {writer.run_dir}")
    print(f"Saved {len(writer.records)} records across {len(writer.manifest['types'])} probed types.")
    reused = sum(entry.get("reused_records", 0) for entry in writer.manifest["types"].values())
    if reused:
        print(f"Reused {reused} saved records after verifying overlap; the export includes the saved history.")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
