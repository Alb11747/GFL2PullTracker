"""Network budgets stop untrusted upstream pages without leaking captures."""
import pytest
from scripts.fetch_pull_history import GachaClient, HttpResponse, FetchError


class Prepared:
    class Capture:
        query_pairs = (("type_id", "1"),)
        path = "/list"
    capture = Capture()
    forwarded_headers = {}
    body = b"server=10"


def client(**budgets):
    return GachaClient(Prepared(), request_once=lambda *_: HttpResponse(200, "OK", {}, b"12345"), **budgets)


def test_page_limit_and_cumulative_limit():
    with pytest.raises(FetchError, match="size limit"):
        client(max_response_bytes=4).request(1)
    limited = client(max_total_bytes=9)
    limited.request(1)
    with pytest.raises(FetchError, match="size limit"):
        limited.request(1)


def test_request_and_deadline_budgets():
    limited = client(max_requests=1)
    limited.request(1)
    with pytest.raises(FetchError, match="request or time"):
        limited.request(1)
    with pytest.raises(FetchError, match="request or time"):
        client(max_seconds=-1).request(1)
