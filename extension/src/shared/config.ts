// Config estática compartida. Valores dinámicos viven en chrome.storage.
// Defaults alineados con el plan §Stack.

export const config = {
  // Backend endpoint. Override vía popup settings → chrome.storage.local:"backend_url".
  backend_url_default: "http://localhost:8000",

  // Local SLM probe (opt-in).
  local_slm_ports: [11434, 1234, 8080] as const,
  local_slm_probe_timeout_ms: 500,

  // Nivel 2 trigger: requiere ≥N cues en T segundos (plan §2.4).
  level_2_min_cues: 3,
  level_2_timeout_seconds: 15,

  // MediaRecorder (plan §2.4).
  recorder_mime_type: "audio/webm;codecs=opus",
  recorder_bits_per_second: 24000,
  recorder_sample_rate_hz: 16000,
  recorder_chunk_interval_ms: 30_000,

  // Límite hard: máximo de runs por sesión (plan §4.22 — protección contra scrubbing DoS).
  max_recording_runs_per_session: 20,

  // IndexedDB eviction (plan §3.6).
  eviction_check_interval_seconds: 60,
  eviction_ttl_hours: 72,
  eviction_quota_trigger: 0.85,
  eviction_quota_target: 0.6,

  // SSE roundtrip timeout (plan §3.3).
  manifest_reply_timeout_ms: 3000,
} as const;
