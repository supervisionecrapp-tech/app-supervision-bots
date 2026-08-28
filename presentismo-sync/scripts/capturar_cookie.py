"""Genera la cookie de sesión que usa el bot para saltearse el login.

Correr esto desde una máquina de confianza (una IP chilena normal), donde
Cloudflare sí emite el token de Turnstile. Desde los runners de GitHub no
se consigue — de ahí que exista este camino.

    cd presentismo-sync && python scripts/capturar_cookie.py

Lee FRAX_USER y FRAX_PASS de .env.local. Imprime el valor de PHPSESSID,
que hay que guardar como secret del repo:

    gh secret set FRAX_SESSION_COOKIE --repo StarCrushed/app-supervision-bots

Mientras ese secret esté puesto, el bot entra directo a /reportes/ y no
toca el formulario de login. Si la sesión expira, el bot falla con un
mensaje claro y hay que volver a correr esto.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BOT / "src"))

from scrapling.fetchers import StealthySession  # noqa: E402

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
    if not usuario or not clave:
        raise SystemExit("Faltan FRAX_USER / FRAX_PASS (ponelos en .env.local).")

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

    print("\nPHPSESSID capturado. Guardalo como secret del repo:\n")
    print(f"  {capturado['phpsessid']}\n")
    print("  gh secret set FRAX_SESSION_COOKIE --repo StarCrushed/app-supervision-bots")


if __name__ == "__main__":
    main()
