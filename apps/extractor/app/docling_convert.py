"""The real conversion with Docling. Imported lazily: tests of everything else never load the models."""
from __future__ import annotations

import os
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


def _document_timeout() -> float:
    """Seconds Docling may spend on one document; kept under the worker's EXTRACTOR_TIMEOUT_MS (default 240 s)."""
    return float(os.environ.get("EXTRACTOR_DOCUMENT_TIMEOUT_S", "200"))


def _get_converter() -> Any:
    global _converter
    with _lock:
        if _converter is None:
            from docling.datamodel.base_models import InputFormat
            from docling.datamodel.pipeline_options import PdfPipelineOptions
            from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

            # Default pipelines (layout, tables and OCR on) with a time limit per document, so one huge
            # file cannot hold the single conversion slot while the worker has long given up on it.
            options = PdfPipelineOptions(document_timeout=_document_timeout())
            _converter = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(pipeline_options=options),
                    InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
                }
            )
        return _converter


def interpret(result: Any, file_type: str) -> Dict[str, Any]:
    """Only a complete success is indexed. Docling reports PARTIAL_SUCCESS when pages failed or the time
    limit hit: indexing that would silently drop text, so it is refused like any unreadable file."""
    if getattr(result.status, "name", str(result.status)) != "SUCCESS":
        raise Unreadable()
    doc = result.document
    return to_extracted(
        doc.iterate_items(),
        page_count=len(doc.pages) if getattr(doc, "pages", None) else None,
        ocr_used=file_type in IMAGES,
    )


def convert_with_docling(data: bytes, file_type: str) -> Dict[str, Any]:
    from docling.datamodel.base_models import DocumentStream
    from docling.exceptions import ConversionError

    # A fixed name: the caller's file name is never trusted or logged here.
    source = DocumentStream(name=f"upload.{EXTENSION[file_type]}", stream=BytesIO(data))
    try:
        result = _get_converter().convert(source, raises_on_error=False)
    except ConversionError as err:
        raise Unreadable() from err
    return interpret(result, file_type)
