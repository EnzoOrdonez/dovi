// Dashboard DOVI — cliente vanilla (sin build step).
//
// Decisiones:
//   - Token X-DOVI-Token en localStorage (self-host single-tenant; no hay multi-usuario).
//   - Mismo origen que el backend → las llamadas son relativas (`/api/sessions`).
//   - Cero dependencias: fetch + DOM APIs nativas.
//
// Endpoints consumidos:
//   - GET  /api/sessions
//   - GET  /api/sessions/{id}

const TOKEN_KEY = "dovi_dashboard_token";

const state = {
  sessions: [],
  active_session_id: null,
};

// ---------- token ----------

function get_token() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function save_token(t) {
  localStorage.setItem(TOKEN_KEY, t);
}

// ---------- API ----------

async function api_fetch(path) {
  const token = get_token();
  const resp = await fetch(path, {
    headers: token ? { "X-DOVI-Token": token } : {},
  });
  if (!resp.ok) {
    throw new Error(`http_${resp.status}`);
  }
  return resp.json();
}

async function load_sessions() {
  set_status("Cargando sesiones…");
  try {
    state.sessions = await api_fetch("/api/sessions");
    render_session_list();
    if (state.sessions.length === 0) {
      set_status("Sin sesiones indexadas todavía.");
    } else {
      set_status(`${state.sessions.length} sesión(es).`);
    }
  } catch (err) {
    set_status(`Error: ${err.message}. Verifica el token.`, true);
  }
}

async function load_session_detail(session_id) {
  const title = document.getElementById("detail-title");
  const meta = document.getElementById("detail-meta");
  const list = document.getElementById("chunk-list");
  title.textContent = session_id;
  meta.textContent = "Cargando…";
  list.innerHTML = "";

  document.getElementById("detail-empty").classList.add("hidden");
  document.getElementById("detail-content").classList.remove("hidden");

  try {
    const detail = await api_fetch(`/api/sessions/${encodeURIComponent(session_id)}`);
    render_session_detail(detail);
  } catch (err) {
    meta.textContent = `Error: ${err.message}`;
  }
}

// ---------- render ----------

function format_hms(ms) {
  const total_s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total_s / 3600);
  const m = Math.floor((total_s % 3600) / 60);
  const s = total_s % 60;
  const rem = Math.floor(ms % 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(rem, 3)}`;
}

function render_session_list() {
  const list = document.getElementById("session-list");
  list.innerHTML = "";
  for (const s of state.sessions) {
    const li = document.createElement("li");
    li.className = "session-item";
    if (s.session_id === state.active_session_id) li.classList.add("active");

    const levels_str = (s.source_levels || []).map((l) => `L${l}`).join(" ");

    li.innerHTML = `
      <div class="session-id"></div>
      <div class="session-meta">
        <span class="session-chip">${escape_html(s.platform || "generic")}</span>
        ${escape_html(levels_str ? `<span class="session-chip">${levels_str}</span>` : "")}
        ${s.chunk_count} chunk(s) · ${format_hms(s.duration_ms)}
      </div>
    `;
    li.querySelector(".session-id").textContent = s.session_id;
    li.addEventListener("click", () => {
      state.active_session_id = s.session_id;
      render_session_list();
      void load_session_detail(s.session_id);
    });
    list.appendChild(li);
  }
}

function render_session_detail(detail) {
  const meta = document.getElementById("detail-meta");
  const list = document.getElementById("chunk-list");
  list.innerHTML = "";

  meta.textContent = `${detail.chunks.length} chunk(s)`;

  for (const c of detail.chunks) {
    const li = document.createElement("li");
    li.className = "chunk-row";

    const header = document.createElement("div");
    header.className = "chunk-header";
    const ts = document.createElement("span");
    ts.className = "chunk-ts";
    ts.textContent = `${format_hms(c.t_start_ms)} → ${format_hms(c.t_end_ms)}`;
    header.appendChild(ts);

    if (c.speaker) {
      const sp = document.createElement("span");
      sp.className = "chunk-speaker";
      sp.textContent = c.speaker;
      header.appendChild(sp);
    }

    if (c.source_level !== null && c.source_level !== undefined) {
      const lvl = document.createElement("span");
      lvl.className = "chunk-level";
      lvl.textContent = `L${c.source_level}`;
      header.appendChild(lvl);
    }

    const text = document.createElement("div");
    text.className = "chunk-text";
    text.textContent = c.text;

    li.appendChild(header);
    li.appendChild(text);
    list.appendChild(li);
  }
}

// ---------- utilidades ----------

function set_status(text, is_error = false) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = is_error ? "status error" : "status";
}

function escape_html(raw) {
  return String(raw).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

// ---------- bootstrap ----------

document.addEventListener("DOMContentLoaded", () => {
  const token_input = document.getElementById("token-input");
  token_input.value = get_token();

  document.getElementById("token-save").addEventListener("click", () => {
    save_token(token_input.value.trim());
    set_status("Token guardado. Recargando sesiones…");
    void load_sessions();
  });

  document.getElementById("refresh").addEventListener("click", () => {
    void load_sessions();
  });

  void load_sessions();
});
