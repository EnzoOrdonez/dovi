# DOVI

Extracción y análisis RAG sobre video embebido en páginas web — sin descargar el video completo.

Filosofía rectora: **Caveman** — atacar la capa de texto/audio de menor costo computacional,
evitar procesamiento innecesario. Single-tenant, self-hosted.

---

## Componentes

| Artefacto | Descripción |
|-----------|-------------|
| `extension/` | Chrome MV3. Intercepción DOM/red/audio, UI (Preact), persistencia local LRU+TTL (Dexie.js). |
| `backend/`   | FastAPI + LlamaIndex. Orquestación RAG asíncrona, ASR (faster-whisper), Qdrant Float32. |

---

## Arquitectura y flujo de datos

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Navegador del usuario                                                  │
│                                                                         │
│  Pestaña VOD (YouTube / Moodle / Zoom / Loom / Vimeo / …)              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Content Script (all_frames: true)                                 │  │
│  │  · Nivel 0 — MutationObserver → cues DOM                         │  │
│  │  · Nivel 1 — webRequest intercept → VTT/SRT parsing              │  │
│  │  · Nivel 2 — tabCapture (fallback; opt-in + disclaimer)           │  │
│  │  · player_controller — video.currentTime + seek injection         │  │
│  └───────────────────┬───────────────────────────────────────────────┘  │
│                      │ chrome.runtime.sendMessage                       │
│  ┌───────────────────▼───────────────────────────────────────────────┐  │
│  │ Service Worker MV3                                                │  │
│  │  · session registry  (tab_id → session_id)                       │  │
│  │  · POST /ingest/cues  →  backend (Niveles 0/1)                   │  │
│  │  · POST /ingest/audio →  backend (Nivel 2 via Offscreen)         │  │
│  │  · open_query_stream  →  Offscreen SSE client                    │  │
│  │  · hybrid_router      →  probe Ollama:11434 (opt-in)             │  │
│  └───────┬───────────────────────────────────────────┬───────────────┘  │
│          │                                           │                  │
│  ┌───────▼──────────┐                   ┌───────────▼───────────────┐  │
│  │ Offscreen Doc.   │                   │ Side Panel (Preact)        │  │
│  │  · MediaRecorder │                   │  · ChatView  (SSE tokens) │  │
│  │  · SSE client    │──── sse_event ───►│  · SettingsView (Ollama)  │  │
│  └──────────────────┘  runtime broadcast└───────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTPS
                    ┌────────────▼────────────────────────────────────┐
                    │  Backend FastAPI                                 │
                    │                                                  │
                    │  POST /ingest/cues   → chunk → embed → Qdrant   │
                    │  POST /ingest/audio  → ASR → chunk → embed      │
                    │  POST /query         → retrieve → LLM → SSE ──► │
                    │                                                  │
                    │  ┌──────────┐  ┌────────────┐  ┌─────────────┐ │
                    │  │ Qdrant   │  │   Redis    │  │  Anthropic  │ │
                    │  │ Float32  │  │  (queue)   │  │  / Ollama   │ │
                    │  └──────────┘  └────────────┘  └─────────────┘ │
                    └─────────────────────────────────────────────────┘
```

### Extracción escalonada

| Nivel | Trigger | Mecanismo |
|-------|---------|-----------|
| 0 | Siempre | `MutationObserver` sobre paneles de transcripción DOM |
| 1 | Si Nivel 0 < 3 cues en 15 s | `webRequest` → parse VTT/SRT |
| 2 | Si Nivel 1 falla | `MediaRecorder` sobre `tabCapture` (audio post-DRM) |

### Pipeline RAG

```
Pregunta usuario
  → embed_query (BGE-M3 1024d)
  → retrieve (Qdrant, filtro session_id + embedding_model)
  → si 0 chunks → SSE event="error" data="Video_Not_Indexed"  ← no llama al LLM
  → build prompt con refs [[ts:HH:MM:SS.mmm|chunk_id:…]]
  → LLM stream (claude-opus-4-6 / haiku / Ollama según budget y opt-in)
  → SSE event="token" por cada delta
  → validación anti-alucinación post-stream (log-only)
  → SSE event="done"
```

### Enrutamiento híbrido (opt-in)

```
enable_local_slm = true  →  probe http://127.0.0.1:11434/api/tags (timeout 500ms)
  ├── Ollama ≥7B detectado  →  routing_decision="local"  (cero datos al backend)
  └── Sin modelo / timeout  →  routing_decision="remote" (Claude API)
```

---

## Setup rápido

### Prerrequisitos

- Docker + Docker Compose (para Qdrant, Redis y backend)
- Node.js ≥20 + pnpm (para compilar la extensión)
- Python ≥3.12 + [uv](https://github.com/astral-sh/uv) (gestión de dependencias Python)

### 1. Variables de entorno

```bash
cp .env.example .env
# Edita .env — valores mínimos:
#   DOVI_API_KEY=<token-local-secreto>
#   ANTHROPIC_API_KEY=<sk-ant-...>
```

### 2. Backend + servicios

```bash
make up          # docker-compose up -d (Qdrant + Redis + backend)
make logs        # seguir logs del backend
```

O en modo desarrollo local (sin Docker):

```bash
cd backend
uv sync                           # deps base
uv sync --extra embeddings        # BGE-M3 (requiere ~1 GB de modelos)
uv run uvicorn app.main:app --reload --port 8000
```

### 3. Extensión Chrome

```bash
make build-extension   # pnpm install + tsc + vite build → extension/dist/
# En Chrome: chrome://extensions → "Cargar sin empaquetar" → seleccionar extension/dist/
```

### 4. Verificación

```bash
curl -s http://localhost:8000/health
# → {"status":"ok","version":"0.1.0"}

curl -s -X POST http://localhost:8000/ingest/cues \
  -H "X-DOVI-Token: $DOVI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test","video_id":"v1","platform":"generic","cues":[]}'
# → {"accepted":0,"session_id":"test"}
```

---

## Tests

```bash
cd backend
uv run pytest               # suite completa
uv run pytest -x -q         # fail-fast
uv run ruff check .         # linting
uv run ruff format --check .
```

Tests incluidos:

| Archivo | Cubre |
|---------|-------|
| `tests/test_smoke.py` | Health check, auth 401/200 |
| `tests/test_chunker.py` | Chunker: speaker boundary, overlap, IDs estables |
| `tests/test_query.py` | SSE endpoint: 401, Video_Not_Indexed, happy path, error LLM |

---

## Comandos Make

```
make up              # docker-compose up -d
make down            # docker-compose down
make logs            # logs backend
make install         # uv sync (backend) + pnpm install (extensión)
make build-extension # compilar extensión → extension/dist/
make test            # pytest + ruff
make lint            # ruff check + format check
```

---

## Disclaimer legal

El **Nivel 2** (MediaRecorder sobre `tabCapture`) captura el audio renderizado
localmente en la pestaña, **incluyendo audio protegido con DRM** decodificado en
userspace por el navegador. El uso sobre sesiones privadas (Zoom, Meet, Webex)
puede violar los ToS de la plataforma y/o leyes de grabación de dos partes
(two-party consent) vigentes en tu jurisdicción. **Responsabilidad exclusiva del
usuario final.** DOVI muestra un modal de consentimiento antes de activar el
Nivel 2; el usuario debe confirmar haber revisado la legalidad local.
