"""Docling items become our sections. Stubs carry the class names the mapping reads."""
from types import SimpleNamespace as NS

from app.mapping import to_extracted


class Prov(NS):
    pass


def prov(page):
    return [Prov(page_no=page)]


class TitleItem(NS):
    pass


class SectionHeaderItem(NS):
    pass


class TextItem(NS):
    pass


class ListItem(NS):
    pass


class TableItem(NS):
    pass


class PictureItem(NS):
    pass


def items(*pairs):
    return [(item, 0) for item in pairs]


def cell(text):
    return NS(text=text)


def test_headings_set_the_path_and_text_under_one_heading_joins():
    doc = to_extracted(
        items(
            TitleItem(text="Handbook", prov=prov(1)),
            SectionHeaderItem(text="Leave", level=1, prov=prov(1)),
            TextItem(text="One.", prov=prov(1)),
            ListItem(text="Two.", prov=prov(1)),
            SectionHeaderItem(text="Pay", level=1, prov=prov(2)),
            TextItem(text="Three.", prov=prov(2)),
        ),
        page_count=2,
        ocr_used=False,
    )
    assert doc["pageCount"] == 2 and doc["ocrUsed"] is False
    assert [(s["headingPath"], s["pageFrom"], s["pageTo"], s["text"]) for s in doc["sections"]] == [
        (["Handbook", "Leave"], 1, 1, "One.\n\nTwo."),
        (["Handbook", "Pay"], 2, 2, "Three."),
    ]


def test_a_deeper_heading_nests_and_a_shallower_one_closes():
    doc = to_extracted(
        items(
            SectionHeaderItem(text="A", level=1, prov=prov(1)),
            SectionHeaderItem(text="A1", level=2, prov=prov(1)),
            TextItem(text="x", prov=prov(1)),
            SectionHeaderItem(text="B", level=1, prov=prov(1)),
            TextItem(text="y", prov=prov(1)),
        ),
        page_count=1,
        ocr_used=False,
    )
    assert [s["headingPath"] for s in doc["sections"]] == [["A", "A1"], ["B"]]


def test_a_table_is_its_own_section_with_rows_joined_by_pipes():
    table = TableItem(
        prov=prov(2),
        data=NS(grid=[[cell("Grade"), cell("Days")], [cell("A"), cell("5")], [cell(""), cell("")]]),
    )
    doc = to_extracted(
        items(SectionHeaderItem(text="Pay", level=1, prov=prov(2)), TextItem(text="intro", prov=prov(2)), table),
        page_count=2,
        ocr_used=False,
    )
    kinds = [(s["kind"], s["text"]) for s in doc["sections"]]
    assert kinds == [("text", "intro"), ("table", "Grade | Days\nA | 5")]
    assert doc["sections"][1]["headingPath"] == ["Pay"]
    assert doc["sections"][1]["pageFrom"] == doc["sections"][1]["pageTo"] == 2


def test_text_on_a_new_page_starts_a_new_section_so_pages_stay_exact():
    doc = to_extracted(
        items(TextItem(text="p1", prov=prov(1)), TextItem(text="p2", prov=prov(2))),
        page_count=2,
        ocr_used=False,
    )
    assert [(s["pageFrom"], s["text"]) for s in doc["sections"]] == [(1, "p1"), (2, "p2")]


def test_pictures_blank_text_and_items_without_provenance():
    doc = to_extracted(
        items(
            PictureItem(prov=prov(1)),
            TextItem(text="   ", prov=prov(1)),
            TextItem(text="kept", prov=[]),
        ),
        page_count=None,
        ocr_used=True,
    )
    assert doc["pageCount"] is None and doc["ocrUsed"] is True
    assert [(s["pageFrom"], s["pageTo"], s["text"]) for s in doc["sections"]] == [(None, None, "kept")]


def test_nothing_readable_gives_no_sections():
    assert to_extracted([], page_count=0, ocr_used=False)["sections"] == []


def test_a_heading_with_nothing_under_it_is_still_content():
    doc = to_extracted(
        items(
            SectionHeaderItem(text="Tangerine inventory", level=1, prov=prov(1)),
            SectionHeaderItem(text="Closing note", level=1, prov=prov(2)),
        ),
        page_count=2,
        ocr_used=True,
    )
    assert [(s["headingPath"], s["pageFrom"], s["text"]) for s in doc["sections"]] == [
        (["Tangerine inventory"], 1, "Tangerine inventory"),
        (["Closing note"], 2, "Closing note"),
    ]


def test_a_heading_followed_by_text_is_not_repeated_as_content():
    doc = to_extracted(
        items(SectionHeaderItem(text="Leave", level=1, prov=prov(1)), TextItem(text="body", prov=prov(1))),
        page_count=1,
        ocr_used=False,
    )
    assert [s["text"] for s in doc["sections"]] == ["body"]
