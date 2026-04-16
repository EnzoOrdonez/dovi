// settings_view — configuración local de la extensión (plan §3.4, §4.5).
//
// Toggles:
//   · `enable_local_slm` — gate del probe a Ollama. Off por defecto (opt-in explícito).
//   · `accept_level_2`   — consentimiento para MediaRecorder (plan §4.11).
//   · `backend_url` / `backend_token` — endpoint y auth single-tenant.
//
// Status del router híbrido:
//   · Al activar `enable_local_slm`, se dispara `resolve_routing()` (import directo del módulo).
//   · Botón "Re-evaluar" → `invalidate_routing_cache()` + `resolve_routing()` fresh.
//   · Indicador visual según decisión (local/remote) y modelo detectado.
//
// Nota de ejecución: `resolve_routing` corre en el contexto del sidepanel (no del SW). El
// fetch a `127.0.0.1:11434` se lanza desde esta página. Chromium puede mostrar un net-error
// en DevTools Network si Ollama no corre — no es suprimible desde extension (plan §4.5).

import { useEffect, useState } from "preact/hooks";
import {
  invalidate_routing_cache,
  resolve_routing,
  type probe_cache_entry,
} from "@/routing/hybrid_router";
import { config } from "@/shared/config";

interface stored_settings {
  enable_local_slm: boolean;
  accept_level_2: boolean;
  backend_url: string;
  backend_token: string;
}

const DEFAULT_SETTINGS: stored_settings = {
  enable_local_slm: false,
  accept_level_2: false,
  backend_url: config.backend_url_default,
  backend_token: "",
};

async function read_settings(): Promise<stored_settings> {
  const raw = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return {
    enable_local_slm: raw.enable_local_slm === true,
    accept_level_2: raw.accept_level_2 === true,
    backend_url: typeof raw.backend_url === "string" ? raw.backend_url : DEFAULT_SETTINGS.backend_url,
    backend_token:
      typeof raw.backend_token === "string" ? raw.backend_token : DEFAULT_SETTINGS.backend_token,
  };
}

async function write_settings(patch: Partial<stored_settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

export function SettingsView() {
  const [settings, set_settings] = useState<stored_settings>(DEFAULT_SETTINGS);
  const [routing, set_routing] = useState<probe_cache_entry | null>(null);
  const [probing, set_probing] = useState(false);
  const [probe_error, set_probe_error] = useState<string | null>(null);

  useEffect(() => {
    void read_settings().then(set_settings);
  }, []);

  // Cuando `enable_local_slm` cambia a true, probe automático una sola vez.
  useEffect(() => {
    if (!settings.enable_local_slm) {
      set_routing(null);
      return;
    }
    void do_probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.enable_local_slm]);

  async function do_probe(): Promise<void> {
    set_probing(true);
    set_probe_error(null);
    try {
      const result = await resolve_routing();
      set_routing(result);
    } catch (err: unknown) {
      set_probe_error(err instanceof Error ? err.message : String(err));
    } finally {
      set_probing(false);
    }
  }

  async function reprobe(): Promise<void> {
    invalidate_routing_cache();
    await do_probe();
  }

  async function update<K extends keyof stored_settings>(
    key: K,
    value: stored_settings[K],
  ): Promise<void> {
    const next = { ...settings, [key]: value };
    set_settings(next);
    await write_settings({ [key]: value });
  }

  return (
    <div style={styles.container}>
      <h4 style={styles.section_title}>Backend</h4>
      <label style={styles.label}>
        URL:
        <input
          type="text"
          value={settings.backend_url}
          onInput={(e) => void update("backend_url", (e.target as HTMLInputElement).value)}
          style={styles.input}
        />
      </label>
      <label style={styles.label}>
        API token:
        <input
          type="password"
          value={settings.backend_token}
          onInput={(e) => void update("backend_token", (e.target as HTMLInputElement).value)}
          style={styles.input}
          placeholder="X-DOVI-Token"
        />
      </label>

      <h4 style={styles.section_title}>Inferencia local (Ollama)</h4>
      <label style={styles.checkbox_label}>
        <input
          type="checkbox"
          checked={settings.enable_local_slm}
          onChange={(e) =>
            void update("enable_local_slm", (e.target as HTMLInputElement).checked)
          }
        />
        <span>Usar SLM local si está disponible (≥ 7B params)</span>
      </label>

      {settings.enable_local_slm && (
        <div style={styles.probe_panel}>
          <RoutingStatus routing={routing} probing={probing} error={probe_error} />
          <button type="button" onClick={() => void reprobe()} disabled={probing} style={styles.btn_secondary}>
            {probing ? "Sondeando…" : "Re-evaluar entorno"}
          </button>
        </div>
      )}

      <h4 style={styles.section_title}>Nivel 2 — grabación local</h4>
      <label style={styles.checkbox_label}>
        <input
          type="checkbox"
          checked={settings.accept_level_2}
          onChange={(e) =>
            void update("accept_level_2", (e.target as HTMLInputElement).checked)
          }
        />
        <span>
          Acepto que DOVI pueda grabar el audio de la pestaña cuando Niveles 0 y 1 fallen.
          <br />
          <small style={styles.small}>
            Uso responsable: verifica ToS y legalidad local (wiretapping) antes de usar en
            sesiones privadas.
          </small>
        </span>
      </label>
    </div>
  );
}

// ---------- status indicator del router ----------

function RoutingStatus({
  routing,
  probing,
  error,
}: {
  routing: probe_cache_entry | null;
  probing: boolean;
  error: string | null;
}) {
  if (error) {
    return <div style={{ ...styles.status, ...styles.status_error }}>Error: {error}</div>;
  }
  if (probing) {
    return <div style={{ ...styles.status, ...styles.status_probing }}>Sondeando puertos…</div>;
  }
  if (!routing) {
    return <div style={{ ...styles.status, ...styles.status_neutral }}>Sin sondeo aún</div>;
  }
  if (routing.decision === "local") {
    return (
      <div style={{ ...styles.status, ...styles.status_ok }}>
        ● Modelo local detectado — <code>{routing.model_detected}</code> (~
        {routing.params_billions}B params)
      </div>
    );
  }
  return (
    <div style={{ ...styles.status, ...styles.status_neutral }}>
      ○ Sin modelo local compatible (&ge; 7B). Se usará el backend remoto.
    </div>
  );
}

// ---------- estilos ----------

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    fontFamily: "system-ui, sans-serif",
    fontSize: 13,
    padding: "4px 2px",
  } as const,
  section_title: {
    margin: "8px 0 2px",
    fontSize: 13,
    color: "#333",
    borderBottom: "1px solid #e0e0e0",
    paddingBottom: 2,
  } as const,
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    fontSize: 12,
    color: "#555",
  } as const,
  checkbox_label: {
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
    fontSize: 13,
    color: "#1a1a1a",
    lineHeight: 1.35,
  } as const,
  input: {
    padding: "4px 6px",
    border: "1px solid #ccc",
    borderRadius: 3,
    fontFamily: "inherit",
    fontSize: 13,
  },
  small: {
    color: "#888",
    fontSize: 11,
  } as const,
  probe_panel: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 8,
    background: "#fafafa",
    border: "1px solid #e0e0e0",
    borderRadius: 4,
  } as const,
  btn_secondary: {
    padding: "4px 10px",
    background: "#f0f0f0",
    color: "#333",
    border: "1px solid #ccc",
    borderRadius: 3,
    cursor: "pointer",
    fontSize: 12,
    alignSelf: "flex-start",
  } as const,
  status: {
    padding: "4px 8px",
    borderRadius: 3,
    fontSize: 12,
  } as const,
  status_ok: {
    background: "#e8faf0",
    color: "#1a5a2a",
    border: "1px solid #8bc798",
  } as const,
  status_neutral: {
    background: "#f0f0f0",
    color: "#555",
    border: "1px solid #ccc",
  } as const,
  status_probing: {
    background: "#eef5ff",
    color: "#2a4a8a",
    border: "1px solid #9bb9d8",
  } as const,
  status_error: {
    background: "#faeaea",
    color: "#8a1a1a",
    border: "1px solid #d88a8a",
  } as const,
};
