import type { platform_adapter } from "./registry";
import type { cue } from "@/shared/types";

// Zoom web client (recording playback): el panel de transcripción usa listitems
// con `data-transcript-cue` que incluye start_ms y speaker en attributes.
// Formato observado:
//   <div role="listitem" data-transcript-cue
//        data-start-ms="12345" data-end-ms="13500" data-speaker="Jane Doe">
//     <span class="cue-text">…</span>
//   </div>
//
// seek_to: Zoom Webinar live usa WebRTC sobre canvas y NO expone <video>. Fallback:
// simular KeyboardEvent("ArrowRight") hasta acercarse al timestamp. Solo implementamos
// un stub defensivo; la implementación real requiere reverse engineering del cliente.

export const zoom_adapter: platform_adapter = {
  name: "zoom",
  matches: (hostname) => /(^|\.)zoom\.us$/.test(hostname),
  transcript_selector: "div[role='listitem'][data-transcript-cue]",

  parse_cue_element: (element) => {
    const start_raw = element.getAttribute("data-start-ms") ?? element.getAttribute("data-start");
    const end_raw = element.getAttribute("data-end-ms") ?? element.getAttribute("data-end");
    const speaker = element.getAttribute("data-speaker");
    const text_el = element.querySelector(".cue-text, [data-cue-text]") ?? element;
    const text = (text_el.textContent ?? "").trim();

    if (!start_raw || text.length === 0) return null;
    const t_start_ms = Number.parseInt(start_raw, 10);
    if (!Number.isFinite(t_start_ms)) return null;
    const parsed_end = end_raw ? Number.parseInt(end_raw, 10) : Number.NaN;
    const t_end_ms = Number.isFinite(parsed_end) ? parsed_end : t_start_ms + 4000;

    const c: cue = {
      t_start_ms,
      t_end_ms,
      speaker: speaker && speaker.length > 0 ? speaker : null,
      text,
      source_level: 0,
    };
    return c;
  },

  seek_to: async (_ms) => {
    // TODO (plan §4.12): hook sobre el cliente WebRTC interno de Zoom para seek preciso.
    // Fallback actual: KeyboardEvent("ArrowRight") aproxima 5s por pulsación.
    return false;
  },
};
