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
4. Si no hay token en 60s, se aborta: no clickeamos el checkbox
   nosotros (el evento sintético se detecta, ver el comentario en
   `_interactuar_paso`) ni reenviamos sobre la página ya rechazada.
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
import shutil
import subprocess
import time
from pathlib import Path
from random import randint, uniform

from scrapling.fetchers import StealthyFetcher

BASE_URL = "https://www.controltienda.com/proveedor_server"


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


def _click_real_xdotool(page, captura) -> bool:
    """Clickea el checkbox de Turnstile con un click REAL del servidor X.

    `page.mouse.click()` viaja por CDP (`Input.dispatchMouseEvent`).
    Medido sobre el pantallazo 232920 del run 33126259380, ese click caía
    DENTRO del checkbox y Turnstile lo ignoraba igual: el evento sintético
    se detecta. `xdotool` mueve el puntero real del display virtual que
    levanta xvfb — es lo mismo que hace SeleniumBase en su
    `uc_gui_click_captcha()` para este caso.

    Devuelve False si no hay xdotool o si no se pudo ubicar el widget.
    """
    if not shutil.which("xdotool"):
        print("xdotool no está instalado; se omite el click real.")
        return False

    # No se puede entrar al iframe: Turnstile lo monta en un shadow root
    # (confirmado en vivo el 27/08 contra el portal — `.shadowRoot` da
    # null desde el page context). Se usa la caja del div contenedor, que
    # sí se ve desde el DOM normal, más el offset del checkbox medido
    # sobre pantallazos reales: va pegado al borde izquierdo, ~30px
    # adentro, y centrado en la altura del widget.
    coords = page.evaluate(
        """() => {
            const div = document.querySelector('.cf-turnstile');
            if (!div) return null;
            const r = div.getBoundingClientRect();
            if (!r.width || !r.height) return null;
            return {
                x: window.screenX + r.x,
                y: window.screenY + (window.outerHeight - window.innerHeight) + r.y,
                w: r.width,
                h: r.height,
            };
        }"""
    )
    if not coords:
        return False

    destino_x = int(coords["x"]) + randint(28, 33)
    destino_y = int(coords["y"]) + int(coords["h"] * 0.45)

    # Instrumentación: en el run 33131225717 el pantallazo posterior al
    # click mostró el checkbox intacto — ni marcado ni con error — o sea
    # que el click no llegó a la pantalla. Antes de seguir adivinando,
    # dejamos registrado el tamaño real del display, la geometría que
    # reporta el browser y dónde termina el puntero.
    def _cmd(*args: str) -> str:
        try:
            return subprocess.run(args, capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception as err:  # noqa: BLE001
            return f"(falló: {err})"

    print(f"[xdotool] geometría del browser: {coords}")
    print(f"[xdotool] display: {_cmd('xdotool', 'getdisplaygeometry')}")
    print(f"[xdotool] destino calculado: {destino_x},{destino_y}")

    # Acercarse en tramos y frenar antes de clickear, en vez de
    # teletransportar el puntero: un salto instantáneo seguido de click
    # inmediato es de las señales más baratas de detectar.
    for paso in (0.45, 0.8):
        subprocess.run(
            [
                "xdotool", "mousemove",
                str(destino_x - int((1 - paso) * randint(60, 140))),
                str(destino_y - int((1 - paso) * randint(40, 90))),
            ],
            check=False,
        )
        time.sleep(uniform(0.12, 0.28))

    subprocess.run(["xdotool", "mousemove", str(destino_x), str(destino_y)], check=False)
    time.sleep(uniform(0.25, 0.5))
    print(f"[xdotool] puntero quedó en: {_cmd('xdotool', 'getmouselocation')}")
    subprocess.run(["xdotool", "click", "1"], check=False)
    captura(page, "01d_click_real_xdotool")
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
        # Headful bajo xvfb (ver el workflow) en vez de headless: Cloudflare
        # detecta Chrome headless con bastante fiabilidad, y es la palanca
        # más grande que nos queda sin meter plata (proxy residencial).
        headless=False,
        # Chrome real instalado en el runner en vez del Chromium embebido:
        # otra huella distinta.
        real_chrome=True,
        # El runner corre en UTC. Un browser que dice ser Chrome de un
        # usuario chileno pero reporta timezone UTC es un mismatch que
        # Cloudflare puntúa (la doc de StealthyFetcher menciona explícitamente
        # los "timezone mismatch attacks" entre lo que parchea).
        locale="es-CL",
        timezone_id="America/Santiago",
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
    # Tipear arriba ya consume ~8s, que se suman a esta espera.
    #
    # Ya no clickeamos nosotros el checkbox. Sobre el pantallazo
    # 232920_02_sin_token_turnstile del run 33126259380 se midió que el
    # click caía DENTRO del checkbox (offset CSS ~27,26 sobre un checkbox
    # que va de 11 a 31 en x y de 19 a 39 en y) y aun así Turnstile lo
    # ignoraba: el evento sintético se está detectando, así que insistir
    # solo sumaba señal de bot. Si el widget escala a interactivo, el que
    # tiene que resolverlo es el solver de Scrapling, no nosotros.
    if not _esperar_token(page, segundos=25):
        captura(page, "01c_sin_token_antes_del_click")
        _click_real_xdotool(page, captura)
        if not _esperar_token(page, segundos=45):
            captura(page, "02_sin_token_turnstile")
            raise RuntimeError(
                "Turnstile no entregó token ni tras el click real de xdotool. "
                "Reintento con browser nuevo vía with_retries."
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
