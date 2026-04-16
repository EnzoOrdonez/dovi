"""Dramatiq actors con exponential backoff (plan §3.5 + §Restriction).

Broker: Redis. Max retries=5, backoff jittered 1s..60s. Circuit breaker por provider.
"""

import dramatiq
from dramatiq.brokers.redis import RedisBroker
from dramatiq.middleware import AgeLimit, Callbacks, Pipelines, Retries, ShutdownNotifications, TimeLimit

from app.core.config import get_settings

_broker = RedisBroker(url=get_settings().redis_url)
# Middleware conservador: retries con backoff; sin prometheus stub que requiere endpoint extra.
_broker.add_middleware(AgeLimit())
_broker.add_middleware(TimeLimit())
_broker.add_middleware(ShutdownNotifications())
_broker.add_middleware(Callbacks())
_broker.add_middleware(Pipelines())
_broker.add_middleware(Retries())
dramatiq.set_broker(_broker)


@dramatiq.actor(max_retries=5, min_backoff=1_000, max_backoff=60_000)
def transcribe_audio(
    session_id: str,
    run_id: str,
    chunk_index: int,
    absolute_start_offset_ms: int,
    audio_path: str,
) -> None:
    """STUB — poblar con asr_service.transcribe + dedup (plan §4.22) + encolar chunker."""
    _ = session_id, run_id, chunk_index, absolute_start_offset_ms, audio_path


@dramatiq.actor(max_retries=5, min_backoff=1_000, max_backoff=60_000)
def chunk_and_embed(session_id: str, video_id: str, platform: str) -> None:
    """STUB — lee cues acumulados de Redis, chunk_cues(), embed BGE-M3, upsert Qdrant."""
    _ = session_id, video_id, platform


@dramatiq.actor(max_retries=5, min_backoff=1_000, max_backoff=60_000)
def summarize_full_session(session_id: str) -> None:
    """STUB — invoca summarizer_mapreduce.summarize_session, respeta budget guard."""
    _ = session_id
