"""Turns Docling's items (in reading order) into our sections.

The items are read by class name and attribute, so this module does not import Docling and is tested with stubs:
`TitleItem` / `SectionHeaderItem` set the heading path, `TableItem` becomes a table section, every other item with
text (paragraphs, list items, captions, code) is prose, pictures and blank text are skipped. For a spreadsheet the
sheet number, and for a slide deck the slide number, is the page Docling reports.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple

HEADINGS = {"TitleItem", "SectionHeaderItem"}


def _page(item: Any) -> Optional[int]:
    prov = getattr(item, "prov", None) or []
    page = getattr(prov[0], "page_no", None) if prov else None
    return page if isinstance(page, int) and page > 0 else None


def _table_text(item: Any) -> str:
    grid = getattr(getattr(item, "data", None), "grid", None) or []
    rows = []
    for row in grid:
        cells = [(getattr(c, "text", "") or "").strip() for c in row]
        if any(cells):
            rows.append(" | ".join(cells))
    return "\n".join(rows)


def to_extracted(
    items: Iterable[Tuple[Any, int]],
    page_count: Optional[int],
    ocr_used: bool,
) -> Dict[str, Any]:
    sections: List[Dict[str, Any]] = []
    stack: List[Tuple[int, str]] = []
    # The prose section being filled; closed by a heading, a table or a page change.
    current: Optional[Dict[str, Any]] = None
    # A heading nothing followed yet: if no body arrives before the next heading, its own text is the content.
    bare: Optional[Tuple[int, Optional[int]]] = None

    def close() -> None:
        nonlocal current
        current = None

    def flush_bare() -> None:
        nonlocal bare
        if bare is not None and stack:
            sections.append(
                {
                    "headingPath": [t for _, t in stack],
                    "pageFrom": bare[1],
                    "pageTo": bare[1],
                    "kind": "text",
                    "text": stack[-1][1],
                }
            )
        bare = None

    def section(kind: str, text: str, page: Optional[int]) -> Dict[str, Any]:
        sec = {
            "headingPath": [t for _, t in stack],
            "pageFrom": page,
            "pageTo": page,
            "kind": kind,
            "text": text,
        }
        sections.append(sec)
        return sec

    for item, _level in items:
        kind = type(item).__name__
        page = _page(item)
        if kind in HEADINGS:
            text = (getattr(item, "text", "") or "").strip()
            if not text:
                continue
            level = 0 if kind == "TitleItem" else max(int(getattr(item, "level", 1) or 1), 1)
            # A heading with a deeper heading right after it is a parent, not content; any other
            # heading that nothing was written under is content itself.
            if bare is not None and level > bare[0]:
                bare = None
            flush_bare()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, text))
            bare = (level, page)
            close()
        elif kind == "TableItem":
            text = _table_text(item)
            close()
            if text:
                bare = None
                section("table", text, page)
        elif kind == "PictureItem":
            continue
        else:
            text = (getattr(item, "text", "") or "").strip()
            if not text:
                continue
            bare = None
            path = [t for _, t in stack]
            if current is not None and current["headingPath"] == path and current["pageFrom"] == page:
                current["text"] += "\n\n" + text
            else:
                current = section("text", text, page)
    flush_bare()
    return {"pageCount": page_count, "sections": sections, "ocrUsed": ocr_used}
