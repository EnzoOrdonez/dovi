"""DOVI FastAPI entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import dashboard, frame, ingest, query
from app.core.config import get_settings
from app.services.vector_store import ensure_collection
from app.telemetry.logging import configure_logging

# Raíz de estáticos del dashboard — sirve `dashboard/index.html` y assets.
# Ruta relativa al workspace, no al paquete, porque el dashboard vive fuera del
# paquete `app/` para poder iterar independiente (Hito 3).
_DASHBOARD_DIR = Path(__file__).resolve().parents[2] / "dashboard"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    log = structlog.get_logger()
    log.info("dovi_startup", version="0.0.1")

    try:
        ensure_collection()
    except Exception as e:
        log.warning("qdrant_not_ready", error=str(e))

    yield

    log.info("dovi_shutdown")


def build_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="DOVI", version="0.0.1", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in s.api_cors_origins.split(",")],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-DOVI-Token"],
    )

    app.include_router(ingest.router)
    app.include_router(query.router)
    app.include_router(frame.router)
    app.include_router(dashboard.router)

    # Dashboard estático. Montado bajo `/dashboard/` sólo si el directorio existe;
    # así el backend sigue arrancable en despliegues sin dashboard (modo headless).
    if _DASHBOARD_DIR.is_dir():
        app.mount(
            "/dashboard",
            StaticFiles(directory=str(_DASHBOARD_DIR), html=True),
            name="dashboard",
        )

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "version": "0.0.1"}

    return app


app = build_app()
