"""Endpoints del dashboard web de curación (plan Fase 6 / Hito 3).

Expone sólo información agregada sobre sesiones y chunks vectorizados. NO incluye
endpoints de borrado — la curación es read-only en esta iteración (evita superficies
destructivas expuestas sobre single-tenant self-host sin CSRF).

Implementación: usa `scroll` de Qdrant para listar puntos. `scroll` no ordena por
score (no aplica) — ordenamos en Python por `t_start_ms` tras recolectar.

Invariantes:
  - Filtro obligatorio por `embedding_model` para no mezclar espacios vectoriales
    (plan §4.8), aunque el dashboard no ejecute búsquedas (los chunks ya sólo se
    indexaron con el modelo configurado).
  - Los payloads devueltos NO incluyen el vector denso (no `with_vectors`), para
    mantener la carga ligera en el frontend.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.config import get_settings
from app.core.security import verify_api_key
from app.services.vector_store import get_qdrant_client

_log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api", tags=["dashboard"], dependencies=[Depends(verify_api_key)])


# ---------- schemas (exclusivos del dashboard) ----------


class session_summary(BaseModel):
    session_id: str
    video_id: str | None
    platform: str | None
    chunk_count: int
    duration_ms: int
    t_start_ms: int
    t_end_ms: int
    source_levels: list[int]


class chunk_row(BaseModel):
    chunk_id: str
    t_start_ms: int
    t_end_ms: int
    text: str
    speaker: str | None
    source_level: int | None


class session_detail(BaseModel):
    session_id: str
    chunks: list[chunk_row]


# ---------- helpers ----------


def _scroll_all(session_filter: Any | None = None, batch: int = 256) -> list[Any]:
    """Itera `scroll` de Qdrant paginando hasta agotar la colección.

    Qdrant no expone scroll async nativo en el client síncrono; lo envolvemos
    aquí y el caller lo despacha vía `asyncio.to_thread`.
    """
    s = get_settings()
    client = get_qdrant_client()
    out: list[Any] = []
    next_offset: Any = None
    while True:
        points, next_offset = client.scroll(
            collection_name=s.qdrant_collection,
            scroll_filter=session_filter,
            limit=batch,
            offset=next_offset,
            with_payload=True,
            with_vectors=False,
        )
        out.extend(points)
        if next_offset is None:
            break
    return out


def _build_session_filter(session_id: str) -> Any:
    # Import local — evita acoplar el router al SDK si se migra a otro vector store.
    from qdrant_client.models import FieldCondition, Filter, MatchValue  # noqa: PLC0415

    s = get_settings()
    return Filter(
        must=[
            FieldCondition(key="session_id", match=MatchValue(value=session_id)),
            FieldCondition(key="embedding_model", match=MatchValue(value=s.embedding_model)),
        ],
    )


def _build_model_filter() -> Any:
    from qdrant_client.models import FieldCondition, Filter, MatchValue  # noqa: PLC0415

    s = get_settings()
    return Filter(
        must=[FieldCondition(key="embedding_model", match=MatchValue(value=s.embedding_model))],
    )


# ---------- endpoints ----------


@router.get("/sessions", response_model=list[session_summary])
async def list_sessions(limit: int = Query(default=100, ge=1, le=500)) -> list[session_summary]:
    """Lista sesiones agregando chunks por `session_id`.

    La agregación ocurre en Python — Qdrant no expone group_by nativo suficiente.
    El `limit` se aplica al número de sesiones devueltas, NO al scroll interno.
    """
    flt = _build_model_filter()
    try:
        points = await asyncio.to_thread(_scroll_all, flt)
    except Exception as exc:
        _log.error("dashboard_scroll_error", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="qdrant_unavailable",
        ) from exc

    by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for p in points:
        payload = dict(p.payload or {})
        sid = payload.get("session_id")
        if not sid:
            continue
        by_session[sid].append(payload)

    summaries: list[session_summary] = []
    for sid, payloads in by_session.items():
        t_starts = [int(x.get("t_start_ms", 0)) for x in payloads]
        t_ends = [int(x.get("t_end_ms", 0)) for x in payloads]
        levels = sorted({int(x.get("source_level", 0)) for x in payloads})
        t_start = min(t_starts) if t_starts else 0
        t_end = max(t_ends) if t_ends else 0
        summaries.append(
            session_summary(
                session_id=sid,
                video_id=payloads[0].get("video_id"),
                platform=payloads[0].get("platform"),
                chunk_count=len(payloads),
                duration_ms=max(0, t_end - t_start),
                t_start_ms=t_start,
                t_end_ms=t_end,
                source_levels=levels,
            )
        )

    # Orden: más chunks primero (heurística de "sesión más curada").
    summaries.sort(key=lambda s: s.chunk_count, reverse=True)
    return summaries[:limit]


@router.get("/sessions/{session_id}", response_model=session_detail)
async def get_session(session_id: str) -> session_detail:
    """Devuelve todos los chunks de una sesión ordenados por `t_start_ms`."""
    flt = _build_session_filter(session_id)
    try:
        points = await asyncio.to_thread(_scroll_all, flt)
    except Exception as exc:
        _log.error("dashboard_scroll_error", session_id=session_id, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="qdrant_unavailable",
        ) from exc

    if not points:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="session_not_found_or_empty",
        )

    rows: list[chunk_row] = []
    for p in points:
        payload = dict(p.payload or {})
        rows.append(
            chunk_row(
                chunk_id=str(p.id),
                t_start_ms=int(payload.get("t_start_ms", 0)),
                t_end_ms=int(payload.get("t_end_ms", 0)),
                text=str(payload.get("text", "")),
                speaker=payload.get("speaker"),
                source_level=payload.get("source_level"),
            )
        )
    rows.sort(key=lambda r: r.t_start_ms)
    return session_detail(session_id=session_id, chunks=rows)
