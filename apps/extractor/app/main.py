"""POST /extract: bytes in, an ExtractedDocument out. No storage, no network, no tenant knowledge."""
from __future__ import annotations

import asyncio
import os
from typing import Any, Callable, Dict, Optional

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.errors import TooLarge, Unreadable
from app.schema import ExtractedDocument

# What Docling reads here; TXT, MD and CSV never reach this service and audio and video are only stored.
READS = {"pdf", "docx", "pptx", "xlsx", "png", "jpeg", "webp", "gif"}

Convert = Callable[[bytes, str], Dict[str, Any]]


def _error(status: int, error: str) -> JSONResponse:
    # Fixed bodies: nothing about the file or its name is ever echoed.
    return JSONResponse(status_code=status, content={"error": error})


def create_app(
    convert: Optional[Convert] = None,
    max_chars: Optional[int] = None,
    concurrency: Optional[int] = None,
) -> FastAPI:
    if convert is None:
        from app.docling_convert import convert_with_docling

        convert = convert_with_docling
    limit = max_chars if max_chars is not None else int(os.environ.get("MAX_EXTRACTED_CHARS", "2000000"))
    # Docling is heavy: one conversion at a time unless told otherwise.
    gate = asyncio.Semaphore(concurrency or int(os.environ.get("EXTRACTOR_CONCURRENCY", "1")))
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    async def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.post("/extract")
    async def extract(request: Request) -> JSONResponse:
        file_type = request.headers.get("x-file-type", "")
        body = await request.body()
        if file_type not in READS or len(body) == 0:
            return _error(422, "unreadable")
        try:
            async with gate:
                raw = await run_in_threadpool(convert, body, file_type)
            doc = ExtractedDocument.model_validate(raw)
        except Unreadable:
            return _error(422, "unreadable")
        except TooLarge:
            return _error(413, "too_large")
        except (ValidationError, Exception):  # noqa: BLE001 - never leak the cause to the caller
            return _error(500, "internal")
        if sum(len(s.text) for s in doc.sections) > limit:
            return _error(413, "too_large")
        return JSONResponse(status_code=200, content=doc.model_dump())

    return app


def build() -> FastAPI:
    return create_app()
