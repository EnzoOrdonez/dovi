"""FFmpeg tool (plan §3.3 bidireccional).

Separación de responsabilidades:
  - ``request_manifest_and_extract_frame`` orquesta: abre un Future en el
    sse_bus, deja que el caller (rag_engine) emita el evento SSE
    ``manifest_request``, espera la reply, ejecuta ffmpeg, retorna bytes.
  - ``_run_ffmpeg_single_frame`` es el wrapper fino alrededor del subprocess.

Invariantes de seguridad (plan §4.10):
  - Las cookies/headers NO se persisten en disco ni se loguean.
  - El subprocess se lanza con una lista fija de args (sin shell=True) y un
    timeout duro; ffmpeg se invoca con ``-hide_banner -loglevel error``.
"""

from __future__ import annotations

import asyncio
import subprocess
import uuid
from typing import Any

import structlog

from app.core.config import get_settings
from app.services import sse_bus

_log = structlog.get_logger(__name__)


class ManifestUnavailableError(Exception):
    """La extensión no respondió dentro del timeout. El agente debe responder texto-only."""


class FrameExtractionFailedError(Exception):
    """ffmpeg devolvió non-zero o timeout del subprocess."""


# ---------- API pública ----------


async def prepare_frame_request() -> tuple[str, asyncio.Future[dict[str, Any]]]:
    """Abre un request_id + future antes de emitir el evento SSE.

    Retorna ``(request_id, future)`` — el caller (rag_engine) es responsable de:
      1. Emitir ``{"event": "manifest_request", "data": json}`` al cliente.
      2. ``await asyncio.wait_for(future, timeout=...)``.
      3. Pasar el resultado a ``extract_frame_from_reply``.
      4. Llamar a ``sse_bus.close_request(request_id)`` en ``finally``.
    """
    request_id = uuid.uuid4().hex
    future = sse_bus.open_request(request_id)
    return request_id, future


async def extract_frame_from_reply(
    reply: dict[str, Any],
    timestamp_ms: int,
) -> bytes:
    """Ejecuta ffmpeg con el manifest recibido y devuelve bytes JPEG del frame.

    ``reply`` debe tener forma: ``{url: str, cookies: str, request_headers: dict}``
    (matches ``app.models.manifest.manifest_reply``).
    """
    url = reply.get("url")
    if not url:
        raise FrameExtractionFailedError("reply_missing_url")
    cookies = reply.get("cookies") or ""
    headers = reply.get("request_headers") or {}

    return await asyncio.to_thread(
        _run_ffmpeg_single_frame, url, cookies, headers, timestamp_ms
    )


async def request_manifest_and_extract_frame(
    session_id: str,
    timestamp_ms: int,
) -> bytes:
    """Flujo completo (para callers que NO necesiten emitir el evento ellos mismos).

    Abre Future, espera reply por ``manifest_request_timeout_sec``, ejecuta ffmpeg.
    NOTA: el caller sigue siendo responsable de emitir el evento SSE por su stream.
    Este helper es principalmente para tests unitarios del ffmpeg path con un
    reply ya preparado.
    """
    s = get_settings()
    request_id, future = await prepare_frame_request()
    try:
        try:
            reply = await asyncio.wait_for(future, timeout=s.manifest_request_timeout_sec)
        except TimeoutError as e:
            _log.warning(
                "manifest_request_timeout",
                session_id=session_id,
                request_id=request_id,
                timeout=s.manifest_request_timeout_sec,
            )
            raise ManifestUnavailableError("extension_did_not_reply") from e
        return await extract_frame_from_reply(reply, timestamp_ms)
    finally:
        sse_bus.close_request(request_id)


# ---------- subprocess wrapper ----------


def _run_ffmpeg_single_frame(
    url: str,
    cookies: str,
    headers: dict[str, str],
    timestamp_ms: int,
) -> bytes:
    """Invoca ffmpeg y devuelve JPEG bytes. Bloquea — correr en thread."""
    hms = _ms_to_hms(timestamp_ms)
    header_str = _build_headers(cookies, headers)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-headers", header_str,
        "-ss", hms,
        "-i", url,
        "-frames:v", "1",
        "-q:v", "2",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-",
    ]
    try:
        result = subprocess.run(  # noqa: S603
            cmd, capture_output=True, timeout=20, check=True,
        )
    except subprocess.TimeoutExpired as e:
        raise FrameExtractionFailedError("ffmpeg_timeout") from e
    except subprocess.CalledProcessError as e:
        # stderr NUNCA se loguea con el header_str expandido (contiene cookies).
        raise FrameExtractionFailedError(f"ffmpeg_exit_{e.returncode}") from e
    except FileNotFoundError as e:
        raise FrameExtractionFailedError("ffmpeg_binary_missing") from e

    if not result.stdout:
        raise FrameExtractionFailedError("empty_frame_output")
    return result.stdout


def _ms_to_hms(ms: int) -> str:
    total_s, rem_ms = divmod(max(ms, 0), 1000)
    m, s = divmod(total_s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{rem_ms:03d}"


def _build_headers(cookies: str, headers: dict[str, str]) -> str:
    """Construye el string ``-headers`` para ffmpeg. Excluye headers inválidos."""
    lines: list[str] = []
    if cookies:
        lines.append(f"Cookie: {cookies}")
    banned = {"cookie", "host", "content-length", "content-encoding"}
    for k, v in headers.items():
        if k.lower() in banned:
            continue
        lines.append(f"{k}: {v}")
    # ffmpeg espera \r\n entre headers y termina con \r\n final.
    return "\r\n".join(lines) + "\r\n"


__all__ = [
    "FrameExtractionFailedError",
    "ManifestUnavailableError",
    "extract_frame_from_reply",
    "prepare_frame_request",
    "request_manifest_and_extract_frame",
]
