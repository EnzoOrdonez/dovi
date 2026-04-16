// Nivel 0 (plan §2.2): MutationObserver sobre paneles de transcripción.
//
// Diseño:
//   * Dedup por hash FNV-1a 32-bit (sync, rápido, buena distribución para strings cortos).
//     Evita el coste de `crypto.subtle.digest` asíncrono en el hot path del observer.
//     El plan §4.7 pide SHA-1 — la propiedad es determinismo + anti-colisión razonable, no
//     resistencia criptográfica; FNV-1a cumple ese contrato para textos ≤32 chars.
//   * Coalescing: los MutationRecord llegan en ráfagas durante re-render de SPAs. Batcheamos
//     con requestAnimationFrame (fallback: setTimeout 16ms en workers/frames sin rAF).
//   * Re-observación ante destrucción del <body>: algunos SPAs (React hydration, iframe reload)
//     reemplazan el body. Vigilamos <html> con childList para reconectar el observer al nuevo body.
//   * Generic adapter + <track kind="captions">: si el adapter es `generic`, nos suscribimos
//     también a `textTracks` del <video> primario (evento `cuechange`) para cubrir el caso
//     HTML5 puro sin DOM específico.
//   * `ensure_transcript_visible` se invoca una sola vez al arranque; si el panel está oculto
//     el adapter correspondiente simula el click para desbloquear el flujo.

import type { platform_adapter } from "@/platforms/registry";
import type { cue, internal_message } from "@/shared/types";

// ---------- dedup ----------

const seen_cue_hashes = new Set<string>();

function fnv1a_32(input: string): string {
  // Hash rápido y determinista. Suficiente para dedupe de cues del mismo session.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // imul evita overflow fuera de 32 bits.
    h = Math.imul(h, 0x01000193);
  }
  // toString(16) + pad a 8 hex para hashes comparables como strings.
  return (h >>> 0).toString(16).padStart(8, "0");
}

function cue_hash(c: cue): string {
  return fnv1a_32(`${c.t_start_ms}|${c.text.slice(0, 32)}`);
}

// ---------- control state ----------

interface observer_context {
  adapter: platform_adapter;
  session_id: string;
  pending: cue[];
  flush_scheduled: boolean;
  mutation_observer: MutationObserver | null;
  body_observer: MutationObserver | null;
  track_unbinders: Array<() => void>;
  running: boolean;
}

const ctx: observer_context = {
  adapter: null as unknown as platform_adapter,
  session_id: "",
  pending: [],
  flush_scheduled: false,
  mutation_observer: null,
  body_observer: null,
  track_unbinders: [],
  running: false,
};

// ---------- flush con coalescing ----------

function schedule_flush(): void {
  if (ctx.flush_scheduled) return;
  ctx.flush_scheduled = true;
  const runner = (): void => {
    ctx.flush_scheduled = false;
    if (ctx.pending.length === 0) return;
    const batch = ctx.pending;
    ctx.pending = [];
    const message: internal_message = {
      type: "cues_extracted",
      session_id: ctx.session_id,
      cues: batch,
    };
    // sendMessage puede fallar si el SW está dormido; el listener del SW debe wake-up.
    chrome.runtime.sendMessage(message).catch((err: unknown) => {
      console.warn("[DOVI] cues_extracted sendMessage failed", err);
    });
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(runner);
  } else {
    setTimeout(runner, 16);
  }
}

function push_cue(c: cue): void {
  const h = cue_hash(c);
  if (seen_cue_hashes.has(h)) return;
  seen_cue_hashes.add(h);
  ctx.pending.push(c);
  schedule_flush();
}

// ---------- core observer ----------

function process_element(el: Element): void {
  const c = ctx.adapter.parse_cue_element(el);
  if (c) push_cue(c);
}

function process_mutation_batch(mutations: MutationRecord[]): void {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.(ctx.adapter.transcript_selector)) {
        process_element(node);
      }
      const matches = node.querySelectorAll?.(ctx.adapter.transcript_selector);
      if (matches) {
        for (const el of matches) process_element(el);
      }
    }
    // characterData: el texto de un cue existente fue editado (rare pero real en YT auto-captions).
    if (m.type === "characterData" && m.target.parentElement) {
      const host = m.target.parentElement.closest(ctx.adapter.transcript_selector);
      if (host) process_element(host);
    }
  }
}

function attach_observer_to_body(): void {
  if (!document.body) return;
  ctx.mutation_observer?.disconnect();
  const mo = new MutationObserver((mutations) => {
    // Evitamos rAF dentro del callback para no fragmentar el batch;
    // el propio observer ya agrupa mutaciones entre microtask boundaries.
    process_mutation_batch(mutations);
  });
  mo.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  ctx.mutation_observer = mo;

  // Scan inicial: el panel puede ya estar renderizado al arrancar.
  const initial = document.querySelectorAll(ctx.adapter.transcript_selector);
  for (const el of initial) process_element(el);
}

function watch_body_replacement(): void {
  // En algunas SPAs, React reemplaza <body> completo al navegar. El observer queda huérfano.
  ctx.body_observer?.disconnect();
  const bo = new MutationObserver(() => {
    if (!document.body) return;
    if (ctx.mutation_observer && document.body === (ctx.mutation_observer as unknown as { _target?: Element })._target) {
      return;
    }
    attach_observer_to_body();
  });
  bo.observe(document.documentElement, { childList: true });
  ctx.body_observer = bo;
}

// ---------- generic: HTML5 textTracks ----------

function bind_html5_text_tracks(): void {
  // Solo útil para el generic adapter: cubre <video> + <track kind="captions">.
  if (ctx.adapter.name !== "generic") return;

  const video = document.querySelector("video");
  if (!video) return;

  const harvest_from_track = (track: TextTrack): void => {
    if (!track.cues) return;
    // Forzamos modo "hidden" para que el browser pueble `track.cues` sin renderizar overlay.
    if (track.mode === "disabled") track.mode = "hidden";
    for (const vtt of Array.from(track.cues) as VTTCue[]) {
      const c: cue = {
        t_start_ms: Math.round(vtt.startTime * 1000),
        t_end_ms: Math.round(vtt.endTime * 1000),
        speaker: null,
        text: (vtt.text || "").replace(/<[^>]+>/g, "").trim(),
        source_level: 0,
      };
      if (c.text.length > 0) push_cue(c);
    }
  };

  const wire_track = (track: TextTrack): void => {
    // Evento cuechange: se dispara al avanzar la reproducción, permite captar cues nuevos.
    const handler = (): void => harvest_from_track(track);
    track.addEventListener("cuechange", handler);
    ctx.track_unbinders.push(() => track.removeEventListener("cuechange", handler));
    // Pase inicial.
    harvest_from_track(track);
  };

  for (const track of Array.from(video.textTracks)) {
    if (track.kind === "captions" || track.kind === "subtitles") wire_track(track);
  }

  const on_addtrack = (ev: TrackEvent): void => {
    const track = ev.track;
    if (track && (track.kind === "captions" || track.kind === "subtitles")) {
      wire_track(track);
    }
  };
  video.textTracks.addEventListener("addtrack", on_addtrack);
  ctx.track_unbinders.push(() => video.textTracks.removeEventListener("addtrack", on_addtrack));
}

// ---------- public API ----------

export function start_mutation_observer(adapter: platform_adapter, session_id: string): void {
  if (ctx.running) {
    console.warn("[DOVI] mutation_observer already running; ignoring restart");
    return;
  }
  ctx.adapter = adapter;
  ctx.session_id = session_id;
  ctx.running = true;

  // Asegurar panel visible en plataformas que lo ocultan por defecto (YouTube, etc.).
  void adapter.ensure_transcript_visible?.();

  attach_observer_to_body();
  watch_body_replacement();
  bind_html5_text_tracks();

  // Listener para `fetch_vtt_url` del SW (Nivel 1 body retrieval): parsea con webvtt-parser
  // y empuja cues por el mismo canal del Nivel 0.
  const on_message = (
    msg: internal_message,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): boolean => {
    if (msg.type !== "fetch_vtt_url") return false;
    if (msg.session_id !== ctx.session_id) return false;
    void handle_vtt_url_fetch(msg.url).then(
      (count) => sendResponse({ ok: true, cues: count }),
      (err: unknown) => sendResponse({ ok: false, error: String(err) }),
    );
    return true; // async response
  };
  chrome.runtime.onMessage.addListener(on_message);
}

async function handle_vtt_url_fetch(url: string): Promise<number> {
  // Importación dinámica: webvtt-parser sólo se carga si se dispara Nivel 1.
  const { WebVTTParser } = await import("webvtt-parser");
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`vtt_fetch_failed:${resp.status}`);
  const body = await resp.text();
  const parsed = new WebVTTParser().parse(body, "metadata");
  let count = 0;
  for (const vtt of parsed.cues) {
    const c: cue = {
      t_start_ms: Math.round(vtt.startTime * 1000),
      t_end_ms: Math.round(vtt.endTime * 1000),
      speaker: null,
      text: String(vtt.text || "").replace(/<[^>]+>/g, "").trim(),
      source_level: 1,
    };
    if (c.text.length > 0) {
      push_cue(c);
      count++;
    }
  }
  return count;
}

export function stop_mutation_observer(): void {
  ctx.mutation_observer?.disconnect();
  ctx.body_observer?.disconnect();
  for (const fn of ctx.track_unbinders) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
  ctx.track_unbinders = [];
  ctx.mutation_observer = null;
  ctx.body_observer = null;
  ctx.pending = [];
  ctx.flush_scheduled = false;
  ctx.running = false;
  seen_cue_hashes.clear();
}

// Cuenta de cues únicos observados (post-dedup). Consumido por `inject.ts` para decidir el
// gatillo de Nivel 2 tras T segundos (plan §2.4): si count < N, se dispara MediaRecorder.
export function get_observed_cue_count(): number {
  return seen_cue_hashes.size;
}

// Exportado para tests unitarios.
export const __internals = { cue_hash, fnv1a_32 };
