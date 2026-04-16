"""Endpoints del roundtrip bidireccional de manifest (plan §3.3).

El endpoint ``POST /query`` es quien abre el canal SSE y emite el evento
``manifest_request``. Aquí SÓLO se correlaciona la respuesta de la extensión
con el Future pendiente registrado en ``sse_bus``.
"""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.security import verify_api_key
from app.models.manifest import manifest_reply
from app.services import sse_bus

_log = structlog.get_logger(__name__)

router = APIRouter(prefix="/session", tags=["manifest"], dependencies=[Depends(verify_api_key)])


@router.post("/{session_id}/manifest_reply")
async def manifest_reply_endpoint(session_id: str, payload: manifest_reply) -> dict:
    """La extensión responde a un ``manifest_request`` previo.

    - Busca el Future pendiente bajo ``payload.request_id``.
    - Si existe y sigue pendiente → set_result con el payload, desbloquea al tool.
    - Si no existe o ya está resuelto → 404 (timeout o duplicado).
    """
    reply_dict = {
        "url": payload.url,
        "cookies": payload.cookies,
        "request_headers": payload.request_headers,
    }
    resolved = sse_bus.resolve_request(payload.request_id, reply_dict)
    if not resolved:
        _log.warning(
            "manifest_reply_no_pending",
            session_id=session_id,
            request_id=payload.request_id,
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="request_id_not_pending_or_expired",
        )
    _log.info(
        "manifest_reply_resolved",
        session_id=session_id,
        request_id=payload.request_id,
    )
    return {"ok": True, "session_id": session_id, "request_id": payload.request_id}
