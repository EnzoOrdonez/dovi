"""Tests de la heurística `_has_visual_keyword` (plan §3.3).

Cubre:
  - Keywords ES+EN que deben matchear (tokenización word-boundary).
  - Falsos positivos clásicos que NO deben matchear (`framework`, `Frame` dentro
    de palabras compuestas, `diagnóstico` contra `diagrama`, etc.).
  - Case-insensitivity.
"""

from __future__ import annotations

import pytest

from app.services.rag_engine import _has_visual_keyword


@pytest.mark.parametrize(
    "question",
    [
        "¿Qué diagrama aparece al inicio?",
        "Describe el slide del minuto 3",
        "Qué muestra la pantalla en 00:14:22",
        "Explica el gráfico de barras",
        "What diagram is shown on screen?",
        "Is there a chart visible at 0:05?",
        "Extract the frame at timestamp 12s",
        "What figure illustrates the process?",
        "DIAGRAMA en mayúsculas también",  # case-insensitive
    ],
)
def test_visual_keywords_match(question: str) -> None:
    assert _has_visual_keyword(question) is True


@pytest.mark.parametrize(
    "question",
    [
        "Explica el framework utilizado",  # 'frame' dentro de 'framework' → no match
        "Cuál fue el diagnóstico del paciente",  # no contiene 'diagrama'
        "Describe el contenido del audio",
        "Resume el video",
        "",
    ],
)
def test_non_visual_keywords_do_not_match(question: str) -> None:
    assert _has_visual_keyword(question) is False
