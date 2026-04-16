"""RAG engine — retrieval en Qdrant + LLM con validación anti-alucinación.

Plan §3.3 + §4.6 + §4.8.

Pipeline:
  1. Embed de la pregunta con BGE-M3 (lazy import; requiere `--extra embeddings`).
  2. Búsqueda en Qdrant con filtro `{session_id, embedding_model}` — NUNCA mezclar
     espacios vectoriales entre modelos distintos (plan §4.8).
  3. Prompt al LLM con los chunks recuperados y la instrucción de emitir
     referencias `[[ts:HH:MM:SS.mmm|chunk_id:<id>]]`.
  4. Validación estricta: cualquier `chunk_id` emitido debe estar en el conjunto
     recuperado. Si no, se aborta con `hallucinated_reference_error` para que el
     caller decida reintentar con feedback (LlamaIndex `RetryQueryEngine`) o fallar.

El frame extractor (tool `extract_frame`) se cablea desde el endpoint SSE
(`/query`) porque emite eventos a la extensión; aquí solo se devuelve texto.
"""

from __future__ import annotations

import asyncio
import inspect
import re
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any

import structlog
from qdrant_client.models import FieldCondition, Filter, MatchValue

from app.core.config import get_settings
from app.models.chunk import chunk_metadata
from app.models.session import query_response, ts_reference
from app.services.llm_router import build_llm, llm_tier
from app.services.vector_store import get_qdrant_client

_log = structlog.get_logger(__name__)

# Regex del marcador de referencia. Captura (ts_string, chunk_id).
# Formato: [[ts:HH:MM:SS.mmm|chunk_id:<hex>]]
_REF_RE = re.compile(r"\[\[ts:([^|]+)\|chunk_id:([^\]]+)\]\]")
_TS_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$")

_SYSTEM_PROMPT = (
    "Eres el asistente DOVI. Respondes preguntas sobre un video usando EXCLUSIVAMENTE "
    "los fragmentos de transcripción proporcionados. Cuando cites información, "
    "incluye una referencia en el formato [[ts:HH:MM:SS.mmm|chunk_id:<id>]] "
    "usando el chunk_id y t_start del fragmento que la soporta. NUNCA inventes "
    "un chunk_id ni un timestamp: si no aparece en los fragmentos, responde que "
    "no tienes esa información."
)


class hallucinated_reference_error(Exception):
    """El LLM emitió un chunk_id inexistente. El caller debe reintentar o fallar."""


class embeddings_unavailable_error(Exception):
    """Extras de embedding no instalados. Pedir `uv sync --extra embeddings`."""


@dataclass(slots=True)
class retrieved_chunk:
    chunk_id: str
    text: str
    t_start_ms: int
    t_end_ms: int
    score: float
    metadata: dict[str, Any]


# ---------- embeddings ----------


_embedder_singleton: Any = None


def _get_embedder() -> Any:
    """Lazy init del encoder BGE-M3. Raise si el extra no está disponible."""
    global _embedder_singleton
    if _embedder_singleton is not None:
        return _embedder_singleton
    s = get_settings()
    try:
        # Lazy: el extra `embeddings` pesa >1GB; no debe forzarse en imports.
        from llama_index.embeddings.huggingface import HuggingFaceEmbedding  # noqa: PLC0415
    except ImportError as e:
        raise embeddings_unavailable_error(
            "install_with:uv sync --extra embeddings"
        ) from e
    device = None if s.embedding_device == "auto" else s.embedding_device
    _embedder_singleton = HuggingFaceEmbedding(
        model_name=s.embedding_model,
        device=device,
    )
    return _embedder_singleton


async def embed_query(text: str) -> list[float]:
    """Vector denso de la pregunta. BGE-M3 → 1024d."""
    embedder = _get_embedder()
    # LlamaIndex HuggingFaceEmbedding expone `aget_query_embedding` asíncrona.
    return await embedder.aget_query_embedding(text)


# ---------- retrieval ----------


async def retrieve(
    session_id: str,
    question_vector: list[float],
    top_k: int = 8,
) -> list[retrieved_chunk]:
    """Busca en Qdrant top_k con filtro obligatorio por session_id + embedding_model."""
    s = get_settings()
    client = get_qdrant_client()

    flt = Filter(
        must=[
            FieldCondition(key="session_id", match=MatchValue(value=session_id)),
            FieldCondition(key="embedding_model", match=MatchValue(value=s.embedding_model)),
        ],
    )

    # qdrant-client aún ofrece `search` síncrono; lo envolvemos para no bloquear el loop.
    def _blocking_search() -> list[Any]:
        return client.search(
            collection_name=s.qdrant_collection,
            query_vector=question_vector,
            query_filter=flt,
            limit=top_k,
            with_payload=True,
        )

    hits = await asyncio.to_thread(_blocking_search)

    out: list[retrieved_chunk] = []
    for h in hits:
        payload = dict(h.payload or {})
        text = payload.get("text", "")
        out.append(
            retrieved_chunk(
                chunk_id=str(h.id),
                text=text,
                t_start_ms=int(payload.get("t_start_ms", 0)),
                t_end_ms=int(payload.get("t_end_ms", 0)),
                score=float(h.score or 0.0),
                metadata=payload,
            )
        )
    return out


# ---------- inference ----------


def _format_chunks_for_prompt(chunks: list[retrieved_chunk]) -> str:
    lines: list[str] = []
    for c in chunks:
        ts = _ms_to_hms(c.t_start_ms)
        lines.append(f"[chunk_id:{c.chunk_id} ts:{ts}]\n{c.text}")
    return "\n\n".join(lines)


async def _run_llm(tier: llm_tier, question: str, context: str) -> str:
    llm = build_llm(tier)
    # Usamos la API síncrona de LlamaIndex en un thread: algunos providers no exponen
    # aún `acomplete` para todas las versiones; el thread pool evita bloquear el loop.

    prompt = (
        f"{_SYSTEM_PROMPT}\n\n"
        f"Fragmentos:\n{context}\n\n"
        f"Pregunta: {question}\n"
        f"Respuesta:"
    )

    def _blocking() -> str:
        resp = llm.complete(prompt)
        return str(resp)

    return await asyncio.to_thread(_blocking)


# ---------- validación anti-alucinación ----------


def validate_references(text_with_refs: str, valid_chunk_ids: set[str]) -> list[ts_reference]:
    """Parsea las referencias del LLM y exige que todos los chunk_id sean reales.

    Retorna la lista de `ts_reference` extraídas. Si alguna cita un chunk_id
    ausente del retrieval, lanza `hallucinated_reference_error`.
    """
    found: list[ts_reference] = []
    for m in _REF_RE.finditer(text_with_refs):
        ts_str = m.group(1).strip()
        chunk_id = m.group(2).strip()
        if chunk_id not in valid_chunk_ids:
            raise hallucinated_reference_error(
                f"chunk_id_not_in_retrieval:{chunk_id}"
            )
        t_start_ms = _hms_to_ms(ts_str)
        if t_start_ms is None:
            raise hallucinated_reference_error(f"malformed_timestamp:{ts_str}")
        found.append(ts_reference(t_start_ms=t_start_ms, chunk_id=chunk_id))
    return found


# ---------- streaming entry point ----------


async def astream_query(
    session_id: str,
    question: str,
    tier: llm_tier = llm_tier.opus,
    top_k: int = 8,
) -> AsyncGenerator[dict[str, str], None]:
    """Pipeline RAG con streaming token-a-token.

    Genera dicts ``{"event": ..., "data": ...}`` listos para
    ``sse_starlette.EventSourceResponse``.

    Secuencia de eventos:
      - ``error / Video_Not_Indexed``  — sin chunks en Qdrant para esta sesión
                                         (LLM NO es invocado).
      - ``error / embeddings_unavailable`` — extras de embedding no instalados.
      - ``error / <msg>``              — fallo del LLM o de red.
      - ``token / <delta>``            — fragmento de texto del LLM (N veces).
      - ``done  / [DONE]``             — fin de stream.

    ``asyncio.CancelledError`` se deja propagar sin capturar para que el
    endpoint la trate y cierre la conexión limpiamente.
    """
    # 1. Embed —————————————————————————————————————————————————————————
    try:
        q_vec = await embed_query(question)
    except embeddings_unavailable_error as exc:
        _log.error("astream_embed_error", session_id=session_id, error=str(exc))
        yield {"event": "error", "data": "embeddings_unavailable"}
        return

    # 2. Retrieve ——————————————————————————————————————————————————————
    chunks = await retrieve(session_id, q_vec, top_k=top_k)
    if not chunks:
        _log.warning("astream_no_chunks", session_id=session_id, question=question[:80])
        yield {"event": "error", "data": "Video_Not_Indexed"}
        return

    # 3. Build prompt ——————————————————————————————————————————————————
    context = _format_chunks_for_prompt(chunks)
    prompt = (
        f"{_SYSTEM_PROMPT}\n\n"
        f"Fragmentos:\n{context}\n\n"
        f"Pregunta: {question}\n"
        f"Respuesta:"
    )

    # 4. Instanciar LLM ————————————————————————————————————————————————
    try:
        llm = build_llm(tier)
    except RuntimeError as exc:
        _log.error("astream_llm_build_error", session_id=session_id, tier=tier, error=str(exc))
        yield {"event": "error", "data": str(exc)}
        return

    # 5. Stream tokens —————————————————————————————————————————————————
    # `astream_complete` puede ser:
    #   a) async generator function → llamada devuelve AsyncGenerator directamente.
    #   b) coroutine que devuelve AsyncGenerator (patrón anterior de LlamaIndex).
    # `inspect.isawaitable` distingue los dos casos sin atrapar CancelledError.
    full_text = ""
    try:
        _call = llm.astream_complete(prompt)
        gen = (await _call) if inspect.isawaitable(_call) else _call
        async for chunk in gen:
            delta: str = getattr(chunk, "delta", None) or ""
            if delta:
                full_text += delta
                yield {"event": "token", "data": delta}
    except Exception as exc:
        _log.error("astream_llm_stream_error", session_id=session_id, error=str(exc))
        yield {"event": "error", "data": str(exc)}
        return

    # 6. Validación anti-alucinación (post-stream) —————————————————————
    # El texto ya fue emitido; si hay hallucination sólo logueamos — no podemos
    # retractarnos del stream. El endpoint puede decidir reintentar en iteraciones
    # futuras (LlamaIndex RetryQueryEngine, plan §4.6).
    valid_ids = {c.chunk_id for c in chunks}
    try:
        validate_references(full_text, valid_ids)
    except hallucinated_reference_error as exc:
        _log.warning(
            "astream_hallucinated_ref",
            session_id=session_id,
            error=str(exc),
            retrieved_ids=sorted(valid_ids)[:8],
        )

    _log.info(
        "astream_query_ok",
        session_id=session_id,
        tier=tier.value,
        retrieved=len(chunks),
        text_len=len(full_text),
    )
    yield {"event": "done", "data": "[DONE]"}


# ---------- entry point (no-streaming, kept for workers / summarizer) ----------


async def answer_query(
    session_id: str,
    question: str,
    tier: llm_tier = llm_tier.opus,
    top_k: int = 8,
) -> query_response:
    """Pipeline completo: embed → retrieve → LLM → validate.

    Propaga excepciones específicas (`embeddings_unavailable_error`,
    `hallucinated_reference_error`) para que el caller decida estrategia.
    """
    q_vec = await embed_query(question)
    chunks = await retrieve(session_id, q_vec, top_k=top_k)

    if not chunks:
        _log.warning("rag_empty_retrieval", session_id=session_id, question=question[:80])
        return query_response(
            text_with_refs="No encuentro contenido indexado para esta sesión.",
            references=[],
        )

    context = _format_chunks_for_prompt(chunks)
    raw = await _run_llm(tier, question, context)

    valid_ids = {c.chunk_id for c in chunks}
    try:
        refs = validate_references(raw, valid_ids)
    except hallucinated_reference_error as e:
        _log.warning(
            "rag_hallucinated_reference",
            session_id=session_id,
            error=str(e),
            retrieved_ids=sorted(valid_ids)[:8],
        )
        raise

    _log.info(
        "rag_answer_ok",
        session_id=session_id,
        tier=tier.value,
        retrieved=len(chunks),
        refs=len(refs),
    )
    return query_response(text_with_refs=raw, references=refs)


# ---------- helpers ----------


def _ms_to_hms(ms: int) -> str:
    total_s, remainder_ms = divmod(max(ms, 0), 1000)
    m_total, s = divmod(total_s, 60)
    h, m = divmod(m_total, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{remainder_ms:03d}"


def _hms_to_ms(hms: str) -> int | None:
    m = _TS_RE.match(hms)
    if not m:
        return None
    h, mm, s, ms = (int(g) for g in m.groups())
    return ((h * 60 + mm) * 60 + s) * 1000 + ms


__all__ = [
    "answer_query",
    "astream_query",
    "embed_query",
    "embeddings_unavailable_error",
    "hallucinated_reference_error",
    "retrieve",
    "retrieved_chunk",
    "validate_references",
]

# Re-export silencioso para mantener el linter contento con la importación de chunk_metadata
# (usado en type-annotations extendidas de payload Qdrant en futuras iteraciones).
_ = chunk_metadata
