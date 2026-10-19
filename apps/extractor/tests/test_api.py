import json
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app.errors import TooLarge, Unreadable
from app.main import create_app

SECTION = {"headingPath": ["A"], "pageFrom": 1, "pageTo": 1, "kind": "text", "text": "hello world"}
DOC = {"pageCount": 1, "ocrUsed": False, "sections": [SECTION]}


def client(convert, **kwargs):
    return TestClient(create_app(convert=convert, **kwargs), raise_server_exceptions=False)


def post(c, body=b"%PDF-1.7 bytes", file_type="pdf", name="Q3 report ü.pdf"):
    headers = {"x-file-type": file_type, "x-file-name": quote(name), "content-type": "application/octet-stream"}
    return c.post("/extract", content=body, headers=headers)


def test_health():
    assert client(lambda *a: DOC).get("/health").json() == {"status": "ok"}


def test_extract_returns_the_contract_shape_and_passes_the_bytes_and_type():
    seen = {}

    def convert(data, file_type):
        seen["args"] = (data, file_type)
        return DOC

    res = post(client(convert))
    assert res.status_code == 200
    assert res.json() == DOC
    assert seen["args"] == (b"%PDF-1.7 bytes", "pdf")


def test_unreadable_is_422():
    def convert(data, file_type):
        raise Unreadable()

    res = post(client(convert))
    assert res.status_code == 422
    assert res.json() == {"error": "unreadable"}


def test_text_over_the_limit_is_413():
    big = {**DOC, "sections": [{**SECTION, "text": "x" * 50}]}
    res = post(client(lambda *a: big, max_chars=10))
    assert res.status_code == 413
    assert res.json() == {"error": "too_large"}


def test_a_converter_that_raises_TooLarge_is_413():
    def convert(data, file_type):
        raise TooLarge()

    assert post(client(convert)).status_code == 413


@pytest.mark.parametrize("file_type", ["csv", "txt", "audio", "svg", "", "PDF "])
def test_types_the_extractor_does_not_read_are_422(file_type):
    assert post(client(lambda *a: DOC), file_type=file_type).status_code == 422


def test_an_empty_body_is_422():
    assert post(client(lambda *a: DOC), body=b"").status_code == 422


def test_a_crash_is_a_500_that_never_echoes_the_file_or_its_name():
    def convert(data, file_type):
        raise RuntimeError("secret contents of the file")

    res = post(client(convert), body=b"top secret bytes", name="confidential.pdf")
    assert res.status_code == 500
    body = res.text
    assert "secret" not in body and "confidential" not in body and "top secret" not in body
    assert json.loads(body) == {"error": "internal"}


def test_a_converter_answer_that_breaks_the_contract_is_a_500_not_bad_data():
    res = post(client(lambda *a: {"sections": "nope"}))
    assert res.status_code == 500
    assert res.json() == {"error": "internal"}
