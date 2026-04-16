// Sidepanel — entrypoint de la UI principal de DOVI.
//
// Composición:
//   · Tab "Chat" → `ChatView` (consulta RAG sobre la sesión activa, render de refs temporales).
//   · Tab "Ajustes" → `SettingsView` (toggle Ollama local, backend URL/token, consentimiento Nivel 2).
//
// Tracking de sesión:
//   · Al montar, pregunta al SW `get_tab_session` para el tab activo.
//   · Re-consulta en `chrome.tabs.onActivated` (usuario cambia de pestaña con el panel abierto).
//   · La ausencia de sesión no bloquea el panel — sólo deshabilita el envío de preguntas.

import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { internal_message } from "@/shared/types";
import { ChatView } from "@/ui/components/chat_view";
import { SettingsView } from "@/ui/components/settings_view";

type tab_key = "chat" | "settings";

function SidePanel() {
  const [active_tab, set_active_tab] = useState<tab_key>("chat");
  const [session_id, set_session_id] = useState<string | null>(null);

  const refresh_session = useCallback(async (): Promise<void> => {
    const req: internal_message = { type: "get_tab_session" };
    const response = (await chrome.runtime.sendMessage(req)) as
      | { ok: true; session_id: string | null }
      | { ok: false; error: string }
      | undefined;
    if (response && "session_id" in response && response.ok) {
      set_session_id(response.session_id);
    } else {
      set_session_id(null);
    }
  }, []);

  useEffect(() => {
    void refresh_session();
    const on_activated = (): void => {
      void refresh_session();
    };
    const on_updated = (
      _tab_id: number,
      info: chrome.tabs.TabChangeInfo,
      _tab: chrome.tabs.Tab,
    ): void => {
      // Re-consultar sólo cuando la URL cambia (commit de navegación).
      if (info.status === "complete" || info.url !== undefined) {
        void refresh_session();
      }
    };
    chrome.tabs.onActivated.addListener(on_activated);
    chrome.tabs.onUpdated.addListener(on_updated);
    return () => {
      chrome.tabs.onActivated.removeListener(on_activated);
      chrome.tabs.onUpdated.removeListener(on_updated);
    };
  }, [refresh_session]);

  return (
    <div style={styles.root}>
      <Header session_id={session_id} onRefresh={() => void refresh_session()} />
      <nav style={styles.tab_bar}>
        <TabButton active={active_tab === "chat"} onClick={() => set_active_tab("chat")}>
          Chat
        </TabButton>
        <TabButton active={active_tab === "settings"} onClick={() => set_active_tab("settings")}>
          Ajustes
        </TabButton>
      </nav>

      <main style={styles.main}>
        {active_tab === "chat" ? <ChatView session_id={session_id} /> : <SettingsView />}
      </main>
    </div>
  );
}

// ---------- subcomponentes ----------

function Header({
  session_id,
  onRefresh,
}: {
  session_id: string | null;
  onRefresh: () => void;
}) {
  const indicator = session_id ? (
    <span style={styles.session_ok}>● activa · {session_id.slice(0, 8)}</span>
  ) : (
    <span style={styles.session_none}>○ sin sesión</span>
  );
  return (
    <header style={styles.header}>
      <div style={styles.title}>DOVI</div>
      <div style={styles.session_row}>
        {indicator}
        <button type="button" onClick={onRefresh} style={styles.refresh_btn} title="Refrescar sesión">
          ↻
        </button>
      </div>
    </header>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: preact.ComponentChildren;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={active ? { ...styles.tab, ...styles.tab_active } : styles.tab}
    >
      {children}
    </button>
  );
}

// ---------- estilos ----------

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    fontFamily: "system-ui, sans-serif",
    color: "#1a1a1a",
    background: "#fff",
  } as const,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: "1px solid #e0e0e0",
    background: "#fafafa",
  } as const,
  title: {
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: 0.3,
  } as const,
  session_row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
  } as const,
  session_ok: {
    color: "#1a5a2a",
    fontFamily: "monospace",
  } as const,
  session_none: {
    color: "#888",
  } as const,
  refresh_btn: {
    background: "transparent",
    border: "1px solid #ccc",
    borderRadius: 3,
    width: 22,
    height: 22,
    cursor: "pointer",
    fontSize: 13,
    lineHeight: 1,
    padding: 0,
  } as const,
  tab_bar: {
    display: "flex",
    borderBottom: "1px solid #e0e0e0",
    background: "#fff",
  } as const,
  tab: {
    flex: 1,
    padding: "8px 0",
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    cursor: "pointer",
    fontSize: 13,
    color: "#555",
    fontWeight: 500,
  } as const,
  tab_active: {
    borderBottom: "2px solid #2a6cd6",
    color: "#2a6cd6",
  } as const,
  main: {
    flex: 1,
    overflow: "hidden",
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
  } as const,
};

render(<SidePanel />, document.getElementById("root")!);
