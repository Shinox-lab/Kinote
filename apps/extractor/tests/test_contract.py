"""The extractor's answer must match packages/contracts (ExtractedDocumentSchema): one shared fixture."""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schema import ExtractedDocument

FIXTURE = Path(__file__).resolve().parents[2] / ".." / "packages" / "contracts" / "fixtures" / "extracted-sample.json"


def load():
    return json.loads(FIXTURE.resolve().read_text())


def test_the_shared_fixture_is_valid():
    doc = ExtractedDocument.model_validate(load())
    assert doc.pageCount == 2
    assert [s.kind for s in doc.sections] == ["text", "table"]


def test_it_serialises_back_to_the_same_json():
    data = load()
    assert ExtractedDocument.model_validate(data).model_dump() == data


@pytest.mark.parametrize(
    "change",
    [
        lambda d: d["sections"][0].update(pageFrom=0),
        lambda d: d["sections"][0].update(kind="image"),
        lambda d: d["sections"][0].update(extra="no"),
        lambda d: d.update(ocrUsed="yes"),
        lambda d: d.pop("sections"),
    ],
)
def test_it_refuses_what_the_node_side_would_refuse(change):
    data = load()
    change(data)
    with pytest.raises(ValidationError):
        ExtractedDocument.model_validate(data)
