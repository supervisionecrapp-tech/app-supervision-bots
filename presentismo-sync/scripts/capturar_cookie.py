"""Genera la cookie de sesión que usa el bot para saltearse el login, y la
guarda en Supabase (`bot_config`, key='frax_session_cookie').

Correr esto desde una máquina de confianza (una IP chilena normal), donde
Cloudflare sí emite el token de Turnstile. Desde los runners de GitHub no
se consigue — de ahí que exista este camino.

    cd presentismo-sync
    python scripts/capturar_cookie.py

Lee FRAX_USER, FRAX_PASS y SUPABASE_SERVICE_ROLE_KEY de .env.local.

`bot_config` es el mismo lugar que lee presentismo-sync (src/sync.py) y que
mantiene viva la Edge Function `presentismo-keepalive` (pg_cron cada 10
min) — un solo lugar, no un secret de GitHub aparte que se puede
desincronizar. Si la sesión igual expira (falla el keepalive, o FRAX
invalida por otro motivo), el bot lo dice con un mensaje claro y hay que
volver a correr esto.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BOT / "src"))

from scrapling.fetchers import StealthySession  # noqa: E402
from supabase import create_client  # noqa: E402

from scrape import BASE_URL, _esperar_token, _tipear  # noqa: E402


def cargar_env_local() -> None:
    env_file = BOT / ".env.local"
    if not env_file.is_file():
        return
    for linea in env_file.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if linea and not linea.startswith("#") and "=" in linea:
            clave, _, valor = linea.partition("=")
            os.environ.setdefault(clave.strip(), valor.strip().strip('"').strip("'"))


def main() -> None:
    cargar_env_local()
    usuario = os.environ.get("FRAX_USER")
    clave = os.environ.get("FRAX_PASS")
    supabase_url = os.environ.get("SUPABASE_URL", "https://lbwwnrsbgaxjulpfbwdz.supabase.co")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not usuario or not clave:
        raise SystemExit("Faltan FRAX_USER / FRAX_PASS (ponelos en .env.local).")
    if not supabase_key:
        raise SystemExit("Falta SUPABASE_SERVICE_ROLE_KEY (ponela en .env.local).")

    capturado: dict[str, str] = {}

    def loguear(page):
        page.wait_for_selector("#usuario", timeout=30000)
        if not _esperar_token(page, segundos=40):
            print("Turnstile no entregó token. Volvé a correr el script.")
            return page
        _tipear(page, "#usuario", usuario)
        _tipear(page, "#clave", clave)
        page.click("button.btn-login")
        page.wait_for_url("**/index.php**", timeout=25000)
        for cookie in page.context.cookies():
            if cookie["name"] == "PHPSESSID":
                capturado["phpsessid"] = cookie["value"]
        return page

    with StealthySession(
        headless=False,
        real_chrome=True,
        locale="es-CL",
        timezone_id="America/Santiago",
        solve_cloudflare=True,
        timeout=150000,
        network_idle=False,
    ) as session:
        session.fetch(f"{BASE_URL}/login.php", page_action=loguear)

    if "phpsessid" not in capturado:
        raise SystemExit("No se pudo loguear; volvé a intentar.")

    supabase = create_client(supabase_url, supabase_key)
    supabase.table("bot_config").upsert(
        {"key": "frax_session_cookie", "value": capturado["phpsessid"]}
    ).execute()
    print("Cookie guardada en Supabase (bot_config.frax_session_cookie). Listo.")


if __name__ == "__main__":
    main()
