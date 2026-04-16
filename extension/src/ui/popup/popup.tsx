// Popup UI — settings mínimos (plan §3.4 opt-in local SLM, §4.11 disclaimer Nivel 2).
// Preact para bundle <15kB.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

function Popup() {
  const [enable_local_slm, set_enable_local_slm] = useState(false);
  const [accept_level_2, set_accept_level_2] = useState(false);
  const [backend_url, set_backend_url] = useState("http://localhost:8000");

  useEffect(() => {
    void chrome.storage.local
      .get(["enable_local_slm", "accept_level_2", "backend_url"])
      .then((result) => {
        set_enable_local_slm(result.enable_local_slm === true);
        set_accept_level_2(result.accept_level_2 === true);
        set_backend_url(result.backend_url ?? "http://localhost:8000");
      });
  }, []);

  async function save() {
    await chrome.storage.local.set({ enable_local_slm, accept_level_2, backend_url });
    window.close();
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 12, width: 320 }}>
      <h3 style={{ marginTop: 0 }}>DOVI</h3>

      <label style={{ display: "block", marginBottom: 8 }}>
        Backend URL:
        <input
          type="text"
          value={backend_url}
          onInput={(e) => set_backend_url((e.target as HTMLInputElement).value)}
          style={{ width: "100%", marginTop: 4 }}
        />
      </label>

      <label style={{ display: "block", marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={enable_local_slm}
          onChange={(e) => set_enable_local_slm((e.target as HTMLInputElement).checked)}
        />{" "}
        Usar SLM local si está disponible (Ollama)
      </label>

      <label style={{ display: "block", marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={accept_level_2}
          onChange={(e) => set_accept_level_2((e.target as HTMLInputElement).checked)}
        />{" "}
        Acepto grabación local de audio (Nivel 2)
      </label>

      <button onClick={() => void save()} style={{ marginTop: 8 }}>
        Guardar
      </button>
    </div>
  );
}

render(<Popup />, document.getElementById("root")!);
