// Resuelve el adapter correcto por hostname (plan §2.2).
// Nuevos adapters: añadir al array `adapters` y exportar.

import { youtube_adapter } from "./youtube";
import { zoom_adapter } from "./zoom";
import { moodle_adapter } from "./moodle";
import { canvas_adapter } from "./canvas";
import { loom_adapter } from "./loom";
import { vimeo_adapter } from "./vimeo";
import { generic_adapter } from "./generic";
import type { cue } from "@/shared/types";

export interface platform_adapter {
  name: string;
  matches: (hostname: string) => boolean;

  // Selectores CSS a observar con MutationObserver (Nivel 0).
  transcript_selector: string;

  // Parsea un elemento del DOM matcheado a `cue`. Null si el elemento no es un cue válido.
  parse_cue_element: (element: Element) => cue | null;

  // Opcional: control del reproductor cuando video.currentTime no basta (ej. Zoom WebRTC).
  seek_to?: (ms: number) => Promise<boolean>;

  // Opcional: click-to-open de panel de transcripción (ej. YouTube "mostrar transcripción").
  ensure_transcript_visible?: () => Promise<void>;
}

const adapters: readonly platform_adapter[] = [
  youtube_adapter,
  zoom_adapter,
  moodle_adapter,
  canvas_adapter,
  loom_adapter,
  vimeo_adapter,
  generic_adapter, // MUST be last (catch-all).
];

export function resolve_adapter(hostname: string): platform_adapter {
  for (const adapter of adapters) {
    if (adapter.matches(hostname)) return adapter;
  }
  return generic_adapter;
}
