"""Map-Reduce Summarizer asíncrono (plan §3.2).

- Map: cada chunk → resumen, paralelo con Semaphore(8).
- Reduce tree: lotes de 5 → nodo parent. Itera hasta 1.
- Budget guard: trackea tokens, dispara downgrade de LLM antes de superar umbral.
"""

import asyncio


async def summarize_session(session_id: str, max_concurrent: int = 8) -> str:
    """STUB. Tree summarize asíncrono."""
    semaphore = asyncio.Semaphore(max_concurrent)
    _ = session_id, semaphore
    # TODO: leer chunks de Qdrant por session_id.
    # TODO: map phase: summarize(chunk) en paralelo bounded.
    # TODO: reduce phase: agrupar en lotes de 5, resumir, iterar.
    return ""
