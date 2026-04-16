"""POST /query — RAG retrieval + LLM con streaming SSE (plan §3.3, §4.1).

Flujo:
  1. Valida X-DOVI-Token (dependency `verify_api_key`).
  2. Llama a `rag_engine.astream_query` que emite dicts {event, data}.
  3. Envuelve el generador en `EventSourceResponse`; sse-starlette escribe
     el protocolo SSE al cliente (la extensión / offscreen).
  4. Si el cliente cierra la conexión, Starlette cancela la coroutine;
     `asyncio.CancelledError` se deja propagar — el generador del rag_engine
     es abortado automáticamente sin dejar tareas colgadas.

Eventos emitidos (ver también offscreen.ts `apply_sse_event`):
  - "token"  — delta de texto del LLM.
  - "error"  — fallo irrecuperable; `data` contiene el código de error.
               Incluye "Video_Not_Indexed" cuando la sesión no tiene chunks.
  - "done"   — fin del stream; `data` = "[DONE]".
"""

import asyncio
from collections.abc import AsyncGenerator

import structlog
from fastapi import APIRouter, Depends
from sse_starlette.sse import EventSourceResponse

from app.core.security import verify_api_key
from app.models.session import query_request
from app.services.llm_router import llm_tier
from app.services.rag_engine import astream_query

_log = structlog.get_logger(__name__)

router = APIRouter(prefix="/query", tags=["query"], dependencies=[Depends(verify_api_key)])


@router.post("")
async def query_endpoint(payload: query_request) -> EventSourceResponse:
    """Respuesta en streaming SSE. Ver docstring del módulo para detalle de eventos."""
    session_id = payload.session_id
    question = payload.question

    async def event_stream() -> AsyncGenerator[dict[str, str], None]:
        try:
            async for event in astream_query(
                session_id=session_id,
                question=question,
                tier=llm_tier.opus,
            ):
                yield event
        except asyncio.CancelledError:
            # El cliente cerró la conexión antes de que terminara el stream.
            # No emitimos nada — la conexión ya está cerrada.
            _log.info("query_stream_cancelled", session_id=session_id)
            raise  # Permite a Starlette limpiar la respuesta correctamente.

    return EventSourceResponse(event_stream())
