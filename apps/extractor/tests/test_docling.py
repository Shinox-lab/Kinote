"""The real pipeline. Slow and needs the models: EXTRACTOR_DOCLING_TESTS=1."""
import os

import pytest

pytestmark = [
    pytest.mark.docling,
    pytest.mark.skipif(os.environ.get("EXTRACTOR_DOCLING_TESTS") != "1", reason="set EXTRACTOR_DOCLING_TESTS=1"),
]

def make_pdf(text: str) -> bytes:
    """A one-page letter-size PDF with a heading, paragraphs and a real xref table, so any reader accepts it."""
    lines = [f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET"]
    for i in range(12):
        lines.append(f"BT /F1 12 Tf 72 {660 - i * 18} Td (Every employee receives annual leave and the days accrue each month, line {i + 1}.) Tj ET")
    stream = "\n".join(lines).encode()
    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
        b"<</Length %d>>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return out


PDF = make_pdf("Pomegranate leave policy")


def make_png(text: str) -> bytes:
    from io import BytesIO

    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (900, 160), "white")
    ImageDraw.Draw(image).text((20, 50), text, fill="black", font=ImageFont.load_default(size=48))
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def test_a_one_page_pdf_yields_its_sentence_on_page_one():
    from app.docling_convert import convert_with_docling

    doc = convert_with_docling(PDF, "pdf")
    text = " ".join(" ".join(s["headingPath"]) + " " + s["text"] for s in doc["sections"])
    assert "Pomegranate" in text
    assert doc["pageCount"] == 1
    assert all(s["pageFrom"] == 1 for s in doc["sections"] if s["pageFrom"] is not None)


def test_garbage_is_unreadable():
    from app.docling_convert import convert_with_docling
    from app.errors import Unreadable

    with pytest.raises(Unreadable):
        convert_with_docling(b"this is not a pdf", "pdf")


def test_a_picture_of_text_is_read_by_ocr():
    from app.docling_convert import convert_with_docling

    doc = convert_with_docling(make_png("Tangerine inventory"), "png")
    text = " ".join(" ".join(s["headingPath"]) + " " + s["text"] for s in doc["sections"]).lower()
    assert "tangerine" in text
    assert doc["ocrUsed"] is True
