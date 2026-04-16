"""Tests de los endpoints del dashboard (plan Fase 6 / Hito 3).

Estrategia de mocking:
  - Parcheamos `app.api.dashboard._scroll_all` para devolver puntos fake —
    evita depender de un Qdrant real.
  - Los puntos fake exponen `.id` y `.payload` (contrato mínimo que consume el handler).
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import pytest_asyncio

from app.main import build_app


@dataclass
class _fake_point:
    id: str
    payload: dict[str, Any]


HEADERS = {"X-DOVI-Token": "test-key"}


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[httpx.AsyncClient, None]:
    app = build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_list_sessions_requires_api_key(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/sessions")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_list_sessions_aggregates_by_session_id(client: httpx.AsyncClient) -> None:
    points = [
        _fake_point(
            id="c1",
            payload={
                "session_id": "S1",
                "video_id": "V1",
                "platform": "youtube",
                "t_start_ms": 1000,
                "t_end_ms": 5000,
                "source_level": 0,
            },
        ),
        _fake_point(
            id="c2",
            payload={
                "session_id": "S1",
                "video_id": "V1",
                "platform": "youtube",
                "t_start_ms": 5000,
                "t_end_ms": 9000,
                "source_level": 1,
            },
        ),
        _fake_point(
            id="c3",
            payload={
                "session_id": "S2",
                "video_id": "V2",
                "platform": "moodle",
                "t_start_ms": 0,
                "t_end_ms": 3000,
                "source_level": 2,
            },
        ),
    ]

    with patch("app.api.dashboard._scroll_all", return_value=points):
        resp = await client.get("/api/sessions", headers=HEADERS)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body) == 2
    # Orden: más chunks primero → S1 antes que S2.
    assert body[0]["session_id"] == "S1"
    assert body[0]["chunk_count"] == 2
    assert body[0]["duration_ms"] == 8000  # 9000 - 1000
    assert sorted(body[0]["source_levels"]) == [0, 1]
    assert body[1]["session_id"] == "S2"
    assert body[1]["chunk_count"] == 1


@pytest.mark.asyncio
async def test_get_session_returns_chunks_sorted(client: httpx.AsyncClient) -> None:
    points = [
        _fake_point(
            id="c2",
            payload={
                "session_id": "S1",
                "t_start_ms": 5000,
                "t_end_ms": 9000,
                "text": "segundo",
                "speaker": "Ada",
                "source_level": 1,
            },
        ),
        _fake_point(
            id="c1",
            payload={
                "session_id": "S1",
                "t_start_ms": 1000,
                "t_end_ms": 5000,
                "text": "primero",
                "speaker": None,
                "source_level": 0,
            },
        ),
    ]

    with patch("app.api.dashboard._scroll_all", return_value=points):
        resp = await client.get("/api/sessions/S1", headers=HEADERS)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["session_id"] == "S1"
    assert len(body["chunks"]) == 2
    # Orden por t_start_ms.
    assert body["chunks"][0]["chunk_id"] == "c1"
    assert body["chunks"][0]["text"] == "primero"
    assert body["chunks"][1]["chunk_id"] == "c2"
    assert body["chunks"][1]["speaker"] == "Ada"


@pytest.mark.asyncio
async def test_get_session_empty_returns_404(client: httpx.AsyncClient) -> None:
    with patch("app.api.dashboard._scroll_all", return_value=[]):
        resp = await client.get("/api/sessions/ghost", headers=HEADERS)
    assert resp.status_code == HTTPStatus.NOT_FOUND
