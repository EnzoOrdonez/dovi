"""ASR service — faster-whisper wrapper.

CRÍTICO (plan §2.4.1): suma `absolute_start_offset_ms` a cada cue devuelto por Whisper
antes de emitirlos al chunker. Sin esto, los timestamps son relativos al blob.
"""

from pathlib import Path

from app.core.config import get_settings
from app.models.chunk import cue


class asr_service:
    """Lazy-init del modelo para evitar costo en import-time."""

    def __init__(self) -> None:
        self._model = None

    def _load(self) -> None:
        if self._model is not None:
            return
        # TODO: WhisperModel(...). Deferred para evitar dependencia en smoke tests.
        # from faster_whisper import WhisperModel
        # s = get_settings()
        # self._model = WhisperModel(s.whisper_model_size, device=s.whisper_device, compute_type=s.whisper_compute_type)
        _ = get_settings()

    def transcribe(self, audio_path: Path, absolute_start_offset_ms: int) -> list[cue]:
        """Transcribe blob y devuelve cues con tiempos ABSOLUTOS (post-offset)."""
        self._load()
        # TODO: segments, _ = self._model.transcribe(str(audio_path), vad_filter=True, language="es")
        # raw_cues = [
        #     cue(
        #         t_start_ms=int(seg.start * 1000) + absolute_start_offset_ms,
        #         t_end_ms=int(seg.end * 1000) + absolute_start_offset_ms,
        #         speaker=None,
        #         text=seg.text.strip(),
        #         source_level=2,
        #     )
        #     for seg in segments
        # ]
        # return raw_cues
        _ = audio_path, absolute_start_offset_ms
        return []


_singleton: asr_service | None = None


def get_asr() -> asr_service:
    global _singleton
    if _singleton is None:
        _singleton = asr_service()
    return _singleton
