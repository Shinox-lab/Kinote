"""The real conversion with Docling. Imported lazily: tests of everything else never load the models."""
from __future__ import annotations

from io import BytesIO
from threading import Lock
from typing import Any, Dict

from app.errors import Unreadable
from app.mapping import to_extracted

EXTENSION = {
    "pdf": "pdf",
    "docx": "docx",
    "pptx": "pptx",
    "xlsx": "xlsx",
    "png": "png",
    "jpeg": "jpg",
    "webp": "webp",
    "gif": "gif",
}
IMAGES = {"png", "jpeg", "webp", "gif"}

_converter: Any = None
_lock = Lock()


def _get_converter() -> Any:
    global _converter
    with _lock:
        if _converter is None:
            from docling.document_converter import DocumentConverter

            # Default pipelines: layout, tables and OCR on. The models are in the image (see the Dockerfile).
            _converter = DocumentConverter()
        return _converter


def convert_with_docling(data: bytes, file_type: str) -> Dict[str, Any]:
    from docling.datamodel.base_models import ConversionStatus, DocumentStream
    from docling.exceptions import ConversionError

    # A fixed name: the caller's file name is never trusted or logged here.
    source = DocumentStream(name=f"upload.{EXTENSION[file_type]}", stream=BytesIO(data))
    try:
        result = _get_converter().convert(source, raises_on_error=False)
    except ConversionError as err:
        raise Unreadable() from err
    if result.status not in (ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS):
        raise Unreadable()
    doc = result.document
    return to_extracted(
        doc.iterate_items(),
        page_count=len(doc.pages) if getattr(doc, "pages", None) else None,
        ocr_used=file_type in IMAGES,
    )
