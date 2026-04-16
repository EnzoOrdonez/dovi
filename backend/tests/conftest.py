"""Configuración global de pytest.

Establece valores mínimos de entorno ANTES de que pytest importe los módulos
de test (que a su vez importan `app.main`, el cual ejecuta `get_settings()`
en tiempo de import). Usar un fixture autouse es demasiado tarde.
"""

import os

# Fallback defensivo: si .env no estuviera disponible en el entorno de CI o en
# la raíz del monorepo, estos valores evitan que pydantic-settings falle al
# importar la app. No sobreescriben valores ya definidos en el entorno.
os.environ.setdefault("DOVI_API_KEY", "test-key")
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test")
