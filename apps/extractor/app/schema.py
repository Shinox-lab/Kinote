"""The extractor's answer. Mirrors ExtractedDocumentSchema in packages/contracts (one shared fixture tests both)."""
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class Section(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    headingPath: List[str]
    pageFrom: Optional[int] = Field(default=None, gt=0)
    pageTo: Optional[int] = Field(default=None, gt=0)
    kind: Literal["text", "table"]
    text: str


class ExtractedDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    pageCount: Optional[int] = Field(default=None, ge=0)
    sections: List[Section]
    ocrUsed: bool
