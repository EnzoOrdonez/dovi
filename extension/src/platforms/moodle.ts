import type { platform_adapter } from "./registry";
import type { cue } from "@/shared/types";

// Moodle + H5P / video.js captions. Dos renderings frecuentes:
//   1. H5P: <div class="h5p-video-caption" data-start="12.345">texto</div>
//   2. video.js: <div class="vjs-text-track-cue" style="..."><span>texto</span></div>
//      → video.js NO expone timestamp en el DOM; hay que leerlo del textTrack nativo.
//      El generic adapter cubre ese caso con HTMLMediaElement.textTracks.
//
// Por tanto aquí sólo parseamos confiablemente el caso H5P. El fallback generic del
// observer cubre video.js vía `track.addEventListener("cuechange", ...)`.

export const moodle_adapter: platform_adapter = {
  name: "moodle",
  matches: (hostname) => hostname.includes("moodle") || /\.moodlecloud\.com$/.test(hostname),
  transcript_selector: ".h5p-video-caption[data-start], .vjs-text-track-cue",

  parse_cue_element: (element) => {
    const start_attr = element.getAttribute("data-start");
    const end_attr = element.getAttribute("data-end");
    const text = (element.textContent ?? "").trim();
    if (text.length === 0) return null;

    if (!start_attr) {
      // video.js cue sin data-start: no podemos fijar t_start desde el DOM.
      // Lo dejamos al generic adapter + textTracks.
      return null;
    }
    const start_sec = Number.parseFloat(start_attr);
    if (!Number.isFinite(start_sec)) return null;
    const end_sec = end_attr ? Number.parseFloat(end_attr) : Number.NaN;
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
