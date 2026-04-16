# DOVI — dev targets.
.PHONY: help dev up down logs test test-backend test-extension lint fmt build-extension install clean

help:
	@echo "DOVI — targets disponibles:"
	@echo "  make install         - Instala deps backend (uv) y extension (pnpm)"
	@echo "  make up              - Levanta Qdrant + Redis + backend + worker"
	@echo "  make down            - Detiene stack docker"
	@echo "  make logs            - Tail logs del backend"
	@echo "  make dev             - Backend en modo reload (fuera de docker)"
	@echo "  make test            - Todos los tests"
	@echo "  make test-backend    - pytest"
	@echo "  make test-extension  - vitest"
	@echo "  make lint            - ruff + tsc"
	@echo "  make fmt             - ruff format + prettier"
	@echo "  make build-extension - Build producción MV3"
	@echo "  make clean           - Limpia artefactos"

install:
	cd backend && uv sync --extra dev
	cd extension && pnpm install

install-ml:
	cd backend && uv sync --extra dev --extra asr --extra embeddings

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f backend worker

dev:
	cd backend && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

test: test-backend test-extension

test-backend:
	cd backend && uv run pytest -q

test-extension:
	cd extension && pnpm vitest run

lint:
	cd backend && uv run ruff check .
	cd extension && pnpm tsc --noEmit

fmt:
	cd backend && uv run ruff format .
	cd extension && pnpm prettier --write "src/**/*.{ts,tsx,html,css}"

build-extension:
	cd extension && pnpm build

clean:
	rm -rf backend/.pytest_cache backend/.ruff_cache backend/.venv
	rm -rf extension/node_modules extension/dist
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
