// Tipos compartidos entre content script, service worker y offscreen.
// Nomenclatura: snake_case para campos de datos (cross-stack coherencia con backend Pydantic).

export type source_level = 0 | 1 | 2;

export interface cue {
  t_start_ms: number;
  t_end_ms: number;
  speaker: string | null;
  text: string;
  source_level: source_level;
}

export interface session_handle {
  session_id: string;
  video_id: string;
  platform: string;
  tab_id: number;
  frame_id: number;
  started_at_ms: number;
}

// Manifest cache mantenida por el webRequest listener (Nivel 1).
// Consumida JIT cuando el backend pide `manifest_request` via SSE.
export interface manifest_snapshot {
  url: string;
  cookies: string;
  request_headers: Record<string, string>;
  captured_at_ms: number;
}

// Payload de audio Nivel 2. El offset absoluto es crítico (plan §2.4.1).
export interface audio_blob_payload {
  session_id: string;
  run_id: string;
  chunk_index: number;
  absolute_start_offset_ms: number;
  audio: Blob;
}

// Mensajes internos SW <-> content script <-> offscreen.
export type internal_message =
  | { type: "cues_extracted"; session_id: string; cues: cue[] }
  | { type: "manifest_captured"; session_id: string; manifest: manifest_snapshot }
  // Nivel 2 arranca con el content enviando `{session_id, absolute_start_offset_ms}`; el SW
  // inyecta `tab_id` (desde sender.tab.id) y `stream_id` (vía chrome.tabCapture) antes de
  // reenviar el mensaje al offscreen. Ambos campos optional para tipar ambos puntos del flujo.
  | { type: "start_recording"; session_id: string; tab_id?: number; absolute_start_offset_ms: number; stream_id?: string }
  | { type: "stop_recording"; session_id: string }
  | { type: "pause_recording"; session_id: string }
  | { type: "resume_recording"; session_id: string }
  | { type: "recording_chunk"; payload: audio_blob_payload }
  | { type: "seek_request"; session_id: string; t_start_ms: number }
  // Content → SW: fallback cuando el seek ISOLATED falla (propiedad no-escribible, wrapper custom).
  | { type: "main_world_seek"; session_id: string; t_start_ms: number }
  // SW → content: pedir fetch con credenciales del tab para un recurso VTT/JSON (plan §2.3).
  // El content responde vía `cues_extracted` normal.
  | { type: "fetch_vtt_url"; session_id: string; url: string }
  // Offscreen → SW: SSE event parseado del backend (tokens, frame, done, manifest_request).
  | { type: "sse_event"; session_id: string; event: string; data: string }
  // SW → offscreen: arrancar/parar canal SSE contra /query del backend.
  | { type: "sse_open"; session_id: string; url: string; body: string; token: string }
  | { type: "sse_close"; session_id: string }
  | { type: "abort"; session_id: string; reason: string }
  // UI → SW: dispara inferencia RAG sobre la sesión activa. El SW resuelve `session_id` desde
  // el tab activo y delega en `open_query_stream` (offscreen SSE).
  | { type: "query_request"; question: string }
  // UI → SW: cancela el stream SSE activo para la sesión. SW reenvía `sse_close` al offscreen.
  | { type: "query_cancel"; session_id: string }
  // UI → SW: consulta el `session_id` vinculado al tab activo (null si no hay).
  | { type: "get_tab_session" };
