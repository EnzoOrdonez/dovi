import type { platform_adapter } from "./registry";
import type { cue } from "@/shared/types";

// Vimeo: las captions viven en un nodo con clase hashed `Captions_captionLine__xxxx`.
// El texto está en un span hijo; Vimeo NO expone timestamps en el DOM del overlay.
// Para recuperar el t_start necesitamos leerlo del <video>.textTracks (cuechange), lo
// cual cubre el generic adapter como fallback.
//
// Aquí devolvemos cue con timestamp derivado del `currentTime` del <video> asociado
// — aproximación útil cuando el overlay está sincronizado con la reproducción.

function current_video_time_ms(): number | null {
  const video = document.querySelector<HTMLVideoElement>("video");
  if (!video) return null;
  const t = video.currentTime;
  if (!Number.isFinite(t)) return null;
  return Math.round(t * 1000);
}

export const vimeo_adapter: platform_adapter = {
  name: "vimeo",
  matches: (hostname) => /(^|\.)vimeo\.com$/.test(hostname),
  transcript_selector: "[class^='Captions_captionLine']",

  parse_cue_element: (element) => {
    const text = (element.textContent ?? "").trim();
    if (text.length === 0) return null;
    const t_start = current_video_time_ms();
    if (t_start === null) return null;
    const c: cue = {
      t_start_ms: t_start,
      t_end_ms: t_start + 4000, // overlay no expone duración; el chunker lo reajusta.
      speaker: null,
      text,
      source_level: 0,
    };
    return c;
  },
};
