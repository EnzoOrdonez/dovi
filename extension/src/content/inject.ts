// Content script bootstrapper (inyectado en document_start, all_frames:true).
//
// Responsabilidades (plan §2.1, §2.2, §2.4.1):
//   1. `vod_guard`: abortar en livestreams antes de cualquier gasto computacional.
//   2. Resolver `platform_adapter` por hostname.
//   3. Arrancar MutationObserver de Nivel 0 (emite cues al SW).
//   4. Evaluar gatillo de Nivel 2 tras T segundos:
//        - Si Niveles 0/1 no entregaron >=N cues, activar MediaRecorder.
//        - El gatillo respeta user gesture: requiere que el video esté reproduciéndose (play() ya
//          sucedió); `chrome.tabCapture.getMediaStreamId` en el SW validará user gesture reciente.
//   5. Cablear listeners `seeking | pause | play` al `<video>` — sólo tras activar Nivel 2 —
//      para que el offscreen mantenga `absolute_start_offset_ms` sincronizado (plan §2.4.1).
//
// Ciclo de vida: `pagehide` dispara abort al SW para limpieza determinista de offscreen/SSE.
//
// El `player_controller` se importa por side-effect (registra su propio listener de `seek_request`).

import { resolve_adapter } from "@/platforms/registry";
import { config } from "@/shared/config";
import type { internal_message } from "@/shared/types";
import { get_observed_cue_count, start_mutation_observer } from "./mutation_observer";
import "./player_controller";

// ---------- detección inicial ----------

async function wait_for_metadata(video: HTMLVideoElement, timeout_ms = 5000): Promise<void> {
  if (Number.isFinite(video.duration) && video.duration > 0) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      video.removeEventListener("loadedmetadata", finish);
      resolve();
    };
    video.addEventListener("loadedmetadata", finish, { once: true });
    setTimeout(finish, timeout_ms);
  });
}

function is_vod(video: HTMLVideoElement): boolean {
  // Checks mínimos suficientes para la mayoría de livestreams:
  //   · Infinity / NaN duration → HLS live o WebRTC.
  //   · seekable vacío → el browser considera el stream no navegable.
  // Refinamientos HLS/DASH a nivel manifest viven en web_request.ts (plan §2.1 — TODO bajo flag).
  if (!Number.isFinite(video.duration)) return false;
  if (video.duration <= 0) return false;
  if (video.seekable.length === 0) return false;
  return true;
}

function find_primary_video(): HTMLVideoElement | null {
  // Heurística: el `<video>` visible de mayor área. Para frames sin video devuelve null y el
  // bootstrap aborta silenciosamente (los content scripts se inyectan en todos los frames).
  const candidates = Array.from(document.querySelectorAll("video"));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  let best: HTMLVideoElement | null = null;
  let best_area = -1;
  for (const v of candidates) {
    const rect = v.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area > best_area) {
      best_area = area;
      best = v;
    }
  }
  return best;
}

async function poll_for_video(max_tries = 40, interval_ms = 250): Promise<HTMLVideoElement | null> {
  for (let i = 0; i < max_tries; i++) {
    const v = find_primary_video();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval_ms));
  }
  return null;
}

// ---------- Nivel 2: wiring de eventos + mensaje al SW ----------

interface level_2_state {
  session_id: string;
  video: HTMLVideoElement;
  active: boolean;
  handlers: Array<() => void>;
}

function send(msg: internal_message): void {
  chrome.runtime.sendMessage(msg).catch((err: unknown) => {
    // El SW puede estar dormido en el instante del envío: el chunk se reintentará en el
    // siguiente evento (pause/play/seeking) porque el video events son frecuentes.
    console.debug("[DOVI] sendMessage failed", { type: msg.type, err: String(err) });
  });
}

function start_recording_run(state: level_2_state): void {
  const offset_ms = Math.max(0, Math.floor(state.video.currentTime * 1000));
  send({
    type: "start_recording",
    session_id: state.session_id,
    absolute_start_offset_ms: offset_ms,
  });
}

function stop_recording_run(state: level_2_state): void {
  send({ type: "stop_recording", session_id: state.session_id });
}

function wire_video_events(state: level_2_state): void {
  const { video, session_id } = state;

  // seeking: flush del run actual + nuevo run con `absolute_start_offset_ms` fresco.
  // `seeking` dispara ANTES de que termine la reposición; `video.currentTime` ya apunta al target.
  const on_seeking = (): void => {
    stop_recording_run(state);
    start_recording_run(state);
  };

  const on_pause = (): void => {
    send({ type: "pause_recording", session_id });
  };

  const on_play = (): void => {
    // `play` también se dispara tras un `seeked` si el video estaba en play — el offscreen es
    // idempotente ante `resume` cuando ya está grabando (MediaRecorder.resume() en estado
    // "recording" es no-op), así que no necesitamos discriminar el contexto aquí.
    send({ type: "resume_recording", session_id });
  };

  video.addEventListener("seeking", on_seeking);
  video.addEventListener("pause", on_pause);
  video.addEventListener("play", on_play);

  state.handlers.push(() => video.removeEventListener("seeking", on_seeking));
  state.handlers.push(() => video.removeEventListener("pause", on_pause));
  state.handlers.push(() => video.removeEventListener("play", on_play));
}

function unwire_video_events(state: level_2_state): void {
  for (const off of state.handlers) {
    try {
      off();
    } catch {
      /* best effort */
    }
  }
  state.handlers = [];
}

function activate_level_2(state: level_2_state): void {
  if (state.active) return;
  state.active = true;
  console.info("[DOVI] level 2 trigger — starting MediaRecorder", {
    session_id: state.session_id,
  });
  wire_video_events(state);
  // Arrancamos con el offset actual del video; si el video está en pausa, el offscreen graba
  // igualmente — el usuario pulsará play y el `play` handler enviará `resume_recording`.
  start_recording_run(state);
}

function deactivate_level_2(state: level_2_state): void {
  if (!state.active) return;
  state.active = false;
  stop_recording_run(state);
  unwire_video_events(state);
}

// ---------- bootstrap ----------

async function bootstrap(): Promise<void> {
  const adapter = resolve_adapter(location.hostname);
  // `session_id` por frame; el SW mantiene el mapa `tab_id → session_id` (un tab suele tener un
  // frame dominante con el VOD). Frames hijos con sus propios videos son sesiones independientes
  // desde el punto de vista del content, pero el SW puede deduplicarlas.
  const session_id = crypto.randomUUID();
  console.info("[DOVI] content script up", {
    hostname: location.hostname,
    adapter: adapter.name,
    session_id,
  });

  const video = await poll_for_video();
  if (!video) {
    // Frame sin video; fin de responsabilidad.
    return;
  }
  await wait_for_metadata(video);

  if (!is_vod(video)) {
    send({ type: "abort", session_id, reason: "livestream_detected" });
    return;
  }

  start_mutation_observer(adapter, session_id);

  // Evaluación diferida del gatillo de Nivel 2.
  const state: level_2_state = {
    session_id,
    video,
    active: false,
    handlers: [],
  };

  const evaluate_level_2 = (): void => {
    const count = get_observed_cue_count();
    if (count >= config.level_2_min_cues) {
      console.debug("[DOVI] level 2 not needed", { count });
      return;
    }
    if (video.paused || video.ended) {
      // Sin reproducción activa, no hay audio que capturar. Reintentar al próximo `play`.
      const retry = (): void => {
        video.removeEventListener("play", retry);
        activate_level_2(state);
      };
      video.addEventListener("play", retry, { once: true });
      return;
    }
    activate_level_2(state);
  };
  setTimeout(evaluate_level_2, config.level_2_timeout_seconds * 1000);

  // Limpieza: el SW desaloja offscreen + SSE al recibir `abort`.
  const on_pagehide = (): void => {
    deactivate_level_2(state);
    send({ type: "abort", session_id, reason: "pagehide" });
    window.removeEventListener("pagehide", on_pagehide);
  };
  window.addEventListener("pagehide", on_pagehide);
}

// Defer hasta que el DOM esté listo — evita querySelectors prematuros en `document_start`.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void bootstrap());
} else {
  void bootstrap();
}
