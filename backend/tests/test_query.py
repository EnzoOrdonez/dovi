"""Tests del endpoint POST /query (plan §6 — verificación SSE).

Estrategia de mocking:
  - `app.api.query.astream_query` se parchea para evitar llamadas reales a
    Qdrant y Anthropic.
  - `httpx.AsyncClient` con `ASGITransport` permite probar SSE sin servidor real.

Casos cubiertos:
  1. Sin token → 401.
  2. Sesión sin chunks → stream emite event="error" data="Video_Not_Indexed".
  3. Happy path (tokens + done) → stream emite correctamente ambos eventos.
  4. Error de LLM → stream emite event="error" con el mensaje.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from http import HTTPStatus
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import pytest_asyncio

from app.main import build_app

# ---------- helpers ----------


def _make_stream(*events: dict[str, str]) -> Any:
    """Devuelve una función que imita la firma de `astream_query` y emite los eventos dados."""

    async def _gen(
        session_id: str,
        question: str,
        **kwargs: Any,
    ) -> AsyncGenerator[dict[str, str], None]:
        # session_id / question / kwargs usados sólo para coincidir con la firma real.
        _ = session_id, question, kwargs
        for e in events:
            yield e

    return _gen


def _collect_sse_lines(content: bytes) -> list[str]:
    """Parsea el body de una respuesta SSE y devuelve las líneas no vacías."""
    return [line for line in content.decode().splitlines() if line.strip()]


# ---------- fixtures ----------


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[httpx.AsyncClient, None]:
    app = build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


HEADERS = {"X-DOVI-Token": "test-key"}
PAYLOAD = {"session_id": "sess-abc", "question": "¿qué explica el video?"}


# ---------- tests ----------


@pytest.mark.asyncio
async def test_query_requires_api_key(client: httpx.AsyncClient) -> None:
    """Sin token → 401 antes de abrir el stream."""
    resp = await client.post("/query", json=PAYLOAD)
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_query_video_not_indexed(client: httpx.AsyncClient) -> None:
    """Qdrant vacío para la sesión → event error con data=Video_Not_Indexed."""
    stream_mock = _make_stream({"event": "error", "data": "Video_Not_Indexed"})

    with patch("app.api.query.astream_query", new=stream_mock):
        async with client.stream("POST", "/query", headers=HEADERS, json=PAYLOAD) as resp:
            assert resp.status_code == HTTPStatus.OK
            content = await resp.aread()

    lines = _collect_sse_lines(content)
    assert any("Video_Not_Indexed" in line for line in lines)
    assert any(line.startswith("event: error") for line in lines)


@pytest.mark.asyncio
async def test_query_happy_path(client: httpx.AsyncClient) -> None:
    """Tokens + done → el stream emite correctamente ambos tipos de evento."""
    stream_mock = _make_stream(
        {"event": "token", "data": "El video"},
        {"event": "token", "data": " trata sobre"},
        {"event": "token", "data": " redes neuronales."},
        {"event": "done", "data": "[DONE]"},
    )

    with patch("app.api.query.astream_query", new=stream_mock):
        async with client.stream("POST", "/query", headers=HEADERS, json=PAYLOAD) as resp:
            assert resp.status_code == HTTPStatus.OK
            content = await resp.aread()

    lines = _collect_sse_lines(content)
    token_lines = [
        line for line in lines if line.startswith("data:") and "trata sobre" in line
    ]
    done_lines = [line for line in lines if "[DONE]" in line]
    assert token_lines, "No se encontraron líneas de token en el stream"
    assert done_lines, "No se encontró el evento done en el stream"


@pytest.mark.asyncio
async def test_query_propagates_llm_error(client: httpx.AsyncClient) -> None:
    """Si el LLM falla, el stream emite event=error y termina."""
    stream_mock = _make_stream(
        {"event": "error", "data": "anthropic_api_key_missing_or_placeholder"},
    )

    with patch("app.api.query.astream_query", new=stream_mock):
        async with client.stream("POST", "/query", headers=HEADERS, json=PAYLOAD) as resp:
            content = await resp.aread()

    lines = _collect_sse_lines(content)
    assert any("anthropic_api_key_missing_or_placeholder" in line for line in lines)
