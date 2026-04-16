import type { platform_adapter } from "./registry";
import type { cue } from "@/shared/types";

// Generic catch-all: cubre cualquier sitio con
//   a) atributos data-timestamp / data-cue-start (en segundos o ms).
//   b) HTML5 <track kind="captions">: este caso lo maneja `mutation_observer.bind_html5_text_tracks`
//      vía `cuechange` del <video>.textTracks directamente — no vamos a duplicarlo aquí.
//
// Heurística de unidad: si el valor numérico es <10_000 lo interpretamos como segundos
// (la mayoría de data-timestamps siguen esa convención); si ≥10_000 asumimos ms.

function parse_numeric_timestamp(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n < 10_000 ? Math.round(n * 1000) : Math.round(n);
}

export const generic_adapter: platform_adapter = {
  name: "generic",
  matches: () => true,
  transcript_selector: "[data-timestamp], [data-cue-start], [data-start-time]",

  parse_cue_element: (element) => {
    const raw =
      element.getAttribute("data-timestamp") ??
      element.getAttribute("data-cue-start") ??
      element.getAttribute("data-start-time");
    const text = (element.textContent ?? "").trim();
    const t_start_ms = parse_numeric_timestamp(raw);
    if (t_start_ms === null || text.length === 0) return null;
    const t_end_raw =
      element.getAttribute("data-cue-end") ??
      element.getAttribute("data-end-time") ??
      element.getAttribute("data-end");
    const parsed_end = parse_numeric_timestamp(t_end_raw);
    const c: cue = {
      t_start_ms,
      t_end_ms: parsed_end ?? t_start_ms + 4000,
      speaker: null,
      text,
      source_level: 0,
    };
    return c;
  },
};
