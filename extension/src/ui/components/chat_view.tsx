// chat_view — vista principal RAG sobre la sesión activa (plan §2.5).
//
// Contratos:
//   - UI → SW: `query_request` dispara el stream SSE (el SW deriva session_id del tab activo).
//   - SW → UI: `sse_event` broadcast con `{event, data}`. El offscreen emite directamente vía
//     `chrome.runtime.sendMessage`; el SW no re-broadcast (evita doble fire).
//   - Clic en `[[ts:HH:MM:SS.mmm|chunk_id:...]]` → `seek_request` a content script del tab
//     activo con `{session_id, t_start_ms}`.
//
// Eventos SSE reconocidos:
//   - `token` — delta de texto, se acumula en el último mensaje assistant.
//   - `done` / `close` — fin de stream, libera el flag streaming.
//   - `error` — inserta marcador `[error: …]` y libera streaming.
//   - `frame` / `manifest_request` / otros — ignorados en esta iteración (Fase 5).

import { useEffect, useRef, useState } from "preact/hooks";
import type { internal_message } from "@/shared/types";

// ---------- tipos locales ----------

interface chat_message {
  role: "user" | "assistant";
  text: string;
}

interface chat_view_props {
  session_id: string | null;
}

// ---------- parsing de referencias [[ts:...|chunk_id:...]] ----------

const TS_REFERENCE_PATTERN = /\[\[ts:([^|]+)\|chunk_id:([^\]]+)\]\]/g;

interface reference_node {
  kind: "ref";
  label: string;
  seek_ms: number;
  chunk_id: string;
}

type rendered_node = { kind: "text"; value: string } | reference_node;

// "HH:MM:SS.mmm" | "MM:SS" | "SS" → ms. Acepta decimales en el último segmento.
export function parse_hms_to_ms(raw: string): number {
  const trimmed = raw.trim();
  const [time_part, ms_part_raw = ""] = trimmed.split(".");
  const ms_part = Number.parseInt(ms_part_raw.slice(0, 3).padEnd(3, "0"), 10) || 0;
  const segments = (time_part ?? "").split(":").map((s) => Number.parseInt(s, 10));
  if (segments.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  if (segments.length === 3) {
    seconds = segments[0]! * 3600 + segments[1]! * 60 + segments[2]!;
  } else if (segments.length === 2) {
    seconds = segments[0]! * 60 + segments[1]!;
  } else if (segments.length === 1) {
    seconds = segments[0]!;
  }
  return seconds * 1000 + ms_part;
}

export function render_refs(text: string): rendered_node[] {
  const out: rendered_node[] = [];
  let cursor = 0;
  // `matchAll` requiere `g` flag (presente). Cada match: [whole, ts_str, chunk_id].
  for (const match of text.matchAll(TS_REFERENCE_PATTERN)) {
    const whole = match[0];
    const ts_str = match[1] ?? "";
    const chunk_id = match[2] ?? "";
    const start = match.index ?? 0;
    if (start > cursor) out.push({ kind: "text", value: text.slice(cursor, start) });
    out.push({
      kind: "ref",
      label: ts_str,
      seek_ms: parse_hms_to_ms(ts_str),
      chunk_id,
    });
    cursor = start + whole.length;
  }
  if (cursor < text.length) out.push({ kind: "text", value: text.slice(cursor) });
  return out;
}

// ---------- seek al tab activo ----------

async function dispatch_seek(session_id: string, t_start_ms: number): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const msg: internal_message = { type: "seek_request", session_id, t_start_ms };
  await chrome.tabs.sendMessage(tab.id, msg).catch((err: unknown) => {
    // El content script puede no estar listo (tab reload); el usuario reintenta con otro clic.
    console.warn("[DOVI] seek_request dispatch failed", err);
  });
}

// ---------- componente ----------

export function ChatView({ session_id }: chat_view_props) {
  const [messages, set_messages] = useState<chat_message[]>([]);
  const [input, set_input] = useState("");
  const [streaming, set_streaming] = useState<string | null>(null); // session_id streaming o null
  const scroll_ref = useRef<HTMLDivElement>(null);

  // Suscripción al bus runtime — recibe `sse_event` del offscreen (broadcast).
  useEffect(() => {
    const listener = (
      message: internal_message,
      _sender: chrome.runtime.MessageSender,
      _sendResponse: (r: unknown) => void,
    ): boolean => {
      if (message.type !== "sse_event") return false;
      if (message.session_id !== session_id) return false; // broadcast cross-session
      apply_sse_event(message.event, message.data, set_messages, set_streaming);
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [session_id]);

  // Auto-scroll al final cuando llegan tokens.
  useEffect(() => {
    const el = scroll_ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send_query(): Promise<void> {
    const question = input.trim();
    if (!question) return;
    if (!session_id) return;
    set_input("");
    set_messages((prev) => [
      ...prev,
      { role: "user", text: question },
      { role: "assistant", text: "" },
    ]);
    const req: internal_message = { type: "query_request", question };
    const response = (await chrome.runtime.sendMessage(req)) as
      | { ok: boolean; session_id?: string; error?: string }
      | undefined;
    if (response?.ok && response.session_id) {
      set_streaming(response.session_id);
    } else {
      const err = response?.error ?? "unknown_error";
      set_messages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = { ...last, text: `[error: ${err}]` };
        }
        return next;
      });
    }
  }

  async function cancel_query(): Promise<void> {
    if (!streaming) return;
    const req: internal_message = { type: "query_cancel", session_id: streaming };
    await chrome.runtime.sendMessage(req);
    set_streaming(null);
  }

  const disabled = session_id === null;

  return (
    <div style={styles.container}>
      {disabled && (
        <div style={styles.banner}>
          Sin sesión activa. Abre un video soportado (YouTube, Moodle, Zoom, etc.) para empezar.
        </div>
      )}

      <div ref={scroll_ref} style={styles.scroll}>
        {messages.map((m, i) => (
          <div key={i} style={m.role === "user" ? styles.msg_user : styles.msg_assistant}>
            <div style={styles.role_tag}>{m.role === "user" ? "Tú" : "DOVI"}</div>
            <div style={styles.msg_body}>
              {render_refs(m.text).map((node, j) =>
                node.kind === "text" ? (
                  <span key={j}>{node.value}</span>
                ) : (
                  <button
                    key={j}
                    type="button"
                    title={`Saltar a ${node.label} · chunk ${node.chunk_id.slice(0, 8)}`}
                    onClick={() => {
                      if (session_id) void dispatch_seek(session_id, node.seek_ms);
                    }}
                    style={styles.ref_button}
                  >
                    {node.label}
                  </button>
                ),
              )}
              {i === messages.length - 1 && streaming !== null && m.role === "assistant" && (
                <span style={styles.cursor}>▊</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={styles.input_row}>
        <textarea
          value={input}
          onInput={(e) => set_input((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send_query();
            }
          }}
          disabled={disabled}
          placeholder="Pregunta sobre el video…"
          style={styles.textarea}
          rows={2}
        />
        {streaming ? (
          <button type="button" onClick={() => void cancel_query()} style={styles.btn_cancel}>
            Cancelar
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send_query()}
            disabled={disabled || input.trim().length === 0}
            style={styles.btn_send}
          >
            Enviar
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- aplicador de eventos SSE ----------

function apply_sse_event(
  event: string,
  data: string,
  set_messages: (updater: (prev: chat_message[]) => chat_message[]) => void,
  set_streaming: (s: string | null) => void,
): void {
  switch (event) {
    case "token": {
      set_messages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = { ...last, text: last.text + data };
        }
        return next;
      });
      return;
    }
    case "done":
    case "close": {
      set_streaming(null);
      return;
    }
    case "error": {
      set_messages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = {
            ...last,
            text: `${last.text}\n[error: ${data}]`,
          };
        }
        return next;
      });
      set_streaming(null);
      return;
    }
    default: {
      // `frame`, `manifest_request`, etc. — fuera de scope en Fase 4.
      return;
    }
  }
}

// ---------- estilos (Caveman: inline, sin Tailwind) ----------

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    fontFamily: "system-ui, sans-serif",
    fontSize: 13,
    color: "#1a1a1a",
  } as const,
  banner: {
    background: "#fff6d5",
    border: "1px solid #e0c866",
    padding: "6px 10px",
    marginBottom: 8,
    borderRadius: 4,
    fontSize: 12,
  } as const,
  scroll: {
    flex: 1,
    overflowY: "auto",
    paddingRight: 4,
    marginBottom: 8,
  } as const,
  msg_user: {
    marginBottom: 10,
    padding: 8,
    background: "#eef5ff",
    borderRadius: 6,
  } as const,
  msg_assistant: {
    marginBottom: 10,
    padding: 8,
    background: "#f6f6f6",
    borderRadius: 6,
  } as const,
  role_tag: {
    fontSize: 11,
    fontWeight: 600,
    color: "#667",
    marginBottom: 2,
  } as const,
  msg_body: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.4,
    wordBreak: "break-word",
  } as const,
  ref_button: {
    display: "inline",
    padding: "1px 6px",
    margin: "0 2px",
    border: "1px solid #4a7",
    background: "#e8faf0",
    color: "#1a5a2a",
    borderRadius: 3,
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 12,
  } as const,
  cursor: {
    color: "#888",
    marginLeft: 2,
    animation: "blink 1s step-end infinite",
  } as const,
  input_row: {
    display: "flex",
    gap: 6,
    alignItems: "flex-end",
  } as const,
  textarea: {
    flex: 1,
    resize: "vertical" as const,
    fontFamily: "inherit",
    fontSize: 13,
    padding: 6,
    border: "1px solid #ccc",
    borderRadius: 4,
  },
  btn_send: {
    padding: "6px 12px",
    background: "#2a6cd6",
    color: "white",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontWeight: 600,
  } as const,
  btn_cancel: {
    padding: "6px 12px",
    background: "#c33",
    color: "white",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontWeight: 600,
  } as const,
};
