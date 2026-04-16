"""POST /ingest — recibe cues (Nivel 0/1) o chunks de audio (Nivel 2).

- Nivel 0/1: JSON con ingest_request → encola chunker + embedding.
- Nivel 2: multipart con audio blob + absolute_start_offset_ms → encola ASR, luego chunker.
"""

from fastapi import APIRouter, Depends, File, Form, UploadFile

from app.core.security import verify_api_key
from app.models.chunk import ingest_request

router = APIRouter(prefix="/ingest", tags=["ingest"], dependencies=[Depends(verify_api_key)])


@router.post("/cues")
async def ingest_cues(payload: ingest_request) -> dict:
    """Ingesta textual de cues ya estructurados (Nivel 0/1)."""
    # TODO: encolar dramatiq task → chunker → embedder → qdrant upsert.
    return {"accepted": len(payload.cues), "session_id": payload.session_id}


@router.post("/audio")
async def ingest_audio(
    session_id: str = Form(...),
    run_id: str = Form(...),
    chunk_index: int = Form(...),
    absolute_start_offset_ms: int = Form(...),
    audio: UploadFile = File(...),
) -> dict:
    """Ingesta de blob Nivel 2. El offset se propagará a cada cue post-Whisper (plan §2.4.1)."""
    # TODO: persistir blob en tmp, encolar task ASR con el offset.
    return {
        "accepted": True,
        "session_id": session_id,
        "run_id": run_id,
        "chunk_index": chunk_index,
        "absolute_start_offset_ms": absolute_start_offset_ms,
        "audio_bytes": audio.size or 0,
    }
