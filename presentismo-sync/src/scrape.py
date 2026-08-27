"""Descarga el Excel de "Detalle de marcas" del portal APE2 (Frax).

Puerto a Python/Scrapling del bot Node/Playwright que existió hasta
2026-08-21 (ver git log de este repo: "Eliminar presentismo-sync").

Usa `StealthyFetcher` de Scrapling (Chromium/Chrome vía Patchright, NO
Camoufox pese a lo que decía una versión vieja de este comentario —
confirmado leyendo el código fuente instalado de scrapling 0.4.15) con
`solve_cloudflare=True`. Ese solver SÍ resuelve el Turnstile embebido de
`login.php` (log del run 33119160851: `The turnstile version discovered
is "embedded"` -> `Cloudflare captcha is solved`), pero corre UNA sola
vez y ANTES de nuestro `page_action`: todo lo que hagamos acá tiene que
preservar ese estado, no re-navegar.

Diseño del login (reescrito tras diagnosticar el run 33119160851):
1. NO se re-navega a login.php dentro de `page_action`: `fetch()` ya la
   cargó y su solver ya resolvió el Turnstile embebido. Recargar ahí
   descartaba ese token.
2. Se tipea RUT/clave con delay (no `page.fill()`, que no dispara
   eventos de teclado reales).
3. Se espera a que exista el token en `input[name="cf-turnstile-response"]`
   ANTES de clickear "Entrar". El widget es
   `data-appearance="interaction-only"` y el <form> no tiene guardia JS:
   submitear sin token = `login.php?error=captcha` garantizado.
4. Si no hay token, se intenta el checkbox interactivo una vez; si
   tampoco, se aborta. Reenviar sobre la página ya rechazada nunca
   funcionó (el Turnstile de esa página queda en "Verification failed").
   El reintento real es un browser nuevo, vía `with_retries()` en
   sync.py, con espera EXPONENCIAL: confirmado a mano por el usuario que
   golpear el login seguido desde la misma IP hace que el portal escale
   el challenge cada vez más rápido, y Scrapling documenta el mismo
   criterio en su AutoThrottle (`autothrottle_block_backoff`).

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


_TOKEN_SELECTOR = 'input[name="cf-turnstile-response"]'


def _token_turnstile(page) -> str:
    """Valor actual del input oculto que el widget inyecta dentro del div
    `.cf-turnstile`. Vacío = todavía no hay token."""
    try:
        loc = page.locator(_TOKEN_SELECTOR)
        if loc.count() == 0:
            return ""
        return (loc.first.input_value() or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def _esperar_token(page, *, segundos: int = 20) -> bool:
    """Espera a que Turnstile entregue el token antes de dejar submitear.

    El widget del portal está montado con `data-appearance="interaction-only"`
    (confirmado leyendo el HTML real de login.php): es INVISIBLE mientras
    Cloudflare esté conforme y el token llega de forma ASÍNCRONA. El
    <form id="loginForm"> no tiene ninguna guardia JS, así que si se
    clickea "Entrar" antes de que el token exista, el POST viaja con
    `cf-turnstile-response` vacío y el server responde
    `login.php?error=captcha`. Esa es la causa raíz del run 33119160851:
    el bot tipeaba y clickeaba ~2s después de cargar la página.
    """
    for _ in range(segundos * 2):
        if _token_turnstile(page):
            return True
        page.wait_for_timeout(500)
    return False


def _click_turnstile_si_aparece(page, captura, *, intentos_espera: int = 20) -> bool:
    """Fallback: si no llegó token, el widget escaló a modo interactivo
    (checkbox "Verify you are human" visible). Busca su iframe y lo
    clickea. Devuelve True si encontró y clickeó uno."""
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
        # La doc de StealthyFetcher pide timeout >= 60s cuando el solver
        # de Cloudflare está activo ("The timeout should be at least 60
        # seconds when using the Cloudflare solver"). El default de 30s
        # dejaba al solver sin margen.
        timeout=90000,
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
    # NO volver a navegar a login.php. `StealthyFetcher.fetch()` ya cargó
    # esa misma URL y su solver corrió ANTES de este page_action (la doc
    # de Scrapling: page_action se ejecuta después de la navegación y del
    # network_idle). En el log del run 33119160851 se ve el solver
    # terminando OK ("Cloudflare captcha is solved", 21:41:03) y un
    # segundo después el pantallazo del goto que había acá (21:41:04):
    # esa recarga desmontaba el widget ya resuelto y volvía a arrancar un
    # Turnstile virgen, tirando el token a la basura.
    page.wait_for_selector("#usuario", timeout=30000)
    captura(page, "01_login_page")

    # El formulario trae un campo señuelo (#usuario_v2 — 0x0 vía CSS
    # pero no display:none, autocomplete="username") además del real
    # (#usuario, autocomplete="organization"): un honeypot anti-bot
    # confirmado inspeccionando el DOM en vivo. Llenamos por selector
    # específico, nunca lo tocamos, igual que un usuario real.
    _tipear(page, "#usuario", frax_user)
    _tipear(page, "#clave", frax_pass)

    # Gate obligatorio: nunca clickear "Entrar" sin token de Turnstile.
    # Tipear arriba ya consume ~8s, que le dan aire al token asíncrono.
    if not _esperar_token(page, segundos=20):
        captura(page, "01c_sin_token_reintento_checkbox")
        _click_turnstile_si_aparece(page, captura)
        if not _esperar_token(page, segundos=30):
            captura(page, "02_sin_token_turnstile")
            raise RuntimeError(
                "Turnstile no entregó token: el widget escaló a modo interactivo "
                "y el checkbox fue rechazado. Hace falta browser/IP nueva "
                "(lo maneja with_retries en sync.py), no reintentar acá."
            )

    captura(page, "01b_campos_llenos_con_token")
    page.click("button.btn-login")

    # Ya no se reintenta el submit sobre esta misma página: una vez que el
    # portal responde login.php?error=captcha, el Turnstile de esa página
    # queda quemado ("Verification failed" en el pantallazo
    # 214134_03b_campos_rellenados del run 33119160851) y reenviar ahí
    # nunca funcionó — 6 corridas seguidas fallando lo confirman. El
    # reintento real es un browser nuevo, vía with_retries().
    try:
        page.wait_for_url("**/index.php**", timeout=20000)
    except Exception:
        captura(page, "02_login_rechazado")
        raise RuntimeError(f"El login no llegó a index.php (quedó en {page.url}).")
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
