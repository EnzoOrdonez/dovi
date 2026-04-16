"""Tests unitarios del bus SSE (plan §3.3).

Cubre la correlación request_id ↔ future que sostiene el roundtrip de manifest:
  - `open_request` crea un future pendiente.
  - `resolve_request` desbloquea al waiter.
  - `resolve_request` sobre id desconocido → False.
  - `resolve_request` sobre future ya resuelto → False (idempotencia).
  - `close_request` elimina el registro (idempotente).
"""

from __future__ import annotations

import asyncio

import pytest

from app.services import sse_bus


@pytest.fixture(autouse=True)
def _reset_bus() -> None:
    sse_bus._reset_for_tests()


@pytest.mark.asyncio
async def test_open_creates_pending_future() -> None:
    fut = sse_bus.open_request("rid-1")
    assert sse_bus.is_pending("rid-1") is True
    assert not fut.done()


@pytest.mark.asyncio
async def test_resolve_releases_waiter() -> None:
    fut = sse_bus.open_request("rid-2")

    async def _waiter() -> dict:
        return await asyncio.wait_for(fut, timeout=1.0)

    task = asyncio.create_task(_waiter())
    await asyncio.sleep(0)  # yield al waiter
    ok = sse_bus.resolve_request("rid-2", {"url": "x", "cookies": "", "request_headers": {}})
    assert ok is True
    result = await task
    assert result["url"] == "x"


@pytest.mark.asyncio
async def test_resolve_unknown_returns_false() -> None:
    assert sse_bus.resolve_request("never-opened", {"url": "x"}) is False


@pytest.mark.asyncio
async def test_resolve_twice_is_idempotent() -> None:
    sse_bus.open_request("rid-3")
    assert sse_bus.resolve_request("rid-3", {"url": "a"}) is True
    assert sse_bus.resolve_request("rid-3", {"url": "b"}) is False


@pytest.mark.asyncio
async def test_close_request_removes_registry() -> None:
    sse_bus.open_request("rid-4")
    sse_bus.close_request("rid-4")
    assert sse_bus.is_pending("rid-4") is False
    # Idempotente.
    sse_bus.close_request("rid-4")
    sse_bus.close_request("never-existed")


@pytest.mark.asyncio
async def test_close_does_not_cancel_already_resolved_future() -> None:
    sse_bus.open_request("rid-5")
    sse_bus.resolve_request("rid-5", {"url": "y"})
    # Close tras resolve no debe lanzar.
    sse_bus.close_request("rid-5")
    assert sse_bus.is_pending("rid-5") is False
