// Hybrid Router (plan §3.4): decide si la inferencia corre en Ollama local o FastAPI remoto.
//
// Reglas:
//   · Gate: `chrome.storage.local.enable_local_slm === true` (opt-in explícito, plan §4.5).
//   · Probe silencioso: fetch a `http://127.0.0.1:{port}/api/tags` con `AbortSignal.timeout(500)`.
//     Los fallos (connection refused, timeout) se ignoran — no se loggea en rojo para no alarmar
//     al usuario cuando Ollama no está corriendo (comportamiento esperado en la mayoría de
//     instalaciones).
//   · Validación del modelo: el modelo "más grande" de la respuesta debe tener >=7B parámetros.
//     Parseamos `details.parameter_size` ("8B", "7.5B", "70B"). Fallback: regex sobre `name`
//     ("llama3:8b", "qwen2.5-7b-instruct").
//   · Cache: TTL 1h sobre el resultado de la decisión.
//
// Nota de Chromium: el `fetch` a localhost cuando no hay listener emite un `net::ERR_` visible
// en DevTools Network panel (no en JS console). Esto es un comportamiento del navegador no
// suprimible desde extensión. Aceptado como tradeoff.

import { config } from "@/shared/config";

export type routing_decision = "local" | "remote";

export interface probe_cache_entry {
  decision: routing_decision;
  model_detected: string | null;
  params_billions: number;
  cached_at_ms: number;
}

interface ollama_model_entry {
  name?: string;
  details?: {
    parameter_size?: string;
    family?: string;
  };
}

interface ollama_tags_response {
  models?: ollama_model_entry[];
}

interface probe_result {
  ok: boolean;
  largest_model: string | null;
  largest_params_b: number;
}

// ---------- cache ----------

const CACHE_TTL_MS = 60 * 60 * 1000;
const MIN_PARAMS_BILLIONS = 7;
let probe_cache: probe_cache_entry | null = null;

// ---------- parsing de tamaño ----------

function parse_billions(raw: string | undefined): number {
  if (!raw) return 0;
  const m = /(\d+(?:\.\d+)?)\s*([bB])/.exec(raw);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]!);
  return Number.isFinite(n) ? n : 0;
}

function extract_params_billions(model: ollama_model_entry): number {
  // Preferimos `details.parameter_size` (structured). Fallback al sufijo del name.
  const from_details = parse_billions(model.details?.parameter_size);
  if (from_details > 0) return from_details;
  const name = model.name ?? "";
  // Coincide con ":8b", "-7b", "_70b" etc. al final del tag.
  const tail = /[-_:](\d+(?:\.\d+)?)b(?:[-_]|$)/i.exec(name);
  if (tail) {
    const n = Number.parseFloat(tail[1]!);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

// ---------- probe ----------

async function probe_ollama_at(port: number): Promise<probe_result> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tags`, {
      signal: AbortSignal.timeout(config.local_slm_probe_timeout_ms),
    });
    if (!response.ok) return { ok: false, largest_model: null, largest_params_b: 0 };
    const body = (await response.json()) as ollama_tags_response;
    const models = body.models ?? [];
    let best_name: string | null = null;
    let best_b = 0;
    for (const m of models) {
      const b = extract_params_billions(m);
      if (b > best_b) {
        best_b = b;
        best_name = m.name ?? null;
      }
    }
    return { ok: true, largest_model: best_name, largest_params_b: best_b };
  } catch {
    // Silencioso: connection refused (Ollama off), timeout, CORS, etc.
    return { ok: false, largest_model: null, largest_params_b: 0 };
  }
}

// ---------- opt-in flag ----------

async function read_opt_in_flag(): Promise<boolean> {
  const result = await chrome.storage.local.get("enable_local_slm");
  return result.enable_local_slm === true;
}

// ---------- API pública ----------

export async function resolve_routing(): Promise<probe_cache_entry> {
  const now = Date.now();
  if (probe_cache && now - probe_cache.cached_at_ms < CACHE_TTL_MS) {
    return probe_cache;
  }

  const enable_local = await read_opt_in_flag();
  if (!enable_local) {
    probe_cache = {
      decision: "remote",
      model_detected: null,
      params_billions: 0,
      cached_at_ms: now,
    };
    return probe_cache;
  }

  for (const port of config.local_slm_ports) {
    const result = await probe_ollama_at(port);
    if (
      result.ok &&
      result.largest_model !== null &&
      result.largest_params_b >= MIN_PARAMS_BILLIONS
    ) {
      probe_cache = {
        decision: "local",
        model_detected: result.largest_model,
        params_billions: result.largest_params_b,
        cached_at_ms: now,
      };
      return probe_cache;
    }
  }

  probe_cache = {
    decision: "remote",
    model_detected: null,
    params_billions: 0,
    cached_at_ms: now,
  };
  return probe_cache;
}

export function invalidate_routing_cache(): void {
  // Llamable desde la UI si el usuario cambia el toggle `enable_local_slm` y queremos
  // re-evaluar sin esperar al TTL.
  probe_cache = null;
}

// Exportado para tests unitarios.
export const __internals = { parse_billions, extract_params_billions };
