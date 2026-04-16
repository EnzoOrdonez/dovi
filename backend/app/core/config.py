"""Configuración global del backend. Lee .env via pydantic-settings.

Convención: nombres en snake_case (internos) con alias MAYÚSCULA (env).
Self-host single-tenant — sin JWT, sin multi-tenant.

Búsqueda de .env en orden:
  1. Raíz del monorepo (DOVI/.env) — modo dev local.
  2. Directorio actual (backend/.env) — modo container (montado por docker-compose).
"""

from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_MONOREPO_ENV = Path(__file__).resolve().parents[2] / ".env"


class settings(BaseSettings):
    """Settings raíz. Accesible vía `get_settings()`."""

    model_config = SettingsConfigDict(
        env_file=(str(_MONOREPO_ENV), ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Auth
    dovi_api_key: str = Field(alias="DOVI_API_KEY")

    # LLM cloud (Anthropic)
    anthropic_api_key: str = Field(alias="ANTHROPIC_API_KEY")
    anthropic_model_default: str = Field(
        default="claude-opus-4-6", alias="ANTHROPIC_MODEL_DEFAULT"
    )
    anthropic_model_downgrade: str = Field(
        default="claude-haiku-4-5-20251001", alias="ANTHROPIC_MODEL_DOWNGRADE"
    )

    # LLM local (Ollama)
    ollama_base_url: str = Field(
        default="http://host.docker.internal:11434", alias="OLLAMA_BASE_URL"
    )

    # Vector store
    qdrant_url: str = Field(default="http://qdrant:6333", alias="QDRANT_URL")
    qdrant_collection: str = Field(default="chunk", alias="QDRANT_COLLECTION")
    qdrant_vector_size: int = Field(default=1024, alias="QDRANT_VECTOR_SIZE")
    qdrant_quantization: Literal["none", "scalar_int8"] = Field(
        default="none", alias="QDRANT_QUANTIZATION"
    )

    # Queue / cache
    redis_url: str = Field(default="redis://redis:6379/0", alias="REDIS_URL")

    # ASR
    whisper_model_size: str = Field(default="small", alias="WHISPER_MODEL_SIZE")
    whisper_compute_type: str = Field(default="int8_float16", alias="WHISPER_COMPUTE_TYPE")
    whisper_device: str = Field(default="auto", alias="WHISPER_DEVICE")

    # Embeddings
    embedding_model: str = Field(default="BAAI/bge-m3", alias="EMBEDDING_MODEL")
    embedding_device: str = Field(default="auto", alias="EMBEDDING_DEVICE")

    # Budget guard
    session_usd_budget: float = Field(default=0.50, alias="SESSION_USD_BUDGET")

    # Manifest roundtrip (plan §3.3)
    manifest_request_timeout_sec: float = Field(default=3.0, alias="MANIFEST_REQUEST_TIMEOUT_SEC")
    manifest_redis_ttl_sec: int = Field(default=60, alias="MANIFEST_REDIS_TTL_SEC")

    # Logging
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    log_format: Literal["json", "console"] = Field(default="json", alias="LOG_FORMAT")

    # API
    api_host: str = Field(default="0.0.0.0", alias="API_HOST")
    api_port: int = Field(default=8000, alias="API_PORT")
    api_cors_origins: str = Field(default="chrome-extension://*", alias="API_CORS_ORIGINS")


_cached: settings | None = None


def get_settings() -> settings:
    global _cached
    if _cached is None:
        _cached = settings()  # type: ignore[call-arg]
    return _cached
