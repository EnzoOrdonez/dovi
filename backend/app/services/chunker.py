"""Chunker con solapamiento (plan §3.1).

Contrato:
  - Agrupa `cue`s en bloques de ~`target_tokens` con `overlap_tokens` de cola.
  - Restricción dura: un chunk NO puede partir un turno de speaker. Si el boundary
    natural cae dentro de un turno, se desplaza hasta +20% del tamaño buscando
    cambio de locutor. Si no aparece, se corta en el target (fallback determinista).
  - Aproxima tokens por palabras con factor 0.75 (1 palabra ≈ 1.33 tokens en
    tokenizers BPE mixtos ES/EN). Suficiente para BGE-M3 con margen.
  - Cada chunk arrastra timestamps absolutos (`t_start_ms`, `t_end_ms`) del primer
    y último cue incluidos. Esto es load-bearing para los hipervínculos del §2.5.

El caller decide si pasar `list[chunk_draft]` a un embedder o a `to_chunks(...)` para
enriquecer con `chunk_metadata` (session_id, embedding_model, schema_version, …).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

import structlog

from app.models.chunk import chunk, chunk_metadata, cue

_log = structlog.get_logger(__name__)

# Factor del plan §3.1 (tokens ≈ palabras / 0.75).
_WORDS_PER_TOKEN = 0.75
# Tolerancia dura para buscar boundary de locutor antes de forzar corte.
_OVERSHOOT_RATIO = 0.20


@dataclass(slots=True)
class chunk_draft:
    """Chunk pre-embedding. Mantiene referencia a los cues originales para trazabilidad."""

    cues: list[cue]
    text: str
    t_start_ms: int
    t_end_ms: int
    speaker: str | None
    token_estimate: int = 0
    # Hash estable para dedupe idempotente (plan §4.7 + §4.22).
    content_hash: str = field(default="")

    def __post_init__(self) -> None:
        if not self.content_hash:
            self.content_hash = _content_hash(self.t_start_ms, self.text)


def chunk_cues(
    cues: list[cue],
    target_tokens: int = 512,
    overlap_tokens: int = 64,
) -> list[chunk_draft]:
    """Divide una lista ordenada de cues en chunks con overlap y respeto de speaker.

    Retorna lista vacía si `cues` está vacía. No hace IO.
    """
    if target_tokens <= 0:
        raise ValueError("target_tokens must be > 0")
    if overlap_tokens < 0 or overlap_tokens >= target_tokens:
        raise ValueError("overlap_tokens must be in [0, target_tokens)")
    if not cues:
        return []

    # Defensivo: garantizar orden temporal. Whisper puede entregar segmentos
    # ya ordenados, pero Nivel 0/1 concatenan distintos adapters — mejor prevenir.
    ordered = sorted(cues, key=lambda c: (c.t_start_ms, c.t_end_ms))

    target_words = max(1, int(target_tokens * _WORDS_PER_TOKEN))
    overlap_words = max(0, int(overlap_tokens * _WORDS_PER_TOKEN))
    overshoot_limit = int(target_words * (1.0 + _OVERSHOOT_RATIO))

    drafts: list[chunk_draft] = []
    i = 0
    n = len(ordered)

    while i < n:
        acc: list[cue] = []
        acc_words = 0
        j = i

        # Acumular hasta alcanzar el target.
        while j < n and acc_words < target_words:
            c = ordered[j]
            acc.append(c)
            acc_words += _word_count(c.text)
            j += 1

        # Si aún hay cues disponibles y el límite cayó dentro de un turno,
        # intentar extender hasta +20% buscando cambio de speaker.
        if j < n and acc_words < overshoot_limit and acc:
            last_speaker = acc[-1].speaker
            while j < n and acc_words < overshoot_limit:
                nxt = ordered[j]
                if nxt.speaker is not None and nxt.speaker != last_speaker:
                    # Boundary limpio: el próximo cue ya es otro speaker,
                    # cortar ANTES de incluirlo.
                    break
                acc.append(nxt)
                acc_words += _word_count(nxt.text)
                last_speaker = nxt.speaker or last_speaker
                j += 1

        if not acc:
            # Protección: no debería ocurrir, pero evita loop infinito.
            _log.warning("chunker_empty_accumulator", index=i, total=n)
            break

        drafts.append(_build_draft(acc))

        if j >= n:
            break

        # Paso siguiente: retroceder `overlap_words` dentro de la ventana recién emitida
        # para construir el overlap del próximo chunk.
        next_i = _rewind_for_overlap(ordered, j, overlap_words)
        # Garantía de progreso: al menos un cue de avance.
        i = max(next_i, i + 1)

    return drafts


def to_chunks(
    drafts: list[chunk_draft],
    session_id: str,
    video_id: str,
    platform: str,
    embedding_model: str,
    source_level: int = 0,
    schema_version: int = 1,
) -> list[chunk]:
    """Proyecta drafts a `chunk` con metadata completa para persistencia en Qdrant."""
    out: list[chunk] = []
    for d in drafts:
        chunk_id = _chunk_id(session_id, d.content_hash)
        meta = chunk_metadata(
            video_id=video_id,
            session_id=session_id,
            t_start_ms=d.t_start_ms,
            t_end_ms=d.t_end_ms,
            speaker=d.speaker,
            source_level=source_level,  # type: ignore[arg-type]
            platform=platform,
            embedding_model=embedding_model,
            schema_version=schema_version,
        )
        out.append(chunk(chunk_id=chunk_id, text=d.text, metadata=meta))
    return out


# ---------- helpers internos ----------


def _build_draft(cues_in: list[cue]) -> chunk_draft:
    text = " ".join(c.text.strip() for c in cues_in if c.text.strip())
    t_start = min(c.t_start_ms for c in cues_in)
    t_end = max(c.t_end_ms for c in cues_in)
    # Si todos los cues comparten speaker, propaga; si no, None (speaker heterogéneo).
    speakers = {c.speaker for c in cues_in}
    speaker = speakers.pop() if len(speakers) == 1 else None
    token_estimate = int(sum(_word_count(c.text) for c in cues_in) / _WORDS_PER_TOKEN)
    return chunk_draft(
        cues=cues_in,
        text=text,
        t_start_ms=t_start,
        t_end_ms=t_end,
        speaker=speaker,
        token_estimate=token_estimate,
    )


def _rewind_for_overlap(ordered: list[cue], j: int, overlap_words: int) -> int:
    """Calcula índice inicial del siguiente chunk retrocediendo `overlap_words`.

    Nunca retrocede antes del inicio de la ventana; preserva progreso.
    """
    if overlap_words <= 0 or j == 0:
        return j
    acc = 0
    k = j - 1
    while k > 0 and acc < overlap_words:
        acc += _word_count(ordered[k].text)
        k -= 1
    # Si el retroceso absorbe todo, avanzamos al menos un cue.
    return max(k + 1, 0)


def _word_count(text: str) -> int:
    # Split por whitespace: robusto para ES/EN; puntuación adherida cuenta como parte
    # de la palabra, lo cual subestima ligeramente tokens (compensado por el factor 0.75).
    return len(text.split()) if text else 0


def _content_hash(t_start_ms: int, text: str) -> str:
    # Plan §4.7: sha1(t_start_ms + text[:32]) para dedupe idempotente.
    h = hashlib.sha1(usedforsecurity=False)
    h.update(str(t_start_ms).encode("utf-8"))
    h.update(b"|")
    h.update(text[:32].encode("utf-8"))
    return h.hexdigest()


def _chunk_id(session_id: str, content_hash: str) -> str:
    # Chunk id estable: permite upsert idempotente aunque re-procesemos el mismo audio.
    h = hashlib.sha1(usedforsecurity=False)
    h.update(session_id.encode("utf-8"))
    h.update(b":")
    h.update(content_hash.encode("utf-8"))
    return h.hexdigest()
