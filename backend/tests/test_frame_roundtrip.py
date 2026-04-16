"""Tests del endpoint POST /session/{id}/manifest_reply (plan §3.3)."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio

from app.main import build_app
from app.services import sse_bus


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[httpx.AsyncClient, None]:
    app = build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_bus() -> None:
    sse_bus._reset_for_tests()


HEADERS = {"X-DOVI-Token": "test-key"}


@pytest.mark.asyncio
async def test_manifest_reply_requires_api_key(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/session/s1/manifest_reply",
        json={
            "request_id": "x",
            "url": "https://example.com/m.m3u8",
            "cookies": "",
            "request_headers": {},
        },
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_manifest_reply_unknown_request_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/session/s1/manifest_reply",
        headers=HEADERS,
        json={
            "request_id": "ghost-id",
            "url": "https://example.com/m.m3u8",
            "cookies": "",
            "request_headers": {},
        },
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_manifest_reply_resolves_pending_future(client: httpx.AsyncClient) -> None:
    fut = sse_bus.open_request("req-abc")
    resp = await client.post(
        "/session/s1/manifest_reply",
        headers=HEADERS,
        json={
            "request_id": "req-abc",
            "url": "https://example.com/m.m3u8",
            "cookies": "session=xyz",
            "request_headers": {"Referer": "https://example.com/"},
        },
    )
    assert resp.status_code == HTTPStatus.OK
    assert fut.done()
    reply = fut.result()
    assert reply["url"] == "https://example.com/m.m3u8"
    assert reply["cookies"] == "session=xyz"
    assert reply["request_headers"]["Referer"] == "https://example.com/"
