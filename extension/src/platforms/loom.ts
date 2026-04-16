import type { platform_adapter } from "./registry";
import type { cue } from "@/shared/types";

// Loom.com: la transcripción se entrega vía VTT accesible (Nivel 1 dominará).
// El panel de UI expone cues con `data-test="transcript-cue"` y timestamps en
// data attributes según la versión de la app. Patrón 2025+:
//   <div data-test="transcript-cue" data-start-ms="12345" data-end-ms="13500">
//     <button class="cue-timestamp">0:12</button>
//     <p class="cue-text">texto</p>
//   </div>

export const loom_adapter: platform_adapter = {
  name: "loom",
  matches: (hostname) => /(^|\.)loom\.com$/.test(hostname),
  transcript_selector: "[data-test='transcript-cue']",

  parse_cue_element: (element) => {
    const start_raw = element.getAttribute("data-start-ms") ?? element.getAttribute("data-start");
    const end_raw = element.getAttribute("data-end-ms") ?? element.getAttribute("data-end");
    const text_el = element.querySelector(".cue-text, p") ?? element;
    const text = (text_el.textContent ?? "").trim();
    if (!start_raw || text.length === 0) return null;
    const t_start_ms = Number.parseInt(start_raw, 10);
    if (!Number.isFinite(t_start_ms)) return null;
    const parsed_end = end_raw ? Number.parseInt(end_raw, 10) : Number.NaN;
    const t_end_ms = Number.isFinite(parsed_end) ? parsed_end : t_start_ms + 4000;
    const c: cue = {
      t_start_ms,
      t_end_ms,
      speaker: null,
      text,
      source_level: 0,
    };
    return c;
  },
};
