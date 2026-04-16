"""FFmpeg tool (plan §3.3 bidireccional).

Flujo:
  1. LLM invoca extract_frame(timestamp_ms).
  2. Esta función emite `manifest_request` al canal SSE de la sesión.
  3. Espera reply via Redis key `manifest:{request_id}` con timeout configurable.
  4. Ejecuta ffmpeg single-frame contra la URL recibida.
  5. Borra la key Redis explícitamente.
  6. Retorna bytes del frame al agente.

El backend NO persiste la URL entre invocaciones.
"""

import asyncio
import subprocess
import uuid
from pathlib import Path

from app.core.config import get_settings


class manifest_unavailable_error(Exception):
    """La extensión no respondió en el timeout. El agente debe responder texto-only."""


async def extract_frame(session_id: str, timestamp_ms: int) -> bytes:
    """Retorna bytes JPEG del frame en `timestamp_ms`. Raises manifest_unavailable_error."""
    s = get_settings()
    request_id = str(uuid.uuid4())

    # TODO: emit manifest_request al canal SSE de session_id con request_id.
    # TODO: await future = await asyncio.wait_for(await_redis_key(f"manifest:{request_id}"), timeout=s.manifest_request_timeout_sec)
    #       donde await_redis_key hace subscribe a pubsub para resolución inmediata.

    try:
        manifest_url, cookies, headers = await _await_reply(request_id, timeout=s.manifest_request_timeout_sec)
    except asyncio.TimeoutError as e:
        raise manifest_unavailable_error("extension_did_not_reply") from e

    hms = _ms_to_hms(timestamp_ms)
    header_str = _build_headers(cookies, headers)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-headers", header_str,
        "-ss", hms,
        "-i", manifest_url,
        "-frames:v", "1",
        "-q:v", "2",
        "-f", "image2pipe",
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=20, check=True)  # noqa: S603
        return result.stdout
    finally:
        # TODO: redis.delete(f"manifest:{request_id}") — SIEMPRE, incluso en error.
        pass

    _ = session_id, Path  # silenciar linter hasta implementación.


async def _await_reply(
    request_id: str, timeout: float
) -> tuple[str, str, dict[str, str]]:
    """STUB. Implementación real: Redis pubsub + deserialización."""
    _ = request_id, timeout
    raise asyncio.TimeoutError


def _ms_to_hms(ms: int) -> str:
    s, m = divmod(ms // 1000, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms % 1000:03d}"


def _build_headers(cookies: str, headers: dict[str, str]) -> str:
    lines = []
    if cookies:
        lines.append(f"Cookie: {cookies}")
    for k, v in headers.items():
        if k.lower() in {"cookie", "host", "content-length"}:
            continue
        lines.append(f"{k}: {v}")
    return "\r\n".join(lines) + "\r\n"
