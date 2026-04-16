// Control del reproductor (plan §2.5 + §4.18).
//
// Estrategia de seek de dos pasos:
//
//   1. Adapter-specific (`platform_adapter.seek_to`):
//      - Plataformas con <video> no expuesto o comandos custom (Zoom WebRTC, iframes cross-origin
//        con postMessage propietario) implementan su propio seek_to.
//
//   2. ISOLATED world (intent directo sobre `video.currentTime`):
//      - Funciona en la mayoría de sitios; barato.
//      - Detectamos fallo silencioso esperando al evento `seeked` con timeout — si el setter está
//        bloqueado por wrappers custom (defineProperty con setter throwing, players que usan
//        shadow DOM no accesible desde ISOLATED), `seeked` nunca se dispara y timeout → fallback.
//
//   3. MAIN world (fallback CSP-safe):
//      - Delegamos al SW que ejecuta `chrome.scripting.executeScript({world:"MAIN", allFrames:true})`.
//      - MV3 doc confirma que este path bypassa CSP del sitio por diseño (plan §4.18) y recorre
//        shadow roots profundos para encontrar el <video>. El listener aquí no toca el DOM en MAIN,
//        sólo pide al SW que lo haga.
//
// Sobre listener multi-frame: `chrome.tabs.sendMessage(tab_id, msg)` entrega el seek_request a
// TODOS los frames del tab. Frames sin video ni adapter.seek_to retornan `false` para ceder el
// responseSlot al frame correcto. Sólo un respondedor gana; los demás no cierran el channel.

import { resolve_adapter } from "@/platforms/registry";
import type { internal_message } from "@/shared/types";

// ---------- parámetros de tolerancia ----------

const SEEK_DRIFT_TOLERANCE_MS = 500; // aceptamos hasta 0.5s de diferencia post-seek.
const ISOLATED_SEEK_TIMEOUT_MS = 1500; // si `seeked` no dispara en este lapso → fallback MAIN.
const ALREADY_AT_TARGET_MS = 250; // si ya estamos suficientemente cerca, no tocamos currentTime.

// ---------- ISOLATED world seek ----------

function try_isolated_seek(video: HTMLVideoElement, target_ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", on_seeked);
      resolve(ok);
    };
    const on_seeked = (): void => {
      const drift = Math.abs(video.currentTime * 1000 - target_ms);
      finish(drift < SEEK_DRIFT_TOLERANCE_MS);
    };
    video.addEventListener("seeked", on_seeked);
    const timer = setTimeout(() => finish(false), ISOLATED_SEEK_TIMEOUT_MS);
    try {
      video.currentTime = target_ms / 1000;
    } catch {
      // Setter bloqueado (ej. `Object.defineProperty` custom por el player); fallback inmediato.
      clearTimeout(timer);
      finish(false);
    }
  });
}

// ---------- MAIN world delegation ----------

async function request_main_world_seek(session_id: string, target_ms: number): Promise<boolean> {
  const msg: internal_message = {
    type: "main_world_seek",
    session_id,
    t_start_ms: target_ms,
  };
  try {
    const response = (await chrome.runtime.sendMessage(msg)) as { ok?: boolean } | undefined;
    return Boolean(response?.ok);
  } catch (err) {
    console.warn("[DOVI] main_world_seek dispatch failed", err);
    return false;
  }
}

// ---------- orquestador ----------

export async function seek_to_ms(target_ms: number, session_id: string): Promise<boolean> {
  const adapter = resolve_adapter(location.hostname);

  // Path 1: adapter-specific (Zoom, players custom).
  if (adapter.seek_to) {
    try {
      const ok = await adapter.seek_to(target_ms);
      if (ok) return true;
    } catch (err) {
      console.warn("[DOVI] adapter.seek_to threw", { adapter: adapter.name, err });
    }
  }

  const video = document.querySelector("video");
  if (!video) {
    // Sin video en este frame: delegamos al SW que usará `allFrames:true` en MAIN world y
    // encontrará el video en otro frame o shadow root profundo.
    return request_main_world_seek(session_id, target_ms);
  }

  // Corto-circuito: si ya estamos en el target, no perturbamos la reproducción.
  if (Math.abs(video.currentTime * 1000 - target_ms) < ALREADY_AT_TARGET_MS) {
    try {
      await video.play();
    } catch {
      /* autoplay policies */
    }
    return true;
  }

  // Path 2: ISOLATED world.
  const isolated_ok = await try_isolated_seek(video, target_ms);
  if (isolated_ok) {
    try {
      await video.play();
    } catch {
      /* autoplay policies */
    }
    return true;
  }

  // Path 3: MAIN world (CSP bypass vía SW).
  return request_main_world_seek(session_id, target_ms);
}

// ---------- listener desde SW ----------

chrome.runtime.onMessage.addListener((message: internal_message, _sender, sendResponse) => {
  if (message.type !== "seek_request") return false;

  // Ceder el channel a otro frame si este no tiene nada útil que hacer.
  const adapter = resolve_adapter(location.hostname);
  const has_video = document.querySelector("video") !== null;
  if (!adapter.seek_to && !has_video) return false;

  void seek_to_ms(message.t_start_ms, message.session_id).then(
    (ok) => sendResponse({ ok }),
    (err: unknown) => {
      console.warn("[DOVI] seek_to_ms failed", err);
      sendResponse({ ok: false, error: String(err) });
    },
  );
  return true; // async response
});
