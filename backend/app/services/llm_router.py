"""LLM router: Anthropic Claude default + Haiku downgrade + Ollama fallback.

Plan §Stack + §3.4 + §4.14.

Reglas:
  - Credenciales exclusivamente via `get_settings()` (env). Nunca hardcoded.
  - Import lazy de los proveedores LlamaIndex (llama-index-llms-anthropic,
    llama-index-llms-ollama) para que los smoke tests no paguen coste de import
    ni requieran los extras instalados.
  - El budget tracker es in-memory y session-scoped. Para multi-worker se migrará
    a Redis (plan §4.14); contrato ya lo permite (todos los métodos son async).
  - Downgrade automático: Opus 4.6 → Haiku 4.5 → Ollama local. Nunca auto-upgrade;
    el usuario puede forzar reset de tier explícitamente al inicio de sesión.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING

import structlog

from app.core.config import get_settings

if TYPE_CHECKING:
    from llama_index.core.llms import LLM

_log = structlog.get_logger(__name__)


class llm_tier(StrEnum):
    opus = "opus"
    haiku = "haiku"
    local = "local"


# Pricing USD por 1M tokens (Anthropic listed rates).
# Mantener actualizado si Anthropic publica cambios oficiales.
_PRICING: dict[llm_tier, tuple[float, float]] = {
    # (input_usd_per_mtok, output_usd_per_mtok)
    llm_tier.opus: (15.0, 75.0),
    llm_tier.haiku: (1.0, 5.0),
    llm_tier.local: (0.0, 0.0),
}


def resolve_model(tier: llm_tier) -> str:
    """Devuelve el identificador de modelo concreto para el tier."""
    s = get_settings()
    match tier:
        case llm_tier.opus:
            return s.anthropic_model_default
        case llm_tier.haiku:
            return s.anthropic_model_downgrade
        case llm_tier.local:
            # Caller decide el modelo Ollama concreto (p.ej. "llama3.1:8b").
            # Devolvemos marcador neutro; `build_llm` acepta override.
            return "ollama"


def downgrade(current: llm_tier) -> llm_tier | None:
    """Devuelve el siguiente tier más barato o None si ya está en local."""
    match current:
        case llm_tier.opus:
            return llm_tier.haiku
        case llm_tier.haiku:
            return llm_tier.local
        case llm_tier.local:
            return None


def build_llm(tier: llm_tier, *, ollama_model: str | None = None) -> LLM:
    """Instancia un LLM LlamaIndex para el tier dado.

    - `opus` / `haiku` → `llama_index.llms.anthropic.Anthropic`
    - `local`          → `llama_index.llms.ollama.Ollama`

    Lanza `RuntimeError` si el tier requiere una dep no instalada o credencial ausente,
    en cuyo caso el caller debe llamar a `downgrade(tier)` y reintentar.
    """
    s = get_settings()
    model = resolve_model(tier)

    if tier in (llm_tier.opus, llm_tier.haiku):
        if not s.anthropic_api_key or s.anthropic_api_key.startswith("sk-ant-dev-placeholder"):
            # Evita colgar la request esperando un 401 de Anthropic en dev.
            raise RuntimeError("anthropic_api_key_missing_or_placeholder")
        try:
            from llama_index.llms.anthropic import Anthropic  # noqa: PLC0415
        except ImportError as e:  # pragma: no cover - dep siempre presente en el stack base
            raise RuntimeError("llama_index_anthropic_not_installed") from e
        return Anthropic(model=model, api_key=s.anthropic_api_key)

    if tier is llm_tier.local:
        try:
            from llama_index.llms.ollama import Ollama  # noqa: PLC0415
        except ImportError as e:  # pragma: no cover
            raise RuntimeError("llama_index_ollama_not_installed") from e
        concrete_model = ollama_model or "llama3.1:8b"
        return Ollama(
            model=concrete_model,
            base_url=s.ollama_base_url,
            request_timeout=30.0,
        )

    raise RuntimeError(f"unknown_tier:{tier}")


# ---------- budget tracker ----------


@dataclass(slots=True)
class _usage:
    input_tokens: int = 0
    output_tokens: int = 0
    usd_spent: float = 0.0


@dataclass(slots=True)
class budget_tracker:
    """Contador de consumo por sesión con umbral de downgrade.

    No es thread-safe; usar un `asyncio.Lock` por sesión si se comparte entre tareas.
    """

    session_id: str
    budget_usd: float
    current_tier: llm_tier = llm_tier.opus
    usage: _usage = field(default_factory=_usage)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def record(self, *, input_tokens: int, output_tokens: int) -> None:
        """Suma tokens y costo. Dispara downgrade si el próximo paso excedería el presupuesto."""
        price_in, price_out = _PRICING[self.current_tier]
        delta_usd = (input_tokens * price_in + output_tokens * price_out) / 1_000_000.0
        async with self._lock:
            self.usage.input_tokens += input_tokens
            self.usage.output_tokens += output_tokens
            self.usage.usd_spent += delta_usd
        _log.info(
            "llm_usage_recorded",
            session_id=self.session_id,
            tier=self.current_tier.value,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            delta_usd=round(delta_usd, 6),
            total_usd=round(self.usage.usd_spent, 6),
        )

    async def should_downgrade(self, projected_input: int = 0, projected_output: int = 0) -> bool:
        """¿El próximo request previsto excedería el presupuesto?"""
        price_in, price_out = _PRICING[self.current_tier]
        projected = (
            self.usage.usd_spent
            + (projected_input * price_in + projected_output * price_out) / 1_000_000.0
        )
        return projected > self.budget_usd

    async def step_down(self) -> llm_tier | None:
        """Aplica un downgrade (si hay camino) y retorna el nuevo tier (o None)."""
        nxt = downgrade(self.current_tier)
        if nxt is None:
            _log.warning(
                "llm_budget_exhausted_no_downgrade",
                session_id=self.session_id,
                tier=self.current_tier.value,
                usd_spent=round(self.usage.usd_spent, 6),
                budget=self.budget_usd,
            )
            return None
        _log.info(
            "llm_tier_downgrade",
            session_id=self.session_id,
            from_=self.current_tier.value,
            to=nxt.value,
            usd_spent=round(self.usage.usd_spent, 6),
            budget=self.budget_usd,
        )
        self.current_tier = nxt
        return nxt


def new_budget_tracker(session_id: str, budget_usd: float | None = None) -> budget_tracker:
    """Crea tracker con el presupuesto de `SESSION_USD_BUDGET` si no se especifica uno."""
    s = get_settings()
    return budget_tracker(
        session_id=session_id,
        budget_usd=budget_usd if budget_usd is not None else s.session_usd_budget,
    )


# ---------- helpers para otros servicios ----------


def pricing_for(tier: llm_tier) -> tuple[float, float]:
    """Expuesto para summarizer/rag: estima coste antes de disparar la request."""
    return _PRICING[tier]


def estimate_cost_usd(tier: llm_tier, input_tokens: int, output_tokens: int) -> float:
    price_in, price_out = _PRICING[tier]
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000.0


__all__ = [
    "budget_tracker",
    "build_llm",
    "downgrade",
    "estimate_cost_usd",
    "llm_tier",
    "new_budget_tracker",
    "pricing_for",
    "resolve_model",
]
