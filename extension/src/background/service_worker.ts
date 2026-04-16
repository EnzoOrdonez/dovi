// Service Worker MV3 — orquestador central.
//
// Decisiones arquitectónicas clave:
//
// 1. Ciclo de vida MV3 (plan §4.1). El SW es terminado tras ~30s idle. Estrategia:
//    - Estado mínimo in-memory (mapas pequeños). La autoridad vive en:
//        · chrome.storage.session (`tab_id → session_id`) — survives SW restart (misma pestaña).
//        · IndexedDB (chunks persistentes).
//        · offscreen document (conexiones long-lived: MediaRecorder, SSE).
//    - Rehidratación en `onStartup` + primer `onMessage`.
//
// 2. SSE del backend: el `EventSource` nativo dentro del SW se muere con él. Delegamos
//    la conexión al offscreen document (sobrevive mientras tenga una razón activa).
//    El offscreen emite `sse_event` al SW vía runtime.sendMessage; el SW broadcast-ea
//    a la UI (popup/sidepanel) vía `chrome.runtime.sendMessage` genérico.
//
// 3. Offscreen idempotente: `ensure_offscreen_document()` usa `chrome.runtime.getContexts`
//    (API moderna) como primary check; fallback a try/catch sobre `createDocument`.
//    Las razones son la unión de los motivos activos simultáneos:
//      - `USER_MEDIA`: para MediaRecorder de Nivel 2.
//      - `WORKERS`: para la conexión SSE long-lived (reason honesta).
//
// 4. Alarms: `dovi_eviction` (Dexie) @60s, `dovi_heartbeat` (no-op que despierta el SW) @30s
//    — el mínimo permitido por MV3 para alarms periódicos.

import { setup_web_request_listener, register_session_lookup } from "./web_request";
import { config } from "@/shared/config";
import type { audio_blob_payload, cue, internal_message } from "@/shared/types";
import { apply_eviction_policy, db, touch_session, upsert_session } from "@/storage/dexie_schema";

// ---------- state in-memory (re-hidratado desde chrome.storage.session) ----------

const tab_to_session = new Map<number, string>();
const session_to_tab = new Map<string, number>();

async function load_session_map(): Promise<void> {
  try {
    const raw = await chrome.storage.session.get("tab_session_map");
    const map = raw.tab_session_map as Record<string, string> | undefined;
    if (!map) return;
    for (const [t, s] of Object.entries(map)) {
      const tab_id = Number.parseInt(t, 10);
      if (!Number.isFinite(tab_id)) continue;
      tab_to_session.set(tab_id, s);
      session_to_tab.set(s, tab_id);
    }
  } catch (err) {
    console.warn("[DOVI] load_session_map failed", err);
  }
}

async function persist_session_map(): Promise<void> {
  const obj: Record<string, string> = {};
  for (const [t, s] of tab_to_session) obj[String(t)] = s;
  try {
    await chrome.storage.session.set({ tab_session_map: obj });
  } catch (err) {
    console.warn("[DOVI] persist_session_map failed", err);
  }
}

function register_tab_session(tab_id: number, session_id: string): void {
  const prev = tab_to_session.get(tab_id);
  if (prev === session_id) return;
  if (prev) session_to_tab.delete(prev);
  tab_to_session.set(tab_id, session_id);
  session_to_tab.set(session_id, tab_id);
  void persist_session_map();
}

function clear_tab_session(tab_id: number): void {
  const s = tab_to_session.get(tab_id);
  if (!s) return;
  tab_to_session.delete(tab_id);
  session_to_tab.delete(s);
  void persist_session_map();
}

// Inyección en web_request.ts (evita dependencia circular).
register_session_lookup((tab_id) => tab_to_session.get(tab_id) ?? null);

// ---------- backend URL + token ----------

interface backend_config {
  url: string;
  token: string;
}

async function get_backend_config(): Promise<backend_config> {
  const raw = await chrome.storage.local.get(["backend_url", "backend_token"]);
  return {
    url: typeof raw.backend_url === "string" ? raw.backend_url : config.backend_url_default,
    token: typeof raw.backend_token === "string" ? raw.backend_token : "",
  };
}

// ---------- offscreen lifecycle ----------

const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

async function has_offscreen_document(): Promise<boolean> {
  // getContexts fue añadida en Chrome 116; el manifest ya exige minimum 116.
  const ctx = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [OFFSCREEN_URL],
  });
  return ctx.length > 0;
}

async function ensure_offscreen_document(
  reasons: chrome.offscreen.Reason[],
  justification: string,
): Promise<void> {
  if (await has_offscreen_document()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons,
      justification,
    });
  } catch (err) {
    // La API puede fallar con "Only a single offscreen document may be created" si
    // otra llamada paralela ganó la carrera. Re-check y asume OK.
    if (!(await has_offscreen_document())) throw err;
    void err;
  }
}

// ---------- Nivel 2: orquestación de grabación ----------

async function handle_start_recording(
  session_id: string,
  tab_id: number,
  absolute_start_offset_ms: number,
): Promise<void> {
  // tabCapture requiere user gesture reciente; el content script ya filtra eso porque
  // el trigger nace de un evento de usuario (play/click).
  const stream_id = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab_id }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(id);
    });
  });

  await ensure_offscreen_document(OFFSCREEN_REASONS, OFFSCREEN_JUSTIFICATION);

  const msg: internal_message = {
    type: "start_recording",
    session_id,
    tab_id,
    absolute_start_offset_ms,
    stream_id,
  };
  await chrome.runtime.sendMessage(msg);
}

async function forward_to_offscreen(msg: internal_message): Promise<void> {
  if (!(await has_offscreen_document())) return;
  await chrome.runtime.sendMessage(msg).catch(() => {
    /* offscreen just died — best effort */
  });
}

// ---------- ingesta: cues y audio chunks → backend ----------

async function post_cues_to_backend(
  session_id: string,
  cues: cue[],
  tab_id: number,
): Promise<void> {
  const { url, token } = await get_backend_config();
  if (!token) {
    console.debug("[DOVI] skipping /ingest/cues — backend token not configured");
    return;
  }
  const platform = await platform_for_tab(tab_id);
  const body = {
    session_id,
    video_id: session_id, // MVP: 1 video por sesión; refinar en iteraciones futuras.
    platform,
    cues,
  };
  const resp = await fetch(`${url}/ingest/cues`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DOVI-Token": token },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.warn("[DOVI] /ingest/cues failed", resp.status);
  }
}

async function platform_for_tab(tab_id: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tab_id);
    if (!tab.url) return "generic";
    const hostname = new URL(tab.url).hostname;
    // Import perezoso para no cargar adapters en el import-top del SW (cold start).
    const mod = await import("@/platforms/registry");
    return mod.resolve_adapter(hostname).name;
  } catch {
    return "generic";
  }
}

async function post_audio_chunk_to_backend(payload: audio_blob_payload): Promise<void> {
  const { url, token } = await get_backend_config();
  if (!token) return;
  const form = new FormData();
  form.append("session_id", payload.session_id);
  form.append("run_id", payload.run_id);
  form.append("chunk_index", String(payload.chunk_index));
  form.append("absolute_start_offset_ms", String(payload.absolute_start_offset_ms));
  form.append("audio", payload.audio, `chunk_${payload.chunk_index}.webm`);
  const resp = await fetch(`${url}/ingest/audio`, {
    method: "POST",
    headers: { "X-DOVI-Token": token },
    body: form,
  });
  if (!resp.ok) {
    console.warn("[DOVI] /ingest/audio failed", resp.status);
  }
}

// ---------- session bookkeeping en Dexie ----------

async function ensure_session_row(session_id: string, tab_id: number): Promise<void> {
  const existing = await db.session.get(session_id);
  if (existing) {
    await touch_session(session_id);
    return;
  }
  const platform = await platform_for_tab(tab_id);
  await upsert_session({
    session_id,
    video_id: session_id,
    platform,
    total_bytes: 0,
    created_at_ms: Date.now(),
    last_accessed_at_ms: Date.now(),
    pinned: false,
  });
}

// ---------- main_world_seek (plan §4.18) ----------

async function main_world_seek(tab_id: number, t_start_ms: number): Promise<boolean> {
  // MV3 `scripting.executeScript({world:"MAIN"})` bypassa CSP del sitio por diseño.
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab_id, allFrames: true },
      world: "MAIN",
      func: (ms: number) => {
        // La función corre en MAIN world: `deep` es un helper local sin dependencia externa.
        const deep = (root: Document | ShadowRoot): HTMLVideoElement | null => {
          const v = root.querySelector("video");
          if (v) return v as HTMLVideoElement;
          const shadows = root.querySelectorAll("*");
          for (const el of shadows) {
            const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
            if (sr) {
              const found = deep(sr);
              if (found) return found;
            }
          }
          return null;
        };
        const video = deep(document);
        if (!video) return false;
        try {
          video.currentTime = ms / 1000;
          void video.play();
          return true;
        } catch {
          return false;
        }
      },
      args: [t_start_ms],
    });
    return Boolean(result?.result);
  } catch (err) {
    console.warn("[DOVI] main_world_seek executeScript failed", err);
    return false;
  }
}

// ---------- bus central ----------

function dispatch(
  message: internal_message,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): boolean {
  const tab_id = sender.tab?.id;

  switch (message.type) {
    case "cues_extracted": {
      if (tab_id !== undefined) {
        register_tab_session(tab_id, message.session_id);
        void ensure_session_row(message.session_id, tab_id);
        void post_cues_to_backend(message.session_id, message.cues, tab_id).catch((e) =>
          console.warn("[DOVI] post_cues_to_backend", e),
        );
      }
      sendResponse({ ok: true });
      return false;
    }

    case "manifest_captured": {
      // web_request.ts ya actualizó la cache in-memory; no hay más acción aquí.
      sendResponse({ ok: true });
      return false;
    }

    case "start_recording": {
      if (tab_id === undefined) {
        sendResponse({ ok: false, error: "no_tab_id" });
        return false;
      }
      void handle_start_recording(
        message.session_id,
        tab_id,
        message.absolute_start_offset_ms,
      ).then(
        () => sendResponse({ ok: true }),
        (err: unknown) => {
          console.warn("[DOVI] start_recording failed", err);
          sendResponse({ ok: false, error: String(err) });
        },
      );
      return true;
    }

    case "stop_recording":
    case "pause_recording":
    case "resume_recording": {
      void forward_to_offscreen(message);
      sendResponse({ ok: true });
      return false;
    }

    case "recording_chunk": {
      void post_audio_chunk_to_backend(message.payload).catch((e) =>
        console.warn("[DOVI] post_audio_chunk_to_backend", e),
      );
      sendResponse({ ok: true });
      return false;
    }

    case "seek_request": {
      const target_tab = session_to_tab.get(message.session_id);
      if (target_tab !== undefined) {
        void chrome.tabs.sendMessage(target_tab, message).catch(() => {
          /* content script no está; se reintentará en el siguiente evento */
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    case "main_world_seek": {
      const target_tab = tab_id ?? session_to_tab.get(message.session_id);
      if (target_tab === undefined) {
        sendResponse({ ok: false, error: "no_tab" });
        return false;
      }
      void main_world_seek(target_tab, message.t_start_ms).then((ok) => sendResponse({ ok }));
      return true;
    }

    case "sse_event": {
      // El offscreen ya broadcast-eó `sse_event` vía `chrome.runtime.sendMessage`, que entrega
      // a TODOS los listeners del runtime (SW + popup + sidepanel). Re-broadcast-earlo aquí
      // dispararía la UI dos veces. El SW sólo acusa recibo (punto de observabilidad).
      sendResponse({ ok: true });
      return false;
    }

    case "query_request": {
      void handle_query_request(message.question).then(
        (result) => sendResponse(result),
        (err: unknown) => {
          console.warn("[DOVI] query_request failed", err);
          sendResponse({ ok: false, error: String(err) });
        },
      );
      return true;
    }

    case "query_cancel": {
      // Relay a offscreen para cerrar el fetch stream.
      void forward_to_offscreen({ type: "sse_close", session_id: message.session_id });
      sendResponse({ ok: true });
      return false;
    }

    case "get_tab_session": {
      void handle_get_tab_session().then(
        (result) => sendResponse(result),
        (err: unknown) => sendResponse({ ok: false, error: String(err) }),
      );
      return true;
    }

    case "abort": {
      if (tab_id !== undefined) clear_tab_session(tab_id);
      // Cierra offscreen SSE + recorder si los hubiera.
      void forward_to_offscreen({ type: "sse_close", session_id: message.session_id });
      void forward_to_offscreen({ type: "stop_recording", session_id: message.session_id });
      sendResponse({ ok: true });
      return false;
    }

    // Mensajes que el SW no debe recibir (son outbound hacia offscreen/content).
    case "fetch_vtt_url":
    case "sse_open":
    case "sse_close":
      sendResponse({ ok: true });
      return false;

    default: {
      const _exhaustive: never = message;
      void _exhaustive;
      sendResponse({ ok: false, error: "unknown_message" });
      return false;
    }
  }
}

chrome.runtime.onMessage.addListener((msg: internal_message, sender, sendResponse) => {
  return dispatch(msg, sender, sendResponse);
});

// ---------- SSE session kickoff ----------

// Razones unificadas: el offscreen aloja simultáneamente MediaRecorder (USER_MEDIA) y SSE
// (WORKERS). Crear con ambas razones evita el caso degenerado "primero sse → documento sin
// USER_MEDIA → recorder falla". Chrome mantiene el documento vivo mientras cualquiera de las
// razones esté activa, y no permite mutar reasons post-creación.
const OFFSCREEN_REASONS: chrome.offscreen.Reason[] = [
  chrome.offscreen.Reason.USER_MEDIA,
  chrome.offscreen.Reason.WORKERS,
];
const OFFSCREEN_JUSTIFICATION =
  "MediaRecorder para Nivel 2 + conexión SSE long-lived contra el backend DOVI";

export async function open_query_stream(
  session_id: string,
  question: string,
): Promise<void> {
  const { url, token } = await get_backend_config();
  await ensure_offscreen_document(OFFSCREEN_REASONS, OFFSCREEN_JUSTIFICATION);
  const msg: internal_message = {
    type: "sse_open",
    session_id,
    url: `${url}/query`,
    body: JSON.stringify({ session_id, question }),
    token,
  };
  await chrome.runtime.sendMessage(msg);
}

// ---------- handlers UI ↔ SW ----------

async function get_active_tab_id(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  return tab?.id ?? null;
}

async function handle_query_request(
  question: string,
): Promise<{ ok: boolean; session_id?: string; error?: string }> {
  const tab_id = await get_active_tab_id();
  if (tab_id === null) return { ok: false, error: "no_active_tab" };
  const session_id = tab_to_session.get(tab_id);
  if (!session_id) return { ok: false, error: "no_session_for_tab" };
  await open_query_stream(session_id, question);
  return { ok: true, session_id };
}

async function handle_get_tab_session(): Promise<{ ok: true; session_id: string | null }> {
  const tab_id = await get_active_tab_id();
  const session_id = tab_id !== null ? (tab_to_session.get(tab_id) ?? null) : null;
  return { ok: true, session_id };
}

// ---------- alarms ----------

function setup_alarms(): void {
  // Mínimo de MV3 para alarms periódicos es 30s.
  chrome.alarms.create("dovi_eviction", {
    periodInMinutes: config.eviction_check_interval_seconds / 60,
  });
  chrome.alarms.create("dovi_heartbeat", { periodInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dovi_eviction") {
    void apply_eviction_policy().catch((e) => console.warn("[DOVI] eviction", e));
  }
  // heartbeat: la propia invocación del listener despierta el SW; no hay acción.
});

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(() => {
  console.info("[DOVI] service worker installed");
  setup_alarms();
});

chrome.runtime.onStartup.addListener(() => {
  console.info("[DOVI] service worker startup");
  void load_session_map();
  setup_alarms();
});

chrome.tabs.onRemoved.addListener((tab_id) => {
  clear_tab_session(tab_id);
});

// Inicialización diferida (idempotente) — también cubre activaciones "on-demand" del SW.
void load_session_map();
setup_web_request_listener();

export {};
