// Offscreen Document — host de MediaRecorder (Nivel 2) + cliente SSE long-lived (plan §2.4,
// §2.4.1, §3.3, §4.1).
//
// Por qué offscreen:
//   - El Service Worker MV3 es terminado tras ~30s idle; tanto un MediaRecorder de 45 minutos
//     como un `fetch` streaming de duración abierta allí morirían. El offscreen sobrevive
//     mientras cualquier razón (`USER_MEDIA` / `WORKERS`) esté activa.
//
// Flujos:
//
// A) MediaRecorder (plan §2.4):
//   1. SW envía `start_recording` con `{session_id, absolute_start_offset_ms, stream_id}`.
//      El offset lo captura el content script leyendo `video.currentTime` en el momento
//      exacto del user gesture que disparó la grabación. CRÍTICO (plan §2.4.1).
//   2. SW obtuvo previamente `streamId` vía `chrome.tabCapture.getMediaStreamId({ targetTabId })`
//      y lo adjuntó al mensaje.
//   3. Offscreen llama a `getUserMedia` con el streamId → MediaStream → MediaRecorder.
//   4. Cada 30s (`recorder_chunk_interval_ms`), emite `dataavailable` con un Blob opus;
//      se reenvía al SW como `recording_chunk` con el offset absoluto adjunto.
//   5. Seeking: el content script detecta `seeking` del <video>, notifica al SW, y el SW
//      envía `stop_recording` + `start_recording` con nuevo offset. Este módulo trata cada
//      ciclo como un `run_id` independiente, numerado incrementalmente para dedupe backend
//      (plan §4.22).
//   6. Pause/Resume: MediaRecorder nativo — no rompe el run_id, el chunk_index sigue monótono.
//
// B) SSE cliente (plan §3.3, reemplaza EventSource nativo):
//   1. SW envía `sse_open` con `{session_id, url, body, token}`.
//   2. Offscreen hace `fetch(url, {method:"POST", body, headers:{Accept:"text/event-stream"}})`.
//      Un AbortController por sesión permite cancelación explícita desde el SW.
//   3. Parseo incremental del stream: los frames SSE se separan por `\n\n`; dentro, líneas
//      `event:` y `data:` componen cada evento. Por cada frame parseado, se broadcast-ea un
//      `sse_event` con `{event, data}`.
//   4. Errores (HTTP non-2xx, desconexión, timeout del read) se señalan como evento
//      `event: "error"` y cierran la conexión. La cancelación explícita no emite error.

import { config } from "@/shared/config";
import type { audio_blob_payload, internal_message } from "@/shared/types";

interface recording_state {
  session_id: string;
  run_id: string;
  run_index: number; // monótono por sesión, límite max_recording_runs_per_session.
  recorder: MediaRecorder;
  stream: MediaStream;
  absolute_start_offset_ms: number;
  chunk_index: number;
  started_at_ms: number;
}

let current_run: recording_state | null = null;
const run_count_by_session = new Map<string, number>();

// ---------- probe RMS anti-DRM (plan §4.4) ----------
//
// Motivación: algunos navegadores routean el audio decodificado tras DRM directamente al SO
// (hardware-accelerated path). `getUserMedia({chromeMediaSource:"tab"})` entrega el stream
// pero los samples están en cero — MediaRecorder grabaría silencio absoluto. Detectamos esto
// rápido (3s) antes de acumular 30s de garbage y notificamos a la UI para que el usuario sepa
// por qué falla y pueda probar otro navegador.
//
// Branching: creamos un `AudioContext` + `MediaStreamAudioSourceNode` derivado del mismo
// MediaStream del recorder. El `AnalyserNode` opera en paralelo al recorder sin alterar sus
// samples (los nodos son independientes). No conectamos el analyser a `destination`: evita
// que el audio vuelva a salir por el altavoz.

async function probe_rms_for_drm(session_id: string, stream: MediaStream): Promise<void> {
  const ac = new AudioContext();
  try {
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    const start_ms = performance.now();
    let peak_db = -Infinity;

    while (performance.now() - start_ms < config.rms_probe_duration_ms) {
      if (current_run?.session_id !== session_id) return; // run cambió → abort probe
      analyser.getFloatTimeDomainData(buf);
      // RMS sobre la ventana de tiempo (valores ya en [-1, 1]).
      let sum_sq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i]!;
        sum_sq += v * v;
      }
      const rms = Math.sqrt(sum_sq / buf.length);
      // Guard vs log(0) cuando el buffer es silencio absoluto bit-exacto.
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      if (db > peak_db) peak_db = db;
      // Short-circuit: si en algún tick ya supera el threshold, NO es DRM → abort probe.
      if (db >= config.rms_probe_silence_threshold_db) {
        return;
      }
      await new Promise((r) => setTimeout(r, config.rms_probe_tick_ms));
    }

    // Ventana agotada sin superar el threshold → DRM hardware-routed.
    console.warn("[DOVI] drm_hardware_block detectado", { session_id, peak_db });
    // Paramos la run antes de emitir — el SW también forward-ea stop por defensa.
    stop_recording_run();
    const msg: internal_message = {
      type: "drm_hardware_block",
      session_id,
      peak_db: Number.isFinite(peak_db) ? peak_db : -120,
    };
    chrome.runtime.sendMessage(msg).catch((err: unknown) => {
      console.warn("[DOVI] drm_hardware_block broadcast failed", err);
    });
  } catch (err) {
    // Fallo inesperado del AudioContext (stream ya cerrado, etc.) — no bloqueamos la grabación.
    console.warn("[DOVI] probe_rms_for_drm failed", err);
  } finally {
    try {
      await ac.close();
    } catch {
      /* best effort */
    }
  }
}

// ---------- acquisition de MediaStream ----------

async function acquire_tab_media_stream(stream_id: string): Promise<MediaStream> {
  // La sintaxis `chromeMediaSource` requiere el objeto legacy en `mandatory`. El Chromium
  // actual sigue aceptándolo para tabCapture. `audio` mandatory, `video` deshabilitado
  // (grabamos solo audio para Whisper).
  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: stream_id,
      },
    },
    video: false,
  } as unknown as MediaStreamConstraints;

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  if (stream.getAudioTracks().length === 0) {
    throw new Error("tab_capture_no_audio_tracks");
  }
  return stream;
}

// ---------- start / stop / pause / resume ----------

async function start_recording_run(
  session_id: string,
  stream_id: string,
  absolute_start_offset_ms: number,
): Promise<void> {
  if (current_run) {
    // Stop limpio del run anterior antes de empezar uno nuevo (caso: seeking handler).
    stop_recording_run();
  }

  const existing_runs = run_count_by_session.get(session_id) ?? 0;
  if (existing_runs >= config.max_recording_runs_per_session) {
    // Protección plan §4.22 — scrubbing malicioso.
    console.warn("[DOVI] max_recording_runs_per_session reached; aborting", {
      session_id,
      existing_runs,
    });
    return;
  }

  const stream = await acquire_tab_media_stream(stream_id);
  const recorder = new MediaRecorder(stream, {
    mimeType: config.recorder_mime_type,
    audioBitsPerSecond: config.recorder_bits_per_second,
  });

  const run_id = crypto.randomUUID();
  const state: recording_state = {
    session_id,
    run_id,
    run_index: existing_runs,
    recorder,
    stream,
    absolute_start_offset_ms,
    chunk_index: 0,
    started_at_ms: Date.now(),
  };
  current_run = state;
  run_count_by_session.set(session_id, existing_runs + 1);

  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0) return;
    const payload: audio_blob_payload = {
      session_id: state.session_id,
      run_id: state.run_id,
      chunk_index: state.chunk_index++,
      absolute_start_offset_ms: state.absolute_start_offset_ms,
      audio: event.data,
    };
    const msg: internal_message = { type: "recording_chunk", payload };
    chrome.runtime.sendMessage(msg).catch((err: unknown) => {
      console.warn("[DOVI] recording_chunk send failed", err);
    });
  });

  recorder.addEventListener("error", (ev) => {
    const e = ev as { error?: DOMException };
    console.error("[DOVI] recorder error", e.error?.name, e.error?.message);
  });

  recorder.addEventListener("stop", () => {
    // Cuando el usuario pausa+reanuda el <video>, el recorder sigue corriendo; sólo
    // llegamos aquí cuando hubo stop explícito. Liberamos tracks para soltar el mic/tab.
    for (const track of stream.getAudioTracks()) track.stop();
  });

  recorder.start(config.recorder_chunk_interval_ms);

  // Probe RMS en paralelo (plan §4.4). No awaiteamos: corre en background y detiene la run
  // si detecta silencio sostenido. Usa el MISMO MediaStream — cada nodo consume de su propia
  // fuente sin interferir con el recorder.
  void probe_rms_for_drm(session_id, stream);

  console.info("[DOVI] recording_run started", {
    session_id,
    run_id,
    run_index: state.run_index,
    absolute_start_offset_ms,
  });
}

function stop_recording_run(): void {
  if (!current_run) return;
  const run = current_run;
  current_run = null;
  try {
    if (run.recorder.state !== "inactive") run.recorder.stop();
  } catch (err) {
    console.warn("[DOVI] recorder.stop failed", err);
  }
  for (const track of run.stream.getAudioTracks()) track.stop();
}

function pause_recording_run(): void {
  if (!current_run) return;
  if (current_run.recorder.state === "recording") {
    try {
      current_run.recorder.pause();
    } catch (err) {
      console.warn("[DOVI] recorder.pause failed", err);
    }
  }
}

function resume_recording_run(): void {
  if (!current_run) return;
  if (current_run.recorder.state === "paused") {
    try {
      current_run.recorder.resume();
    } catch (err) {
      console.warn("[DOVI] recorder.resume failed", err);
    }
  }
}

// ---------- SSE cliente ----------

interface sse_connection {
  session_id: string;
  abort: AbortController;
}

const active_sse = new Map<string, sse_connection>();

const SSE_STALE_READ_TIMEOUT_MS = 120_000; // si no llega ningún byte en 2 min → desconexión.

function emit_sse_event(session_id: string, event: string, data: string): void {
  const msg: internal_message = { type: "sse_event", session_id, event, data };
  chrome.runtime.sendMessage(msg).catch((err: unknown) => {
    // Broadcast a runtime (SW + UI). Si ninguno escucha se ignora silenciosamente.
    console.debug("[DOVI] sse_event broadcast failed", { event, err: String(err) });
  });
}

async function open_sse_stream(
  session_id: string,
  url: string,
  body: string,
  token: string,
): Promise<void> {
  // Cierre idempotente de una conexión previa para la misma sesión (re-query del usuario).
  close_sse_stream(session_id);

  const abort = new AbortController();
  active_sse.set(session_id, { session_id, abort });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DOVI-Token": token,
        Accept: "text/event-stream",
      },
      body,
      signal: abort.signal,
    });

    if (!response.ok) {
      emit_sse_event(session_id, "error", `http_${response.status}`);
      return;
    }
    if (!response.body) {
      emit_sse_event(session_id, "error", "no_body");
      return;
    }

    await consume_sse_body(session_id, response.body, abort);
    // Stream cerrado limpiamente por el servidor (EOF).
    emit_sse_event(session_id, "close", "");
  } catch (err) {
    if (abort.signal.aborted) {
      // Cancelación explícita (sse_close desde SW/UI); no es error de protocolo.
      return;
    }
    emit_sse_event(session_id, "error", err instanceof Error ? err.message : String(err));
  } finally {
    active_sse.delete(session_id);
  }
}

async function consume_sse_body(
  session_id: string,
  body: ReadableStream<Uint8Array>,
  abort: AbortController,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  // Timer de inactividad: si el servidor deja de enviar bytes por N ms, abortamos.
  let stale_timer: ReturnType<typeof setTimeout> | null = null;
  const reset_stale = (): void => {
    if (stale_timer !== null) clearTimeout(stale_timer);
    stale_timer = setTimeout(() => abort.abort(), SSE_STALE_READ_TIMEOUT_MS);
  };
  reset_stale();

  try {
    while (!abort.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      reset_stale();
      buffer += decoder.decode(value, { stream: true });
      buffer = parse_sse_frames(session_id, buffer);
    }
    // Flush final: el decoder puede tener bytes multi-byte pendientes.
    buffer += decoder.decode();
    parse_sse_frames(session_id, buffer);
  } finally {
    if (stale_timer !== null) clearTimeout(stale_timer);
    try {
      reader.releaseLock();
    } catch {
      /* best effort */
    }
  }
}

// Parsea todos los frames completos (separados por `\n\n`) presentes en `buffer` y emite
// `sse_event` por cada uno. Devuelve el remanente (frame parcial aún en curso).
function parse_sse_frames(session_id: string, buffer: string): string {
  let remaining = buffer;
  // El spec SSE acepta `\n\n`, `\r\n\r\n`, y `\r\r`. Normalizamos \r\n a \n primero.
  remaining = remaining.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let idx: number;
  while ((idx = remaining.indexOf("\n\n")) !== -1) {
    const frame = remaining.slice(0, idx);
    remaining = remaining.slice(idx + 2);
    emit_parsed_frame(session_id, frame);
  }
  return remaining;
}

function emit_parsed_frame(session_id: string, frame: string): void {
  if (frame.length === 0) return;
  let event_name = "message";
  let data_lines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // comentario SSE (heartbeat).
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // `data: foo` tiene un espacio opcional tras el `:`. El spec lo considera opcional.
    const raw_value = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw_value.startsWith(" ") ? raw_value.slice(1) : raw_value;
    if (field === "event") event_name = value;
    else if (field === "data") data_lines.push(value);
    else if (field === "id" || field === "retry") {
      // No tracking de Last-Event-ID en esta iteración (sin reconexión automática).
    }
  }
  const data = data_lines.join("\n");
  if (data.length === 0 && event_name === "message") return; // frame vacío, ignorar.
  emit_sse_event(session_id, event_name, data);
}

function close_sse_stream(session_id: string): void {
  const conn = active_sse.get(session_id);
  if (!conn) return;
  conn.abort.abort();
  active_sse.delete(session_id);
}

// ---------- message bus ----------

// El SW adjunta `stream_id` al mensaje start_recording bajo una propiedad extendida.
// Reusamos el type `start_recording` del bus original + cast controlado.
type start_with_stream = Extract<internal_message, { type: "start_recording" }> & {
  stream_id?: string;
};

chrome.runtime.onMessage.addListener(
  (message: internal_message, _sender, sendResponse: (r: unknown) => void) => {
    if (message.type === "start_recording") {
      const m = message as start_with_stream;
      const stream_id = m.stream_id;
      if (!stream_id) {
        sendResponse({ ok: false, error: "missing_stream_id" });
        return false;
      }
      void start_recording_run(
        message.session_id,
        stream_id,
        message.absolute_start_offset_ms,
      ).then(
        () => sendResponse({ ok: true }),
        (err: unknown) => {
          console.error("[DOVI] start_recording_run failed", err);
          sendResponse({ ok: false, error: String(err) });
        },
      );
      return true; // async
    }

    if (message.type === "stop_recording") {
      stop_recording_run();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "pause_recording") {
      pause_recording_run();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "resume_recording") {
      resume_recording_run();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "sse_open") {
      // Arranca en background. No retornamos true porque el caller no espera respuesta
      // útil — el SW/UI reciben el estado vía `sse_event`.
      void open_sse_stream(message.session_id, message.url, message.body, message.token).catch(
        (err: unknown) => {
          console.error("[DOVI] open_sse_stream threw", err);
        },
      );
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "sse_close") {
      close_sse_stream(message.session_id);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  },
);

export {};
