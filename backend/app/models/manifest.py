"""Schemas del roundtrip bidireccional de manifest (plan §3.3)."""

from pydantic import BaseModel, Field


class manifest_request(BaseModel):
    """Emitido por backend via SSE → extensión."""

    request_id: str
    session_id: str
    requested_timestamp_ms: int


class manifest_reply(BaseModel):
    """Enviado por extensión → backend (POST /session/{id}/manifest_reply)."""

    request_id: str
    url: str
    cookies: str = ""
    request_headers: dict[str, str] = Field(default_factory=dict)
