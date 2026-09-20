from __future__ import annotations

import base64
import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "fetch_pull_history.py"
SPEC = importlib.util.spec_from_file_location("fetch_pull_history", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
collector_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = collector_module
SPEC.loader.exec_module(collector_module)


ControlError = collector_module.ControlError
ExportWriter = collector_module.ExportWriter
FetchError = collector_module.FetchError
GachaClient = collector_module.GachaClient
HttpResponse = collector_module.HttpResponse
InputError = collector_module.InputError
PullHistoryCollector = collector_module.PullHistoryCollector


SYNTHETIC_ACCOUNT = "unit-test-account@example.invalid"
SYNTHETIC_SIGNATURE = "synthetic-signature-not-a-real-credential"


def make_token(*, tinx: int = 10, expires: int = 4_102_444_800) -> str:
    metadata = json.dumps(
        {"uid": 0, "expires": expires, "is_guest": 0, "tinx": tinx},
        separators=(",", ":"),
    ).encode("utf-8")
    segment = base64.urlsafe_b64encode(metadata).decode("ascii")
    return f"{segment}.{SYNTHETIC_SIGNATURE}"


def make_capture(
    *,
    host: str = "gf2-gacha-record-us.sunborngame.com",
    type_id: int = 3,
    token: str | None = None,
    account: str = SYNTHETIC_ACCOUNT,
    server: int = 10,
    include_body: bool = False,
    include_response: bool = True,
    line_ending: str = "\r\n",
    mixed_case: bool = False,
    content_length: int | None = None,
) -> str:
    token = token or make_token(tinx=server)
    body = f"server={server}"
    length = len(body.encode("ascii")) if content_length is None else content_length
    auth_name = "aUtHoRiZaTiOn" if mixed_case else "Authorization"
    host_name = "hOsT" if mixed_case else "Host"
    request = [
        f"POST https://{host}/list?game_channel_id=5&type_id={type_id}&u={account} HTTP/1.1",
        f"{host_name}: {host}",
        "User-Agent: Synthetic-Test-Client/1.0",
        "Content-Type: application/x-www-form-urlencoded",
        f"{auth_name}: {token}",
        f"Content-Length: {length}",
        "",
    ]
    if include_body:
        request.append(body)
    if include_response:
        request.extend(
            [
                "HTTP/1.1 200 OK",
                "Content-Type: application/json",
                "",
                '{"code":0,"data":{"list":[],"next":""}}',
            ]
        )
    return line_ending.join(request)


def api_response(
    records: list[Any] | None = None,
    *,
    next_cursor: str = "",
    code: Any = 0,
    message: str = "",
    status: int = 200,
    headers: dict[str, str] | None = None,
) -> HttpResponse:
    if code in (0, "0"):
        payload = {"code": code, "data": {"list": records or [], "next": next_cursor}}
    else:
        payload = {"code": code, "message": message}
    return HttpResponse(
        status=status,
        reason="Synthetic",
        headers=headers or {},
        body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
    )


def make_prepared(**capture_kwargs: Any) -> Any:
    capture = collector_module.parse_capture(make_capture(**capture_kwargs))
    return collector_module.prepare_request(capture)


class FakeClient:
    def __init__(
        self,
        prepared: Any,
        handler: Callable[[int, str | None, int], HttpResponse],
    ) -> None:
        self.prepared = prepared
        self.handler = handler
        self.calls: list[tuple[int, str | None]] = []

    def request(self, type_id: int, next_cursor: str | None = None) -> HttpResponse:
        self.calls.append((type_id, next_cursor))
        return self.handler(type_id, next_cursor, len(self.calls))


def make_writer(
    root: Path,
    prepared: Any,
    *,
    start_type: int = 1,
    consecutive_misses: int = 10,
    max_type: int = 1000,
    retries: int = 0,
) -> ExportWriter:
    return ExportWriter(
        root,
        prepared,
        start_type=start_type,
        consecutive_misses=consecutive_misses,
        max_type=max_type,
        timeout=1.0,
        retries=retries,
    )


class CaptureParsingTests(unittest.TestCase):
    def test_parses_crlf_capture_with_response_headers(self) -> None:
        capture = collector_module.parse_capture(make_capture())

        self.assertEqual(capture.host, "gf2-gacha-record-us.sunborngame.com")
        self.assertEqual(capture.captured_type_id, 3)
        self.assertEqual(capture.account_value, SYNTHETIC_ACCOUNT)
        self.assertEqual(capture.captured_body, "")
        self.assertEqual(capture.content_length, 9)

    def test_parses_lf_mixed_case_headers_and_captured_body(self) -> None:
        capture = collector_module.parse_capture(
            make_capture(line_ending="\n", mixed_case=True, include_body=True)
        )
        prepared = collector_module.prepare_request(capture)

        self.assertEqual(capture.captured_body, "server=10")
        self.assertEqual(prepared.body, b"server=10")
        self.assertIn("authorization", prepared.forwarded_headers)
        self.assertNotIn("host", prepared.forwarded_headers)
        self.assertNotIn("content-length", prepared.forwarded_headers)

    def test_rejects_non_official_host(self) -> None:
        with self.assertRaisesRegex(InputError, "official GFL2"):
            collector_module.parse_capture(make_capture(host="example.invalid"))

    def test_rejects_host_header_mismatch(self) -> None:
        capture = make_capture().replace(
            "Host: gf2-gacha-record-us.sunborngame.com", "Host: gf2-gacha-record-jp.haoplay.com"
        )
        with self.assertRaisesRegex(InputError, "Host header"):
            collector_module.parse_capture(capture)

    def test_infers_server_from_tinx_and_verifies_content_length(self) -> None:
        prepared = make_prepared(server=17)
        self.assertEqual(prepared.body, b"server=17")
        self.assertEqual(prepared.token_metadata["tinx"], 17)

    def test_rejects_unexplained_content_length_mismatch(self) -> None:
        capture = collector_module.parse_capture(make_capture(server=10, content_length=8))
        with self.assertRaisesRegex(InputError, "Content-Length"):
            collector_module.prepare_request(capture)

    def test_explicit_server_override_explains_length_change(self) -> None:
        capture = collector_module.parse_capture(make_capture(server=10, content_length=9))
        prepared = collector_module.prepare_request(capture, server_override="2")
        self.assertEqual(prepared.body, b"server=2")

    def test_rejects_captured_server_that_disagrees_with_token(self) -> None:
        text = make_capture(server=10, include_body=True).replace("server=10", "server=11", 1)
        capture = collector_module.parse_capture(text)
        with self.assertRaisesRegex(InputError, "does not match token metadata"):
            collector_module.prepare_request(capture)

    def test_expired_token_has_clear_control_error(self) -> None:
        prepared = make_prepared(token=make_token(expires=1), server=10)
        with self.assertRaisesRegex(ControlError, "expired"):
            collector_module.check_token_expiry(
                prepared, now=datetime.fromtimestamp(2, UTC)
            )


class HttpClientTests(unittest.TestCase):
    def test_retries_transient_responses_and_does_not_forward_generated_headers(self) -> None:
        prepared = make_prepared()
        responses = [
            HttpResponse(500, "Server Error", {}, b""),
            HttpResponse(429, "Rate Limited", {"retry-after": "0"}, b""),
            api_response([{"item": 1}]),
        ]
        calls: list[tuple[str, dict[str, str], bytes, float]] = []
        sleeps: list[float] = []

        def request_once(
            target: str, headers: dict[str, str], body: bytes, timeout: float
        ) -> HttpResponse:
            calls.append((target, headers, body, timeout))
            return responses.pop(0)

        client = GachaClient(
            prepared,
            timeout=2.5,
            retries=2,
            request_once=request_once,
            sleep_fn=sleeps.append,
        )
        response = client.request(7, "cursor value")

        self.assertEqual(response.status, 200)
        self.assertEqual(len(calls), 3)
        query = parse_qs(urlsplit(calls[-1][0]).query)
        self.assertEqual(query["type_id"], ["7"])
        self.assertEqual(query["next"], ["cursor value"])
        self.assertEqual(calls[-1][2], b"server=10")
        self.assertNotIn("host", calls[-1][1])
        self.assertNotIn("content-length", calls[-1][1])
        self.assertNotIn("accept-encoding", calls[-1][1])
        self.assertEqual(sleeps, [1.0, 0.0])

    def test_returns_redirect_without_following_it(self) -> None:
        prepared = make_prepared()
        call_count = 0

        def request_once(*_: Any) -> HttpResponse:
            nonlocal call_count
            call_count += 1
            return HttpResponse(302, "Found", {"location": "https://example.invalid"}, b"")

        client = GachaClient(prepared, retries=3, request_once=request_once)
        response = client.request(3)
        self.assertEqual(response.status, 302)
        self.assertEqual(call_count, 1)

    def test_exhausted_network_retries_raise_redacted_safe_error(self) -> None:
        prepared = make_prepared()
        calls = 0

        def request_once(*_: Any) -> HttpResponse:
            nonlocal calls
            calls += 1
            raise TimeoutError("synthetic timeout")

        client = GachaClient(
            prepared,
            retries=2,
            request_once=request_once,
            sleep_fn=lambda _: None,
        )
        with self.assertRaisesRegex(FetchError, "after 3 attempts"):
            client.request(3)
        self.assertEqual(calls, 3)


class CollectorTests(unittest.TestCase):
    def test_cursor_pagination_probe_termination_and_lossless_export(self) -> None:
        prepared = make_prepared()

        def handler(type_id: int, cursor: str | None, _: int) -> HttpResponse:
            if type_id == 3 and cursor is None:
                return api_response([{"item": 301, "time": 30}], next_cursor="page-two")
            if type_id == 3 and cursor == "page-two":
                return api_response([{"item": 302, "time": 29}])
            if type_id == 1:
                return api_response([{"item": 101, "time": 10}])
            return api_response([])

        client = FakeClient(prepared, handler)
        with tempfile.TemporaryDirectory() as directory:
            writer = make_writer(Path(directory), prepared)
            collector = PullHistoryCollector(
                client,
                writer,
                start_type=1,
                consecutive_misses=10,
                max_type=100,
            )
            collector.run()

            self.assertTrue(writer.manifest["complete"])
            self.assertEqual(writer.manifest["probe"]["last_type_id"], 13)
            self.assertEqual(writer.manifest["probe"]["consecutive_misses"], 10)
            self.assertEqual(len(writer.records), 3)
            self.assertEqual(client.calls.count((3, None)), 1)
            self.assertEqual(client.calls.count((3, "page-two")), 1)

            first_raw = writer.run_dir / "raw" / "type_0003" / "page_0001.json"
            self.assertEqual(
                first_raw.read_bytes(),
                api_response([{"item": 301, "time": 30}], next_cursor="page-two").body,
            )
            records = json.loads((writer.run_dir / "records.json").read_text("utf-8"))
            self.assertEqual(records["records"][0]["source_type_id"], 3)
            self.assertIn("record", records["records"][0])
            self.assert_export_has_no_secrets(writer.run_dir, prepared)

    def test_unavailable_type_is_expected_only_when_control_revalidates(self) -> None:
        prepared = make_prepared()

        def handler(type_id: int, cursor: str | None, _: int) -> HttpResponse:
            if type_id == 3:
                return api_response([{"item": 3}])
            if type_id == 1:
                return api_response(code=4004, message="type is private")
            return api_response([])

        client = FakeClient(prepared, handler)
        with tempfile.TemporaryDirectory() as directory:
            writer = make_writer(
                Path(directory), prepared, consecutive_misses=3, max_type=20
            )
            collector = PullHistoryCollector(
                client,
                writer,
                start_type=1,
                consecutive_misses=3,
                max_type=20,
            )
            collector.run()

            self.assertTrue(writer.manifest["complete"])
            self.assertEqual(writer.manifest["types"]["1"]["status"], "unavailable")
            self.assertEqual(client.calls.count((3, None)), 2)
            self.assertEqual(writer.manifest["probe"]["last_type_id"], 6)

    def test_failed_control_revalidation_marks_run_incomplete(self) -> None:
        prepared = make_prepared()
        control_calls = 0

        def handler(type_id: int, cursor: str | None, _: int) -> HttpResponse:
            nonlocal control_calls
            if type_id == 3:
                control_calls += 1
                if control_calls == 1:
                    return api_response([{"item": 3}])
                return HttpResponse(401, "Unauthorized", {}, b"{}")
            if type_id == 1:
                return api_response(code=4004, message="private")
            return api_response([])

        client = FakeClient(prepared, handler)
        with tempfile.TemporaryDirectory() as directory:
            writer = make_writer(Path(directory), prepared)
            collector = PullHistoryCollector(
                client,
                writer,
                start_type=1,
                consecutive_misses=10,
                max_type=20,
            )
            with self.assertRaisesRegex(FetchError, "control type no longer validates"):
                collector.run()

            manifest = json.loads((writer.run_dir / "manifest.json").read_text("utf-8"))
            self.assertFalse(manifest["complete"])
            self.assertEqual(manifest["errors"][0]["kind"], "collection")
            self.assertEqual(manifest["types"]["1"]["status"], "unavailable")

    def test_unexpected_later_page_failure_preserves_partial_records(self) -> None:
        prepared = make_prepared()

        def handler(type_id: int, cursor: str | None, _: int) -> HttpResponse:
            if type_id == 3:
                return api_response([{"item": 3}])
            if type_id == 1 and cursor is None:
                return api_response([{"item": 1}], next_cursor="second")
            if type_id == 1 and cursor == "second":
                raise FetchError("synthetic page failure")
            return api_response([])

        client = FakeClient(prepared, handler)
        with tempfile.TemporaryDirectory() as directory:
            writer = make_writer(Path(directory), prepared)
            collector = PullHistoryCollector(
                client,
                writer,
                start_type=1,
                consecutive_misses=10,
                max_type=20,
            )
            with self.assertRaisesRegex(FetchError, "synthetic page failure"):
                collector.run()

            manifest = json.loads((writer.run_dir / "manifest.json").read_text("utf-8"))
            records = json.loads((writer.run_dir / "records.json").read_text("utf-8"))
            self.assertFalse(manifest["complete"])
            self.assertEqual(manifest["types"]["1"]["status"], "error")
            self.assertEqual(manifest["types"]["1"]["pages"], 1)
            self.assertEqual(manifest["types"]["1"]["records"], 1)
            self.assertEqual(len(records["records"]), 2)
            self.assertTrue(
                (writer.run_dir / "raw" / "type_0001" / "page_0001.json").exists()
            )
            self.assert_export_has_no_secrets(writer.run_dir, prepared)

    def test_repeated_cursor_is_an_unexpected_partial_failure(self) -> None:
        prepared = make_prepared()

        def handler(type_id: int, cursor: str | None, _: int) -> HttpResponse:
            if type_id == 3 and cursor is None:
                return api_response([{"item": 1}], next_cursor="same")
            return api_response([{"item": 2}], next_cursor="same")

        client = FakeClient(prepared, handler)
        with tempfile.TemporaryDirectory() as directory:
            writer = make_writer(Path(directory), prepared)
            collector = PullHistoryCollector(
                client,
                writer,
                start_type=1,
                consecutive_misses=10,
                max_type=20,
            )
            with self.assertRaises(ControlError):
                collector.run()
            self.assertFalse(writer.manifest["complete"])
            self.assertEqual(writer.manifest["types"]["3"]["pages"], 2)

    def test_response_that_echoes_secret_is_not_persisted(self) -> None:
        prepared = make_prepared()
        secret_response = api_response([{"echo": SYNTHETIC_ACCOUNT}])

        def handler(type_id: int, cursor: str | None, _: int) -> HttpResponse:
            return secret_response

        client = FakeClient(prepared, handler)
        with tempfile.TemporaryDirectory() as directory:
            writer = make_writer(Path(directory), prepared)
            collector = PullHistoryCollector(
                client,
                writer,
                start_type=1,
                consecutive_misses=10,
                max_type=20,
            )
            with self.assertRaises(ControlError):
                collector.run()
            raw_path = writer.run_dir / "raw" / "type_0003" / "page_0001.json"
            self.assertFalse(raw_path.exists())
            self.assert_export_has_no_secrets(writer.run_dir, prepared)

    def test_safety_ceiling_is_an_unexpected_failure(self) -> None:
        prepared = make_prepared(type_id=1)

        def handler(type_id: int, cursor: str | None, _: int) -> HttpResponse:
            return api_response([{"item": type_id}])

        client = FakeClient(prepared, handler)
        with tempfile.TemporaryDirectory() as directory:
            writer = make_writer(Path(directory), prepared, max_type=2)
            collector = PullHistoryCollector(
                client,
                writer,
                start_type=1,
                consecutive_misses=10,
                max_type=2,
            )
            with self.assertRaisesRegex(FetchError, "max type 2"):
                collector.run()
            self.assertFalse(writer.manifest["complete"])

    def assert_export_has_no_secrets(self, run_dir: Path, prepared: Any) -> None:
        for path in run_dir.rglob("*"):
            if not path.is_file():
                continue
            raw = path.read_bytes()
            for secret in prepared.secrets:
                self.assertNotIn(secret.encode("utf-8"), raw, str(path))


class CliValidationTests(unittest.TestCase):
    def test_invalid_capture_returns_input_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture_path = Path(directory) / "capture.txt"
            capture_path.write_text("not an HTTP capture", encoding="utf-8")
            result = collector_module.main([str(capture_path)])
        self.assertEqual(result, collector_module.EXIT_INPUT)

    def test_expired_token_returns_control_exit_code_without_creating_export(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture_path = root / "capture.txt"
            capture_path.write_text(
                make_capture(token=make_token(expires=1), line_ending="\n"),
                encoding="utf-8",
            )
            output = root / "exports"
            result = collector_module.main(
                [str(capture_path), "--output-dir", str(output)]
            )
            self.assertFalse(output.exists())
        self.assertEqual(result, collector_module.EXIT_CONTROL)


if __name__ == "__main__":
    unittest.main()
