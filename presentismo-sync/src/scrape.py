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

Confirmado en una corrida real (2026-08-21, GitHub Actions): con
Camoufox el portal deja pasar sin mostrar ningún challenge — Scrapling
loguea "ERROR: No Cloudflare challenge found" en ese caso, pero es
informativo, no un fallo (`solve_cloudflare` busca un challenge para
resolverlo y simplemente no encontró ninguno esa vez).
"""

from __future__ import annotations

import datetime as dt
import re
from pathlib import Path
from random import randint

from scrapling.fetchers import StealthyFetcher

BASE_URL = "https://www.controltienda.com/proveedor_server"

# Mismo patrón que usa Scrapling internamente para ubicar el iframe del
# challenge de Cloudflare (`__CF_PATTERN__` en
# scrapling/engines/_browsers/_stealth.py).
_CF_IFRAME_PATTERN = re.compile(r"^https?://challenges\.cloudflare\.com/cdn-cgi/challenge-platform/.*")


def _click_turnstile_si_aparece(page, captura, *, intentos_espera: int = 20) -> bool:
    """Busca el iframe de Cloudflare Turnstile y clickea su checkbox si
    aparece. Devuelve True si encontró y clickeó uno, False si no apareció
    ninguno en el tiempo de espera (~10s con `intentos_espera=20`).

    Confirmado leyendo el código fuente de Scrapling instalado
    (`scrapling/engines/_browsers/_stealth.py`, `_cloudflare_solver` /
    `StealthySession.fetch`): `solve_cloudflare=True` solo corre ese
    solver UNA VEZ, inmediatamente después de la navegación inicial a
    `login.php` y ANTES de ejecutar nuestro `page_action` — nunca se
    vuelve a invocar durante `page_action`. Este portal en particular no
    muestra ningún challenge en la carga inicial (confirmado en
    `01_login_page` de los pantallazos: formulario limpio), sino que
    dispara un Turnstile recién al hacer submit del login (visto en
    `02_despues_click_login`: banner "Verificación de seguridad fallida"
    seguido del checkbox "Verify you are human" en
    `03_timeout_esperando_index` — momento en el que `solve_cloudflare`
    ya terminó de correr y no vuelve a intervenir. Por eso hace falta
    resolverlo a mano acá, replicando la misma técnica de click
    coordinado sobre el iframe (bounding box + click con offset
    aleatorio) que usa Scrapling para el challenge inicial."""
    iframe = None
    for _ in range(intentos_espera):
        iframe = page.frame(url=_CF_IFRAME_PATTERN)
        if iframe is not None:
            break
        page.wait_for_timeout(500)
    if iframe is None:
        return False

    frame_element = iframe.frame_element()
    box = frame_element.bounding_box()
    if not box:
        return False

    x = box["x"] + randint(26, 28)
    y = box["y"] + randint(25, 27)
    page.mouse.click(x, y, delay=randint(100, 200), button="left")
    captura(page, "turnstile_clickeado")
    page.wait_for_timeout(1000)
    return True


def scrape_presentismo_export(*, fecha_ff: dt.date, frax_user: str, frax_pass: str, download_dir: Path) -> Path:
    """Loguea, filtra el rango de fechas y descarga el Excel de "Detalle de
    marcas". `fecha_ff` es la fecha que queda en el campo "hasta" (se deja
    tal cual la trae el portal si no se toca; acá se pasa explícita para
    que quede logueada). El campo "desde" siempre es el día anterior a
    `fecha_ff`, a pedido explícito del usuario."""
    download_dir.mkdir(parents=True, exist_ok=True)
    fecha_fi = fecha_ff - dt.timedelta(days=1)

    screenshots_dir = download_dir / "screenshots"
    screenshots_dir.mkdir(parents=True, exist_ok=True)

    def captura(page, paso: str) -> None:
        """Pantallazo de diagnóstico best-effort (nunca rompe el flujo si
        falla, ej. página ya cerrada) — para poder ver en qué paso exacto
        quedó el portal cuando el bot falla (challenge de Cloudflare,
        cambio de layout, etc.), ya que en GitHub Actions no hay forma de
        mirar la pantalla en vivo."""
        try:
            ts = dt.datetime.now(dt.timezone.utc).strftime("%H%M%S")
            page.screenshot(path=str(screenshots_dir / f"{ts}_{paso}.png"), full_page=True)
        except Exception as err:  # noqa: BLE001
            print(f"No se pudo capturar pantallazo ({paso}): {err}")

    downloaded_path: dict[str, Path] = {}

    def interactuar(page):
        try:
            _interactuar_paso(page, captura, downloaded_path, frax_user=frax_user, frax_pass=frax_pass, fecha_fi=fecha_fi, download_dir=download_dir)
        except Exception:
            captura(page, "error_fatal")
            raise
        return page

    StealthyFetcher.fetch(
        f"{BASE_URL}/login.php",
        headless=True,
        solve_cloudflare=True,
        # Los waits explícitos de arriba (wait_for_url/wait_for_selector/
        # wait_for_timeout) ya cubren cada paso — esperar además a
        # "networkidle" en cada navegación solo suma tiempo muerto
        # (trackers/pixels de terceros que nunca terminan de cargar).
        network_idle=False,
        page_action=interactuar,
    )

    if "path" not in downloaded_path:
        raise RuntimeError("El flujo terminó sin descargar el archivo (page_action no llegó a exportar).")
    return downloaded_path["path"]


def _interactuar_paso(page, captura, downloaded_path, *, frax_user: str, frax_pass: str, fecha_fi: dt.date, download_dir: Path) -> None:
    page.goto(f"{BASE_URL}/login.php")
    captura(page, "01_login_page")

    # El formulario trae un campo señuelo (#usuario_v2 — 0x0 vía CSS
    # pero no display:none, autocomplete="username") además del real
    # (#usuario, autocomplete="organization"): un honeypot anti-bot
    # confirmado inspeccionando el DOM en vivo. Llenamos por selector
    # específico, nunca lo tocamos, igual que un usuario real.
    page.fill("#usuario", frax_user)
    page.fill("#clave", frax_pass)
    page.click("button.btn-login")
    captura(page, "02_despues_click_login")

    # El submit del login dispara acá (no en la carga inicial de
    # login.php) un Turnstile embebido que `solve_cloudflare=True` no
    # cubre — ver el docstring de `_click_turnstile_si_aparece` para el
    # detalle. Confirmado con pantallazos de una corrida real: cuando la
    # verificación falla, el portal recarga `login.php?error=captcha` —
    # una página "fresca" que resetea el formulario — y muestra el
    # checkbox de Turnstile recién ahí. Resolverlo no alcanza: hay que
    # volver a llenar RUT/clave (se perdieron con el reload) y reintentar
    # el submit, por eso el reintento cubre el ciclo completo, no solo el
    # click al checkbox.
    max_intentos_turnstile = 3
    for intento in range(1, max_intentos_turnstile + 1):
        try:
            page.wait_for_url("**/index.php**", timeout=15000)
            break
        except Exception:
            if intento == max_intentos_turnstile:
                captura(page, "03_timeout_esperando_index")
                raise
            captura(page, f"03_turnstile_intento_{intento}")
            if _click_turnstile_si_aparece(page, captura):
                page.fill("#usuario", frax_user)
                page.fill("#clave", frax_pass)
                page.click("button.btn-login")
                captura(page, f"03b_reintento_login_{intento}")
    captura(page, "03_index_ok")

    # Aviso de "cuenta con pago pendiente" — no está confirmado que
    # aparezca siempre, por eso timeout corto y sin bloquear el flujo.
    cerrar_impago = page.locator("#btnCerrarImpago")
    try:
        if cerrar_impago.is_visible(timeout=5000):
            cerrar_impago.click()
            page.wait_for_timeout(300)
            captura(page, "04_despues_cerrar_impago")
    except Exception:
        pass

    page.goto(f"{BASE_URL}/reportes/")
    try:
        page.wait_for_selector("#btn-export-detalle", timeout=20000)
    except Exception:
        captura(page, "05_timeout_esperando_reportes")
        raise
    captura(page, "05_reportes_ok")

    # Inputs type=date nativos (value YYYY-MM-DD) — sin overlay de
    # calendario que cerrar. "hasta" (#f-ff) se deja tal cual lo trae
    # el portal por default (hoy), a pedido explícito: no se toca.
    page.fill("#f-fi", fecha_fi.isoformat())
    page.click("#btn-aplicar")

    # La tabla "Detalle de marcas" se recarga vía AJAX (DataTables
    # server-side) — no hay selector confiable de "listo".
    page.wait_for_timeout(3000)
    captura(page, "06_antes_exportar")

    file_path = download_dir / f"presentismo-{fecha_fi.isoformat()}_{fecha_ff.isoformat()}.xlsx"
    try:
        with page.expect_download() as download_info:
            page.click("#btn-export-detalle")
        download = download_info.value
        download.save_as(str(file_path))
    except Exception:
        captura(page, "07_error_exportar")
        raise
    downloaded_path["path"] = file_path

    # Scrapling intenta leer el contenido final de la página después de
    # que `page_action` termina, para armar su objeto Response — como
    # acá ya navegamos varias veces (login.php -> index.php ->
    # reportes/) y la última acción fue una descarga (no una
    # navegación normal), esa lectura fallaba con "Protocol error...
    # Response body is not available" (no rompe el flujo, pero ensucia
    # el log). Dejar la página en un estado neutro y quieto antes de
    # devolverla evita esa lectura fallida.
    page.goto("about:blank")
