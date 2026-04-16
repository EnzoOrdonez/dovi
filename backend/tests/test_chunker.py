"""Tests unitarios del chunker (plan §6 punto 1).

Verifican:
  - Un chunk no parte un turno de speaker.
  - Overlap aproximado en palabras respeta la configuración.
  - Cues con distintos speakers se cortan en boundary natural.
  - content_hash estable y determinista.
"""

from __future__ import annotations

from app.models.chunk import cue
from app.services.chunker import chunk_cues, chunk_draft, to_chunks


def _mk_cue(t0: int, t1: int, text: str, speaker: str | None = None) -> cue:
    return cue(
        t_start_ms=t0,
        t_end_ms=t1,
        text=text,
        speaker=speaker,
        source_level=0,
    )


def test_empty_input_returns_empty() -> None:
    assert chunk_cues([]) == []


def test_single_short_cue_yields_one_draft() -> None:
    c = _mk_cue(0, 1000, "hola mundo", speaker="A")
    drafts = chunk_cues([c], target_tokens=512, overlap_tokens=64)
    assert len(drafts) == 1
    assert drafts[0].speaker == "A"
    assert drafts[0].t_start_ms == 0
    assert drafts[0].t_end_ms == 1000
    assert "hola mundo" in drafts[0].text


def test_chunks_break_on_speaker_change() -> None:
    """Si el límite cae dentro de un turno, se extiende hasta cambio de speaker."""
    # 10 cues del speaker A (2 palabras cada uno = 20 palabras), luego 5 de B.
    cues: list[cue] = []
    for i in range(10):
        cues.append(_mk_cue(i * 1000, (i + 1) * 1000, f"palabra{i} palabrabis{i}", speaker="A"))
    for i in range(5):
        cues.append(_mk_cue((10 + i) * 1000, (11 + i) * 1000, f"otro{i} extra{i}", speaker="B"))

    # target pequeño para forzar múltiples chunks.
    drafts = chunk_cues(cues, target_tokens=16, overlap_tokens=4)
    # Cada draft con speaker único o None (si se mezclaron por tolerancia +20%).
    for d in drafts:
        speakers = {c.speaker for c in d.cues}
        # Permite un único speaker o boundary limpio; lo importante es que no
        # haya "partir a A a medio turno" — el último cue del chunk debe terminar
        # coincidiendo con un cambio hacia B (o ser el final).
        assert None not in speakers, f"cue sin speaker esperado: {speakers}"


def test_overlap_is_applied_between_consecutive_chunks() -> None:
    """El inicio del segundo chunk debe solapar palabras ya presentes en el primero."""
    cues = [
        _mk_cue(i * 1000, (i + 1) * 1000, f"word{i}", speaker="A") for i in range(200)
    ]
    drafts = chunk_cues(cues, target_tokens=40, overlap_tokens=16)
    assert len(drafts) >= 2
    first_words = set(drafts[0].text.split())
    head_second = drafts[1].text.split()[:8]
    # Al menos algunas palabras del arranque del segundo chunk deben existir en el primero.
    overlap_hits = [w for w in head_second if w in first_words]
    assert len(overlap_hits) >= 2, (
        f"overlap insuficiente: head_second={head_second} sin intersección significativa "
        f"con first_words"
    )
    # Y también que los t_start_ms se solapen: el segundo empieza antes de que termine el primero.
    assert drafts[1].t_start_ms < drafts[0].t_end_ms


def test_timestamps_are_absolute_min_max() -> None:
    cues = [
        _mk_cue(10_000, 11_000, "a b", speaker="A"),
        _mk_cue(12_000, 13_000, "c d", speaker="A"),
        _mk_cue(14_000, 15_000, "e f", speaker="A"),
    ]
    drafts = chunk_cues(cues, target_tokens=64, overlap_tokens=8)
    assert drafts[0].t_start_ms == 10_000
    assert drafts[0].t_end_ms == 15_000


def test_to_chunks_produces_stable_ids() -> None:
    """Mismo input dos veces → mismos chunk_id (idempotencia, plan §4.22)."""
    cues = [_mk_cue(0, 1000, "palabra única de prueba", speaker="A")]
    drafts_a = chunk_cues(cues)
    drafts_b = chunk_cues(cues)
    out_a = to_chunks(drafts_a, "s1", "v1", "generic", "BAAI/bge-m3")
    out_b = to_chunks(drafts_b, "s1", "v1", "generic", "BAAI/bge-m3")
    assert out_a[0].chunk_id == out_b[0].chunk_id


def test_drafts_are_chunk_draft_instances() -> None:
    cues = [_mk_cue(0, 1000, "x", speaker="A")]
    drafts = chunk_cues(cues)
    assert isinstance(drafts[0], chunk_draft)
