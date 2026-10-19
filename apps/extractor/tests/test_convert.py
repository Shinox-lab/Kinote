"""What a Docling result means for us: only a complete success is indexed. Stubs, no models."""
from types import SimpleNamespace as NS

import pytest

from app.docling_convert import interpret
from app.errors import Unreadable


class TextItem(NS):
    pass


def result(status, texts=("hello",)):
    doc = NS(
        pages={1: object()},
        iterate_items=lambda: [(TextItem(text=t, prov=[NS(page_no=1)]), 0) for t in texts],
    )
    return NS(status=NS(name=status), document=doc)


def test_a_success_is_mapped():
    doc = interpret(result("SUCCESS"), "pdf")
    assert doc["pageCount"] == 1 and doc["ocrUsed"] is False
    assert [s["text"] for s in doc["sections"]] == ["hello"]


def test_an_image_reports_ocr():
    assert interpret(result("SUCCESS"), "png")["ocrUsed"] is True


@pytest.mark.parametrize("status", ["PARTIAL_SUCCESS", "FAILURE", "SKIPPED", "PENDING", "STARTED"])
def test_anything_short_of_success_is_unreadable_never_a_silent_partial_index(status):
    with pytest.raises(Unreadable):
        interpret(result(status), "pdf")
