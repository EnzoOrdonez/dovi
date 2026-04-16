"""Qdrant wrapper (plan §Stack + §4.8 filtro por embedding_model).

Default: Float32. Scalar Int8 solo si env QDRANT_QUANTIZATION=scalar_int8 (plan corrección #3).
NUNCA binary quantization con BGE-M3 — destruye recall.
"""

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    ScalarQuantization,
    ScalarQuantizationConfig,
    ScalarType,
    VectorParams,
)

from app.core.config import get_settings


def get_qdrant_client() -> QdrantClient:
    return QdrantClient(url=get_settings().qdrant_url)


def ensure_collection() -> None:
    """Crea la colección `chunk` si no existe, con la config correcta de quantization."""
    s = get_settings()
    client = get_qdrant_client()

    if client.collection_exists(s.qdrant_collection):
        return

    quantization = None
    if s.qdrant_quantization == "scalar_int8":
        quantization = ScalarQuantization(
            scalar=ScalarQuantizationConfig(type=ScalarType.INT8, always_ram=True),
        )

    client.create_collection(
        collection_name=s.qdrant_collection,
        vectors_config=VectorParams(size=s.qdrant_vector_size, distance=Distance.COSINE),
        quantization_config=quantization,
    )


def build_embedding_filter(embedding_model: str) -> Filter:
    """Filtro obligatorio para prevenir mismatch local↔remoto (plan §4.8)."""
    return Filter(
        must=[FieldCondition(key="embedding_model", match=MatchValue(value=embedding_model))],
    )
