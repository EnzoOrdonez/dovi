// Declaraciones mínimas para `webvtt-parser` 2.x (sin types oficiales).
// Referencia: https://github.com/osk/node-webvtt / github.com/w3c/webvtt.js
declare module "webvtt-parser" {
  export interface vtt_cue_parsed {
    id?: string;
    startTime: number; // segundos
    endTime: number;
    text: string;
    [k: string]: unknown;
  }

  export interface vtt_parse_result {
    cues: vtt_cue_parsed[];
    errors: unknown[];
    styles?: unknown;
    [k: string]: unknown;
  }

  export class WebVTTParser {
    parse(input: string, mode?: "metadata" | "chapters" | "captions"): vtt_parse_result;
  }
}
