"""Descarga el Excel de "Detalle de marcas" del portal APE2 (Frax).

Puerto a Python/Scrapling del bot Node/Playwright que existió hasta
2026-08-21 (ver git log de este repo: "Eliminar presentismo-sync").

Usa `StealthyFetcher` de Scrapling (Chromium/Chrome vía Patchright, NO
Camoufox pese a lo que decía una versión vieja de este comentario —
confirmado leyendo el código fuente instalado de scrapling 0.4.15) con
`solve_cloudflare=True`. Ese solver resuelve el challenge de la carga
inicial de `login.php`, pero corre UNA sola vez, antes de nuestro
`page_action` — no cubre el Turnstile embebido que este portal dispara
recién al hacer submit del login (ver `_click_turnstile_si_aparece`).

Diseño "flexible" (a pedido del usuario, tras varias corridas de
diagnóstico con pantallazos):
1. Login normal, tipeando RUT/clave con delay (no `page.fill()`, que no
   dispara eventos de teclado reales).
2. Si el submit es rechazado, se asume que escaló a modo interactivo:
   clickear el checkbox de Turnstile si aparece, volver a llenar
   RUT/clave (se pierden con el reload que dispara el propio submit
   fallido) y reintentar el submit una vez, dentro de la misma sesión.
3. Si eso también falla, la función tira una excepción y listo — el
   reintento real pasa a `with_retries()` en sync.py, con un browser
   100% nuevo y espera EXPONENCIAL entre intentos (no lineal): confirmado
   a mano por el usuario que golpear el login muchas veces seguidas
   desde la misma IP hace que el portal escale el challenge cada vez más
   rápido, y Scrapling documenta el mismo criterio para su AutoThrottle
   (`autothrottle_block_backoff`): cualquier respuesta bloqueada DUPLICA
   el delay en vez de un incremento fijo, para no seguir alimentando esa
   escalada.

Selectores DOM confirmados contra el portal real en la versión anterior
(commit 7e72463 y ba860d8 de este mismo repo) — no adivinados.
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


def _tipear(page, selector: str, texto: str) -> None:
    """Tipea carácter por carácter con delay variable, en vez de
    `page.fill()` (que carga el valor directo por CDP sin disparar
    eventos de teclado reales) — a pedido del usuario, buscando que el
    login se vea más humano ante el chequeo de riesgo de Cloudflare."""
    page.locator(selector).press_sequentially(texto, delay=randint(60, 140))


def _click_turnstile_si_aparece(page, captura, *, intentos_espera: int = 20) -> bool:
    """Busca el iframe de Cloudflare Turnstile y clickea su checkbox si
    aparece. Devuelve True si encontró y clickeó uno. Sin esto el
    checkbox se queda sin marcar para siempre (confirmado en los
    pantallazos de varias corridas: "Verify you are human" nunca
    tildado) y el submit no tiene forma de pasar."""
    iframe = None
    for _ in range(intentos_espera):
        iframe = page.frame(url=_CF_IFRAME_PATTERN)
        if iframe is not None:
            break
        page.wait_for_timeout(500)
    if iframe is None:
        return False

    box = iframe.frame_element().bounding_box()
    if not box:
        return False

    x = box["x"] + randint(26, 28)
    y = box["y"] + randint(25, 27)
    page.mouse.click(x, y, delay=randint(100, 200), button="left")
    captura(page, "turnstile_clickeado")

    # Esperar el input oculto cf-turnstile-response (el token que el
    # formulario necesita al reenviar) en vez de un wait fijo corto —
    # confirmado en el run 33112307497 que reenviar apenas se ve el
    # check marcado, sin el token listo, repite el mismo fallo.
    token_input = page.locator('input[name="cf-turnstile-response"]')
    for _ in range(16):
        try:
            if token_input.count() > 0 and (token_input.first.input_value() or "").strip():
                break
        except Exception:
            pass
        page.wait_for_timeout(500)
    captura(page, "turnstile_token_listo")
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
            _interactuar_paso(page, captura, downloaded_path, frax_user=frax_user, frax_pass=frax_pass, fecha_fi=fecha_fi, fecha_ff=fecha_ff, download_dir=download_dir)
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


def _interactuar_paso(page, captura, downloaded_path, *, frax_user: str, frax_pass: str, fecha_fi: dt.date, fecha_ff: dt.date, download_dir: Path) -> None:
    page.goto(f"{BASE_URL}/login.php")
    captura(page, "01_login_page")

    # El formulario trae un campo señuelo (#usuario_v2 — 0x0 vía CSS
    # pero no display:none, autocomplete="username") además del real
    # (#usuario, autocomplete="organization"): un honeypot anti-bot
    # confirmado inspeccionando el DOM en vivo. Llenamos por selector
    # específico, nunca lo tocamos, igual que un usuario real.
    _tipear(page, "#usuario", frax_user)
    _tipear(page, "#clave", frax_pass)
    # Pantallazo intermedio, antes del click — para confirmar que los
    # campos realmente quedan cargados (los pantallazos post-click
    # siempre se ven vacíos porque ya reflejan la navegación automática a
    # login.php?error=captcha que dispara el propio submit fallido, no
    # porque el fill no haya funcionado).
    captura(page, "01b_campos_llenos")
    page.click("button.btn-login")
    captura(page, "02_despues_click_login")

    # El submit del login dispara acá (no en la carga inicial de
    # login.php) un Turnstile embebido que `solve_cloudflare=True` no
    # cubre. Reintento combinado: clickear el checkbox si aparece (sin
    # esto se queda sin marcar para siempre, confirmado en pantallazos)
    # Y volver a llenar RUT/clave (se pierden con el reload que dispara
    # el propio submit fallido) antes de reenviar.
    try:
        page.wait_for_url("**/index.php**", timeout=15000)
    except Exception:
        captura(page, "03_error_primer_intento")
        _click_turnstile_si_aparece(page, captura)
        _tipear(page, "#usuario", frax_user)
        _tipear(page, "#clave", frax_pass)
        captura(page, "03b_campos_rellenados")
        page.click("button.btn-login")
        try:
            page.wait_for_url("**/index.php**", timeout=15000)
        except Exception:
            captura(page, "03_timeout_esperando_index")
            raise
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
