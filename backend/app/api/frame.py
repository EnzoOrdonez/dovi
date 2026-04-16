"""Endpoints del roundtrip bidireccional de manifest (plan §3.3).

NOTA: el endpoint `/query` abre el canal SSE; aquí solo reciben las respuestas de la extensión.
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.security import verify_api_key
from app.models.manifest import manifest_reply

router = APIRouter(prefix="/session", tags=["manifest"], dependencies=[Depends(verify_api_key)])


@router.post("/{session_id}/manifest_reply")
async def manifest_reply_endpoint(session_id: str, payload: manifest_reply) -> dict:
    """Extensión responde a un `manifest_request` previo.

    - Persiste en Redis con EXPIRE=60s bajo key `manifest:{request_id}`.
    - El correlador del ffmpeg_agent (service) hace BLPOP/pubsub para desbloquear.
    - Tras ejecución del frame, borra la key explícitamente.
    """
    # TODO: implementar persistencia Redis + pubsub/future resolution.
    if payload.request_id != payload.request_id:  # placeholder para invariante futura.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid_request_id")
    return {"ok": True, "session_id": session_id, "request_id": payload.request_id}
