// Nivel 1 (plan §2.3 + §4.16): intercepción de red para .vtt/.srt/.json + manifest HLS/DASH.
//
// Limitación MV3: `chrome.webRequest` en MV3 es OBSERVACIONAL. No hay `webRequestBlocking`
// ni acceso al cuerpo de la respuesta. Patrones aplicados:
//
//   1. URL + headers → vía `onBeforeRequest` (URL) y `onSendHeaders` (req headers) correlacionados
//      por `requestId`.
//   2. Cookies del dominio → vía `chrome.cookies.getAll(...)` en el momento de captura,
//      NO persistidas (plan §4.10 — JIT only).
//   3. Cuerpo del VTT/JSON → delegamos al content script del tab con `chrome.tabs.sendMessage`
//      (`fetch_vtt_url`). Esto reutiliza las credenciales de sesión del usuario en first-party
//      sin exponerlas al backend. El content hace `fetch(url, {credentials:"include"})` y
//      emite los cues parseados por el canal estándar `cues_extracted`.
//   4. Fallback (NO implementado por defecto): `chrome.debugger.attach` para tabs con opt-in
//      explícito del usuario (plan §4.16). Queda como TODO bajo un flag de settings.
//
// Manifest HLS/DASH: cacheado en memoria por tab. El backend lo pide JIT vía SSE (plan §3.3);
// el correlador en service_worker.ts lee esta cache y hace POST /session/.../manifest_reply.

import type { internal_message, manifest_snapshot } from "@/shared/types";

// ---------- caches en memoria ----------

// Último manifest visto por tab — consumido JIT por el correlador de manifest_request.
const latest_manifest_by_tab = new Map<number, manifest_snapshot>();

// Headers de request en vuelo, indexados por requestId. Se vacían al resolver/err.
const in_flight_headers = new Map<string, Record<string, string>>();

// Dedupe de VTT URLs ya delegadas al content, por (tab_id, url). Evita fetch repetido
// cuando la misma respuesta llega por onResponseStarted + onCompleted.
const dispatched_vtt = new Set<string>();

// ---------- patrones de detección ----------

const VTT_PATTERN = /\.(vtt|srt)(\?|$)|\/captions?\/|\/transcripts?\/|\/api\/.*subtitle/i;
const MANIFEST_PATTERN = /\.(m3u8|mpd)(\?|$)/i;
const JSON_TRANSCRIPT_HINT = /transcript|caption|subtitle/i;

// ---------- helpers ----------

function headers_array_to_record(
  headers: chrome.webRequest.HttpHeader[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const h of headers) {
    if (h.name && typeof h.value === "string") {
      out[h.name] = h.value;
    }
  }
  return out;
}

async function collect_cookies_for_url(url: string): Promise<string> {
  // chrome.cookies.getAll requiere el permiso `cookies` o host_permissions; ya tenemos <all_urls>.
  try {
    const parsed = new URL(url);
    const cookies = await chrome.cookies.getAll({ url: parsed.toString() });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (err) {
    console.warn("[DOVI] cookies.getAll failed", err);
    return "";
  }
}

function best_session_id_for_tab(tab_id: number): string | null {
  // Obtener el session_id activo requiere un mapa `tab_id → session_id` que mantiene
  // service_worker.ts al recibir `cues_extracted`. Para evitar dependencia circular, el
  // SW inyecta el lookup vía setter.
  return session_id_lookup?.(tab_id) ?? null;
}

let session_id_lookup: ((tab_id: number) => string | null) | null = null;

export function register_session_lookup(fn: (tab_id: number) => string | null): void {
  session_id_lookup = fn;
}

function dispatch_vtt_to_content(tab_id: number, url: string, frame_id: number): void {
  const key = `${tab_id}:${url}`;
  if (dispatched_vtt.has(key)) return;
  dispatched_vtt.add(key);
  const session_id = best_session_id_for_tab(tab_id);
  if (!session_id) {
    // Sin sesión registrada no tiene sentido fetch-ear: el body no se va a enrutar a ningún lado.
    console.debug("[DOVI] vtt detected without active session; skip", { url });
    return;
  }
  const msg: internal_message = { type: "fetch_vtt_url", session_id, url };
  chrome.tabs
    .sendMessage(tab_id, msg, { frameId: frame_id })
    .catch((err) => {
      // El content puede no estar listo aún: dejamos que el siguiente evento (onCompleted) reintente.
      console.debug("[DOVI] fetch_vtt_url dispatch failed", { url, err: String(err) });
      dispatched_vtt.delete(key);
    });
}

interface capture_context {
  url: string;
  tab_id: number;
  request_id: string;
}

async function capture_manifest(c: capture_context): Promise<void> {
  const headers = in_flight_headers.get(c.request_id) ?? {};
  const cookies = await collect_cookies_for_url(c.url);
  const snap: manifest_snapshot = {
    url: c.url,
    cookies,
    request_headers: headers,
    captured_at_ms: Date.now(),
  };
  latest_manifest_by_tab.set(c.tab_id, snap);

  const session_id = best_session_id_for_tab(c.tab_id);
  if (session_id) {
    const msg: internal_message = { type: "manifest_captured", session_id, manifest: snap };
    chrome.runtime.sendMessage(msg).catch(() => {
      /* SW sleeping, se rehidratará — la cache en memoria ya está actualizada */
    });
  }
}

// ---------- setup ----------

export function setup_web_request_listener(): void {
  // onSendHeaders: capturamos request headers (Authorization, Referer, etc.) asociados al requestId.
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!MANIFEST_PATTERN.test(details.url) && !VTT_PATTERN.test(details.url)) return;
      in_flight_headers.set(details.requestId, headers_array_to_record(details.requestHeaders));
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders", "extraHeaders"],
  );

  // onResponseStarted: sabemos que el servidor respondió. Momento adecuado para delegar al content
  // (idealmente body ya disponible). Headers de respuesta son informativos aquí.
  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      if (details.tabId < 0) return;

      // Manifest HLS/DASH: cachear snapshot completo (URL + headers + cookies).
      if (MANIFEST_PATTERN.test(details.url)) {
        void capture_manifest({
          url: details.url,
          tab_id: details.tabId,
          request_id: details.requestId,
        });
        return;
      }

      // VTT/SRT: delegar al content para fetch con credentials.
      if (VTT_PATTERN.test(details.url)) {
        dispatch_vtt_to_content(details.tabId, details.url, details.frameId);
        return;
      }

      // JSON con pinta de transcript: sólo si MIME es JSON y URL tiene hint semántico.
      // Evitamos disparar fetch-es redundantes sobre /api/* generales.
      const content_type =
        details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
      if (content_type.includes("application/json") && JSON_TRANSCRIPT_HINT.test(details.url)) {
        dispatch_vtt_to_content(details.tabId, details.url, details.frameId);
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders", "extraHeaders"],
  );

  // onCompleted / onErrorOccurred: limpieza de in_flight_headers.
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      in_flight_headers.delete(details.requestId);
    },
    { urls: ["<all_urls>"] },
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      in_flight_headers.delete(details.requestId);
    },
    { urls: ["<all_urls>"] },
  );

  // Limpieza de dispatched_vtt cuando un tab se cierra (evita leaks de la Set).
  chrome.tabs.onRemoved.addListener((tab_id) => {
    latest_manifest_by_tab.delete(tab_id);
    for (const key of dispatched_vtt) {
      if (key.startsWith(`${tab_id}:`)) dispatched_vtt.delete(key);
    }
  });
}

// ---------- API pública consumida por service_worker.ts ----------

export function get_latest_manifest(tab_id: number): manifest_snapshot | null {
  return latest_manifest_by_tab.get(tab_id) ?? null;
}

export function clear_manifest(tab_id: number): void {
  latest_manifest_by_tab.delete(tab_id);
}
