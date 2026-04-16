import type { platform_adapter } from "./registry";
import type { cue } from "@/shared/types";

// YouTube `ytd-transcript-segment-renderer` structure (observada 2025-2026):
//   <ytd-transcript-segment-renderer>
//     <div class="segment">
//       <div class="segment-timestamp">00:14</div>
//       <yt-formatted-string class="segment-text">texto del cue</yt-formatted-string>
//     </div>
//   </ytd-transcript-segment-renderer>
//
// Nota: YouTube no expone t_end por cue — lo aproximamos sumando +3000ms; el chunker
// backend sólo usa t_start para orden/seek, y el t_end se reajusta al combinar cues.
// Speaker: YouTube sólo lo expone cuando hay captions de autor con tag [Speaker]; no lo
// parseamos aquí.

function parse_hms_or_ms(label: string): number | null {
  // Formatos posibles: "1:23", "01:23", "1:02:03".
  const parts = label.trim().split(":").map((p) => p.trim());
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.length === 2) {
    return (nums[0] * 60 + nums[1]) * 1000;
  }
  if (nums.length === 3) {
    return ((nums[0] * 60 + nums[1]) * 60 + nums[2]) * 1000;
  }
  return null;
}

export const youtube_adapter: platform_adapter = {
  name: "youtube",
  matches: (hostname) => /(^|\.)youtube\.com$/.test(hostname) || /(^|\.)youtu\.be$/.test(hostname),
  transcript_selector: "ytd-transcript-segment-renderer",

  parse_cue_element: (element) => {
    // Preferimos un attribute dataset si existe (API futura), fallback al texto visible.
    const label_el = element.querySelector(".segment-timestamp");
    const text_el = element.querySelector(".segment-text, yt-formatted-string");
    if (!label_el || !text_el) return null;
    const t_start = parse_hms_or_ms(label_el.textContent ?? "");
    const text = (text_el.textContent ?? "").trim();
    if (t_start === null || text.length === 0) return null;
    const c: cue = {
      t_start_ms: t_start,
      t_end_ms: t_start + 3000, // placeholder; se recompone en chunker/ingest.
      speaker: null,
      text,
      source_level: 0,
    };
    return c;
  },

  ensure_transcript_visible: async () => {
    // Heurística: click en "Show transcript" si está renderizado pero el panel está cerrado.
    // El botón tiene aria-label "Show transcript" (EN) / "Mostrar transcripción" (ES).
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Show transcript"], button[aria-label="Mostrar transcripción"]',
    );
    button?.click();
  },
};
