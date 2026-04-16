"""Schemas de sesión y query. Tabla singular: `session`."""

from pydantic import BaseModel, Field


class session(BaseModel):
    session_id: str
    video_id: str
    platform: str
    created_at_ms: int
    last_accessed_at_ms: int
    total_tokens_used: int = 0
    total_usd_spent: float = 0.0


class query_request(BaseModel):
    session_id: str
    question: str
    include_summary: bool = False


class ts_reference(BaseModel):
    """Referencia validada a un chunk. Evita alucinaciones (plan §4.6)."""

    t_start_ms: int = Field(ge=0)
    chunk_id: str


class query_response(BaseModel):
    """Respuesta con referencias. Validator externo (en rag_engine) re-chequea contra retrieval."""

    text_with_refs: str
    references: list[ts_reference]
    frame_image_b64: str | None = None  # Solo si la tool extract_frame fue invocada.
