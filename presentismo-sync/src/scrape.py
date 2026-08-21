"""Descarga el Excel de "Detalle de marcas" del portal APE2 (Frax).

Puerto a Python/Scrapling del bot Node/Playwright que existió hasta
2026-08-21 (ver git log de este repo: "Eliminar presentismo-sync").
Se eliminó porque controltienda.com está detrás de Cloudflare y bloquea a
Chromium headless y a Chrome headed corriendo desde una IP de datacenter
(GitHub Actions) con un checkbox Turnstile no resoluble por automatización
normal — solo funcionaba con Chrome real desde una IP residencial.

Este puerto usa `StealthyFetcher` (Camoufox) de Scrapling con
`solve_cloudflare=True`, que automatiza específicamente el resuelto de
Turnstile — algo que Playwright liso no hacía. Sigue sin garantía: si el
portal escala a un challenge que Camoufox tampoco resuelve, esta función
lanza una excepción como cualquier otro fallo y el intento se reintenta
(ver sync.py).

Selectores DOM confirmados contra el portal real en la versión anterior
(commit 7e72463 y ba860d8 de este mismo repo) — no adivinados.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from scrapling.fetchers import StealthyFetcher

BASE_URL = "https://www.controltienda.com/proveedor_server"


def scrape_presentismo_export(*, fecha_ff: dt.date, frax_user: str, frax_pass: str, download_dir: Path) -> Path:
    """Loguea, filtra el rango de fechas y descarga el Excel de "Detalle de
    marcas". `fecha_ff` es la fecha que queda en el campo "hasta" (se deja
    tal cual la trae el portal si no se toca; acá se pasa explícita para
    que quede logueada). El campo "desde" siempre es el día anterior a
    `fecha_ff`, a pedido explícito del usuario."""
    download_dir.mkdir(parents=True, exist_ok=True)
    fecha_fi = fecha_ff - dt.timedelta(days=1)

    downloaded_path: dict[str, Path] = {}

    def interactuar(page):
        page.goto(f"{BASE_URL}/login.php")

        # El formulario trae un campo señuelo (#usuario_v2 — 0x0 vía CSS
        # pero no display:none, autocomplete="username") además del real
        # (#usuario, autocomplete="organization"): un honeypot anti-bot
        # confirmado inspeccionando el DOM en vivo. Llenamos por selector
        # específico, nunca lo tocamos, igual que un usuario real.
        page.fill("#usuario", frax_user)
        page.fill("#clave", frax_pass)
        page.click("button.btn-login")

        # Timeout largo: el desafío de Cloudflare puede tardar antes de
        # redirigir, aun con solve_cloudflare=True resolviéndolo.
        page.wait_for_url("**/index.php**", timeout=45000)

        # Aviso de "cuenta con pago pendiente" — no está confirmado que
        # aparezca siempre, por eso timeout corto y sin bloquear el flujo.
        cerrar_impago = page.locator("#btnCerrarImpago")
        try:
            if cerrar_impago.is_visible(timeout=5000):
                cerrar_impago.click()
                page.wait_for_timeout(300)
        except Exception:
            pass

        page.goto(f"{BASE_URL}/reportes/")
        page.wait_for_selector("#btn-export-detalle", timeout=20000)

        # Inputs type=date nativos (value YYYY-MM-DD) — sin overlay de
        # calendario que cerrar. "hasta" (#f-ff) se deja tal cual lo trae
        # el portal por default (hoy), a pedido explícito: no se toca.
        page.fill("#f-fi", fecha_fi.isoformat())
        page.click("#btn-aplicar")

        # La tabla "Detalle de marcas" se recarga vía AJAX (DataTables
        # server-side) — no hay selector confiable de "listo".
        page.wait_for_timeout(3000)

        file_path = download_dir / f"presentismo-{fecha_fi.isoformat()}_{fecha_ff.isoformat()}.xlsx"
        with page.expect_download() as download_info:
            page.click("#btn-export-detalle")
        download = download_info.value
        download.save_as(str(file_path))
        downloaded_path["path"] = file_path

        return page

    StealthyFetcher.fetch(
        f"{BASE_URL}/login.php",
        headless=True,
        solve_cloudflare=True,
        network_idle=True,
        page_action=interactuar,
    )

    if "path" not in downloaded_path:
        raise RuntimeError("El flujo terminó sin descargar el archivo (page_action no llegó a exportar).")
    return downloaded_path["path"]
