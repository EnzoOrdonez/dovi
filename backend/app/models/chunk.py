"""Pydantic schemas para chunks e ingesta. Tabla singular: `chunk` (convención)."""

from typing import Literal

from pydantic import BaseModel, Field

source_level_t = Literal[0, 1, 2]


class cue(BaseModel):
    """Unidad atómica emitida por cualquier nivel de extracción."""

    t_start_ms: int = Field(ge=0)
    t_end_ms: int = Field(ge=0)
    speaker: str | None = None
    text: str
    source_level: source_level_t


class chunk_metadata(BaseModel):
    """Metadatos por vector en Qdrant. `embedding_model` es load-bearing (plan §4.8)."""

    video_id: str
    session_id: str
    t_start_ms: int
    t_end_ms: int
    speaker: str | None = None
    source_level: source_level_t
    platform: str
    embedding_model: str
    schema_version: int = 1


class chunk(BaseModel):
    """Chunk indexable. Texto + metadatos; el embedding vive en Qdrant."""

    chunk_id: str
    text: str
    metadata: chunk_metadata


class ingest_request(BaseModel):
    """Payload de /ingest. Los cues pueden venir de Nivel 0/1 o del ASR post-Nivel 2."""

    session_id: str
    video_id: str
    platform: str
    cues: list[cue]
    # Para Nivel 2: si los cues ya vienen con offset aplicado, este campo es informativo.
    absolute_start_offset_ms: int | None = None
