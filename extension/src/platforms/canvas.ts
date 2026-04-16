import type { platform_adapter } from "./registry";
import type { cue } from "@/shared/types";

// Canvas LMS (instructure.com): los videos suelen renderizarse con el reproductor
// interno Studio o Kaltura/embed. Pattern observado:
//   <div data-cue-id="c_123" data-start-time="12.5" data-end-time="15.0">texto</div>
// Algunos tenants usan `data-cue-start` (segundos) en lugar de `data-start-time`.

export const canvas_adapter: platform_adapter = {
  name: "canvas",
  matches: (hostname) => /\.instructure\.com$/.test(hostname),
  transcript_selector: "[data-cue-id], [data-cue-start]",

  parse_cue_element: (element) => {
    const start_raw =
      element.getAttribute("data-start-time") ??
      element.getAttribute("data-cue-start") ??
      element.getAttribute("data-start");
    const end_raw = element.getAttribute("data-end-time") ?? element.getAttribute("data-end");
    const text = (element.textContent ?? "").trim();
    if (!start_raw || text.length === 0) return null;
    const start_sec = Number.parseFloat(start_raw);
    if (!Number.isFinite(start_sec)) return null;
    const end_sec = end_raw ? Number.parseFloat(end_raw) : Number.NaN;
    const t_start_ms = Math.round(start_sec * 1000);
    const t_end_ms = Number.isFinite(end_sec) ? Math.round(end_sec * 1000) : t_start_ms + 4000;
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
