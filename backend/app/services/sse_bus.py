"""Bus SSE in-memory con suspensión asíncrona para el roundtrip de manifest (plan §3.3).

Responsabilidad:
  - Exponer un registro ``request_id → asyncio.Future[dict]`` que permite a los
    tools agénticos (ffmpeg_agent) suspenderse hasta que la extensión devuelva
    el manifiesto HLS/DASH vía POST /session/{id}/manifest_reply.
  - La generación del evento SSE `manifest_request` se hace en el pipeline del
    rag_engine (single-flow: mismo async generator que emite tokens), por lo que
    este módulo sólo gestiona el correlador de respuestas — NO el stream.

Concurrencia:
  - Thread-safe a nivel de corrutinas (asyncio single-threaded event loop).
  - Single-worker only. Para multi-worker uvicorn se migrará a Redis pubsub
    (plan §4.14). El contrato de este módulo (``open_request / close_request /
    resolve_request``) se mantendrá idéntico al migrar.

Limpieza:
  - ``open_request`` asigna el future; ``close_request`` lo borra en ``finally``
    del caller. Si el future queda sin resolver tras el timeout, el caller
    debe llamar a ``close_request`` explícitamente (el registro NO se vacía
    automáticamente tras la cancelación del Future para permitir inspección
    en tests).
"""

from __future__ import annotations

import asyncio
from typing import Any

# Registry global ``request_id -> asyncio.Future`` resuelto por el endpoint
# ``POST /session/{session_id}/manifest_reply``.
_pending: dict[str, asyncio.Future[dict[str, Any]]] = {}


def open_request(request_id: str) -> asyncio.Future[dict[str, Any]]:
    """Registra un Future pendiente. Debe ser liberado por `close_request`.

    Si ``request_id`` ya existía, lo sobreescribe (caller responsable de IDs únicos).
    """
    loop = asyncio.get_event_loop()
    fut: asyncio.Future[dict[str, Any]] = loop.create_future()
    _pending[request_id] = fut
    return fut


def close_request(request_id: str) -> None:
    """Elimina el registro del ``request_id``. Idempotente."""
    _pending.pop(request_id, None)


def resolve_request(request_id: str, reply: dict[str, Any]) -> bool:
    """Resuelve el Future. Retorna True si existía y estaba pendiente, False en caso contrario.

    Un ``request_id`` desconocido indica que la extensión respondió tarde (tras
    timeout del tool) o tras reinicio del proceso — en ambos casos el endpoint
    debe devolver 404 para que el cliente no reintente.
    """
    fut = _pending.get(request_id)
    if not fut or fut.done():
        return False
    fut.set_result(reply)
    return True


def is_pending(request_id: str) -> bool:
    """Introspección para tests."""
    fut = _pending.get(request_id)
    return fut is not None and not fut.done()


def _reset_for_tests() -> None:
    """Limpieza agresiva entre tests. NO usar en producción."""
    for fut in _pending.values():
        if not fut.done():
            fut.cancel()
    _pending.clear()


__all__ = [
    "close_request",
    "is_pending",
    "open_request",
    "resolve_request",
]
