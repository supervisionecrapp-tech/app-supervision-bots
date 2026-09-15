"""Descarga el Excel de "Detalle de marcas" del portal APE2 (Frax).

Puerto a Python/Scrapling del bot Node/Playwright que existió hasta
2026-08-21 (ver git log de este repo: "Eliminar presentismo-sync").

Usa `StealthySession` de Scrapling (Chromium/Chrome vía Patchright, NO
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
import os
import shutil
import subprocess
import time
from pathlib import Path
from random import randint, uniform

from scrapling.fetchers import StealthySession

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

    El token llega de forma ASÍNCRONA y el <form> arranca con el botón
    `#btnEntrar` deshabilitado hasta que el callback `onCfOk` lo habilita.
    """
    for _ in range(segundos * 2):
        if _token_turnstile(page):
            return True
        page.wait_for_timeout(500)
    return False


def _fallback_armado(page) -> bool:
    """True si el propio login.php ya activó su vía de escape.

    El portal trae su propio fallback (leído del JS de login.php el
    14/09/2026): si Turnstile no resuelve en 7 segundos —o tira error,
    caso "RBI, red corp, etc." según su propio comentario— el sitio pone
    `cf_fallback=1`, habilita el botón "Entrar" y muestra el aviso "No se
    pudo cargar la verificación automática; puedes continuar". Es decir:
    el servidor ACEPTA el login sin token de Turnstile, por diseño.

    Eso es exactamente lo que pasa desde los runners de GitHub (el widget
    nunca resuelve con esa IP). El bot fallaba porque insistía en esperar
    un token que el sitio no exige, en vez de usar la puerta que el propio
    sitio deja abierta."""
    try:
        val = page.locator("#cf_fallback").first.input_value()
        return (val or "").strip() == "1"
    except Exception:  # noqa: BLE001
        return False


def _esperar_token_o_fallback(page, *, segundos: int = 15) -> str:
    """Espera a que el login quede submiteable, por cualquiera de las dos
    vías. Devuelve "token", "fallback" o "" (ninguna).

    El fallback del sitio tarda 7s en armarse, así que 15s de margen
    alcanzan de sobra para las dos."""
    for _ in range(segundos * 2):
        if _token_turnstile(page):
            return "token"
        if _fallback_armado(page):
            return "fallback"
        page.wait_for_timeout(500)
    return ""


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


def _obtener_clearance(page, captura=None) -> str:
    """Consigue el "pase de navegador" que exige la página de reportes.

    Tercer control del portal, aparte del Turnstile del login y de la
    marca humana. Lo documenta `js/clearance.js`: "obtiene el pase de
    navegador via Turnstile invisible. Se incluye en las paginas que
    consumen endpoints protegidos (reportes, registrados, inactivos). Al
    cargar, ejecuta Turnstile de forma invisible, postea el token a
    api_clearance.php y marca el pase en la sesion."

    SIN ese pase, api_kpi.php y api_detalle.php no entregan datos — que es
    exactamente el síntoma que perseguimos todo el tiempo: index.php carga
    bien (no consume endpoints protegidos) y /reportes/ se ve pero nunca
    trae nada.

    El script expone `window.CLEARANCE_READY`, una promesa que resuelve
    true/false. Y si Turnstile necesita interacción, revela el widget en
    un overlay (`#cf-clearance-holder`) justamente para que se lo pueda
    clickear; si nadie lo clickea, no hay pase."""
    estado = page.evaluate(
        """() => {
            if (!window.CLEARANCE_READY) return 'sin_script';
            return Promise.race([
                window.CLEARANCE_READY.then(v => v ? 'ok' : 'fallo'),
                new Promise(r => setTimeout(() => r('timeout'), 25000)),
            ]);
        }"""
    )
    print(f"Pase de clearance: {estado}")
    if estado == "ok":
        return estado

    # Turnstile no lo resolvió solo: si el overlay quedó visible, hay que
    # clickear el checkbox — es la vía que el propio sitio deja abierta.
    visible = page.evaluate(
        """() => {
            const h = document.getElementById('cf-clearance-holder');
            return !!(h && h.style.display !== 'none' && h.offsetParent !== null);
        }"""
    )
    print(f"  overlay del pase visible: {visible}")
    if captura:
        captura(page, "05b_clearance_pendiente")
    if not visible:
        return estado

    try:
        marco = page.frame_locator("#cf-clearance-holder iframe")
        marco.locator("input[type=checkbox]").first.click(timeout=15000)
        print("  checkbox del pase clickeado.")
    except Exception as err:  # noqa: BLE001
        print(f"  no se pudo clickear el checkbox del pase ({err}).")
        return estado

    estado = page.evaluate(
        """() => Promise.race([
            window.CLEARANCE_READY.then(v => v ? 'ok' : 'fallo'),
            new Promise(r => setTimeout(() => r('timeout'), 25000)),
        ])"""
    )
    print(f"Pase de clearance tras el click: {estado}")
    return estado


def _cerrar_sesion(page) -> None:
    """Cierra la sesión en el portal (`cierra_sesion.php`, el mismo enlace
    "Cerrar Sesion" del menú).

    El bot nunca lo hacía: cada tirada logueaba de cero, se quedaba con un
    PHPSESSID nuevo y lo abandonaba. Con 3 tiradas por corrida y 4
    corridas por día, eso son ~12 sesiones diarias quedando abiertas del
    lado del servidor, y muchas más los días de pruebas. Encaja con el
    patrón de "la primera anda y la siguiente no" que se repitió todo el
    tiempo. Una persona cierra sesión, o al menos no deja decenas
    simultáneas."""
    try:
        page.goto(f"{BASE_URL}/cierra_sesion.php", timeout=20000)
        print("Sesión cerrada en el portal.")
    except Exception as err:  # noqa: BLE001
        print(f"No se pudo cerrar la sesión ({err}).")


def _login_camoufox(interactuar, intento, downloaded_path, *, proxy: str | None, vueltas: int) -> None:
    """Corre el login con Camoufox (Firefox endurecido) en vez de
    Chromium. Entrega una `page` de Playwright normal, así que todo el
    resto del flujo (`_interactuar_paso`, `_exportar`) se reusa igual."""
    from camoufox.sync_api import Camoufox

    opciones = {
        "headless": False,
        # APAGADO, junto con todo uso de `page.mouse` en este camino. Esa
        # API se cuelga de forma intermitente en Camoufox bajo xvfb y no
        # es cuestión de la animación: colgó con humanize=True
        # (34903029137, 34903480494), acotada a 1.5s (34907546772, 12m54s)
        # y también con humanize=False (34909061566). Los gestos ahora se
        # despachan desde la página (ver `_marcar_sesion_humana`).
        "humanize": False,
        "geoip": True,
        "locale": "es-CL",
        "os": "windows",
    }
    if proxy:
        opciones["proxy"] = {"server": proxy}

    with Camoufox(**opciones) as browser:
        for vuelta in range(1, vueltas + 1):
            intento["n"] = vuelta
            print(f"--- Tirada {vuelta}/{vueltas} (camoufox) ---")
            page = browser.new_page(accept_downloads=True)
            # Sin esto la página usa el default de Playwright (30s) y la
            # descarga del Excel se cae con "Timeout 30000ms exceeded
            # while waiting for event download" cuando el portal tarda en
            # generarlo (run 34879928067: el login entraba bien y se caía
            # siempre en el export). El camino de Chromium no tenía el
            # problema porque heredaba el timeout de StealthySession.
            page.set_default_timeout(90000)
            page.set_default_navigation_timeout(90000)
            try:
                page.goto(f"{BASE_URL}/login.php", timeout=90000)
                interactuar(page)
            except Exception as err:  # noqa: BLE001
                print(f"Tirada {vuelta} falló: {err}")
            finally:
                # Cerrar SIEMPRE, también cuando la tirada falla: si no,
                # cada intento deja una sesión abierta en el portal.
                try:
                    _cerrar_sesion(page)
                except Exception:  # noqa: BLE001
                    pass
                try:
                    page.close()
                except Exception:  # noqa: BLE001
                    pass
            if "path" in downloaded_path:
                print(f"Listo en la tirada {vuelta}.")
                break


def scrape_presentismo_export(*, fecha_ff: dt.date, frax_user: str, frax_pass: str, download_dir: Path, session_cookie: str | None = None, cf_clearance: str | None = None, fecha_fi: dt.date | None = None, proxy: str | None = None) -> Path:
    """Loguea, filtra el rango de fechas y descarga el Excel de "Detalle de
    marcas". `fecha_ff` es la fecha que queda en el campo "hasta" (se deja
    tal cual la trae el portal si no se toca; acá se pasa explícita para
    que quede logueada). El campo "desde" es el día anterior a `fecha_ff`
    por default (a pedido explícito del usuario para la corrida normal),
    salvo que se pase `fecha_fi` explícito — para backfills de rango
    (el portal acepta hasta 31 días, visto en el filtro de "Reportes de
    Marcas").

    `session_cookie`: si se pasa (viene de `bot_config` en Supabase, ver
    `sync.py`), se entra por sesión ya abierta y no se toca el login.

    `proxy`: opcional (formato `http://user:pass@host:puerto`). HOY NO HACE
    FALTA: con `MOTOR=camoufox` el login entra bien desde la IP del runner
    de GitHub. Queda por si alguna vez hay que salir por otra IP.

    Sobre el bloqueo que costó un día entero (14/09/2026): NO era la IP
    —con un proxy de datacenter en Francia y un Chrome real el login
    pasaba— ni `fp_sig` —inyectando a mano las señales del runner
    (`webgl_sw,no_plugins`) entraba igual—. Era el entorno del navegador:
    con Chromium/Patchright bajo xvfb, Turnstile ESCALA a un checkbox
    interactivo y el servidor contesta "No pudimos verificar tu
    navegador" (`login.php?error=captcha`). Con Camoufox (Firefox, sin
    CDP, parches a nivel del motor) el widget no escala y entra en la
    primera tirada."""
    download_dir.mkdir(parents=True, exist_ok=True)
    if fecha_fi is None:
        fecha_fi = fecha_ff - dt.timedelta(days=1)

    screenshots_dir = download_dir / "screenshots"
    screenshots_dir.mkdir(parents=True, exist_ok=True)

    # Nº de tirada, para que los pantallazos del artifact se puedan
    # atribuir a un intento concreto en vez de mezclarse todos.
    intento = {"n": 0}

    def captura(page, paso: str) -> None:
        """Pantallazo de diagnóstico best-effort (nunca rompe el flujo si
        falla, ej. página ya cerrada) — para poder ver en qué paso exacto
        quedó el portal cuando el bot falla (challenge de Cloudflare,
        cambio de layout, etc.), ya que en GitHub Actions no hay forma de
        mirar la pantalla en vivo."""
        try:
            ts = dt.datetime.now(dt.timezone.utc).strftime("%H%M%S")
            # full_page=False y timeout corto a propósito: con full_page
            # las capturas se colgaban los 90s del timeout de sesión
            # ("Timeout 90000ms exceeded ... waiting for fonts to load")
            # y varias corridas terminaban sin ninguna evidencia. El
            # viewport alcanza para ver el login y el estado del captcha.
            nombre = f"{ts}_t{intento['n']}_{paso}.png"
            page.screenshot(path=str(screenshots_dir / nombre), full_page=False, timeout=15000)
            print(f"[captura] {nombre}")
        except Exception as err:  # noqa: BLE001
            print(f"No se pudo capturar pantallazo ({paso}): {err}")

    downloaded_path: dict[str, Path] = {}

    def interactuar(page):
        """Corre en cada `session.fetch()`."""
        try:
            page.wait_for_selector("#usuario", timeout=30000)
            captura(page, "01_login_page")

            # El orden importa y antes estaba mal: se salía por el
            # fallback apenas se armaba (7s), sin darle al captcha la
            # menor oportunidad. Los pantallazos del run 34865329403 lo
            # mostraron: el widget había escalado a "Verifique que es un
            # ser humano" con el checkbox SIN marcar, esperando un click
            # que nunca llegaba, y el bot enviaba igual. El servidor
            # entonces contesta "No pudimos verificar tu navegador".
            #
            # Ahora se intenta RESOLVERLO de verdad, y el fallback queda
            # como último recurso:
            #   1. esperar el token (a veces llega solo, invisible)
            #   2. si no, clickear el checkbox con un click real de X
            #   3. volver a esperar el token
            #   4. recién ahí, fallback
            via = ""
            if _esperar_token(page, segundos=20):
                via = "token"
            else:
                captura(page, "01c_checkbox_interactivo")
                if os.environ.get("MOTOR", "").lower() == "camoufox":
                    # En Camoufox NO se clickea el checkbox: `page.mouse`
                    # se cuelga de forma intermitente bajo xvfb, y el
                    # click nunca aportó nada — en todas las corridas que
                    # entraron, la vía fue el fallback del portal, no el
                    # token. Se espera el fallback y listo.
                    if _esperar_token(page, segundos=20):
                        via = "token"
                    elif _fallback_armado(page):
                        via = "fallback"
                elif _click_real_xdotool(page, captura) and _esperar_token(page, segundos=25):
                    via = "token_tras_click"
                elif _fallback_armado(page):
                    via = "fallback"

            if not via:
                captura(page, "01c_sin_token_ni_fallback")
                print("Ni token ni fallback; se vuelve a fetchear.")
                return page
            print(f"Login habilitado por: {via}.")
            captura(page, f"01d_captcha_ok_por_{via}")
            _interactuar_paso(page, captura, downloaded_path, frax_user=frax_user, frax_pass=frax_pass, fecha_fi=fecha_fi, fecha_ff=fecha_ff, download_dir=download_dir)
        except Exception:
            captura(page, "error_fatal")
            raise
        return page

    # Vía preferida: entrar con una sesión ya abierta y no tocar el login.
    #
    # El Turnstile solo protege el POST del login. Verificado el 28/08: un
    # browser LIMPIO al que solo se le inyectan PHPSESSID y cf_clearance
    # llega a /reportes/ sin pasar por login.php y sin captcha alguno. Como
    # desde los runners de GitHub el token no se consigue (1 éxito en ~30
    # intentos), esta es la vía que no depende de ganarle a Cloudflare.
    #
    # La cookie se saca corriendo `scripts/capturar_cookie.py` desde una
    # máquina de confianza, que la guarda en bot_config (Supabase) — mismo
    # lugar que lee la Edge Function presentismo-keepalive para mantenerla
    # viva. Un solo lugar, para no tener la cookie duplicada y potencialmente
    # desincronizada entre un secret de GitHub y Supabase.
    cookie_sesion = (session_cookie or "").strip()
    cf_clearance_val = (cf_clearance or "").strip()
    if cookie_sesion:
        print(
            "Hay cookie de sesión en bot_config: se entra por cookie"
            + (" + cf_clearance" if cf_clearance_val else " (SIN cf_clearance, va a fallar contra Cloudflare)")
            + ", sin pasar por el login."
        )

        def entrar_con_cookie(page):
            try:
                cookies_a_inyectar = [
                    {
                        "name": "PHPSESSID",
                        "value": cookie_sesion,
                        "domain": "www.controltienda.com",
                        "path": "/",
                        "httpOnly": True,
                        "secure": True,
                    }
                ]
                if cf_clearance_val:
                    # Sin esta cookie, Cloudflare desafía cada navegación
                    # real del browser headful aunque PHPSESSID siga vivo
                    # — confirmado con los fallos del 09-09 al 09-11
                    # (index.php pasaba por un fetch plano sin JS, pero
                    # /reportes/ siempre redirigía a login.php).
                    cookies_a_inyectar.append(
                        {
                            "name": "cf_clearance",
                            "value": cf_clearance_val,
                            "domain": ".controltienda.com",
                            "path": "/",
                            "httpOnly": True,
                            "secure": True,
                        }
                    )
                page.context.add_cookies(cookies_a_inyectar)
                page.goto(f"{BASE_URL}/reportes/")
                try:
                    page.wait_for_selector("#btn-export-detalle", timeout=25000)
                except Exception:
                    captura(page, "00_cookie_rechazada")
                    raise RuntimeError(
                        "La cookie de sesión no sirvió (quedó en "
                        f"{page.url}). Probablemente expiró: hay que "
                        "regenerarla con scripts/capturar_cookie.py."
                    )
                captura(page, "05_reportes_ok_por_cookie")
                _exportar(page, captura, downloaded_path, fecha_fi=fecha_fi, fecha_ff=fecha_ff, download_dir=download_dir)
            except Exception:
                captura(page, "error_fatal")
                raise
            return page

        with StealthySession(
            headless=False,
            real_chrome=True,
            locale="es-CL",
            timezone_id="America/Santiago",
            # Sin solver: no hay captcha que resolver en este camino.
            solve_cloudflare=False,
            timeout=90000,
            network_idle=False,
        ) as session:
            session.fetch(f"{BASE_URL}/", page_action=entrar_con_cookie)

        if "path" not in downloaded_path:
            raise RuntimeError("El flujo terminó sin descargar el archivo (vía cookie).")
        return downloaded_path["path"]

    # Login normal, sin solver de Cloudflare.
    #
    # `solve_cloudflare=False` es DELIBERADO y es lo que hace que esto
    # funcione desde los runners de GitHub. Con el solver activo (run
    # 34849229804) el log muestra el patrón exacto del problema:
    #     INFO: Cloudflare captcha is solved
    #     ERROR: quedó en login.php?error=captcha
    # El solver inyecta un token que el servidor después rechaza, pero el
    # JS del sitio ya lo dio por bueno (`onCfOk` -> resuelto = true), así
    # que el fallback del portal NUNCA se arma y el POST viaja con un
    # token inválido. El solver se sabotea a sí mismo.
    #
    # Sin solver, cada entorno toma su camino natural:
    #   - IP residencial: Turnstile resuelve solo -> vía "token".
    #   - IP de datacenter: no resuelve, el sitio arma cf_fallback=1 a los
    #     7s -> vía "fallback", que el servidor acepta (ver
    #     `_fallback_armado`).
    # MOTOR=camoufox usa Firefox endurecido en vez de Chromium/Patchright.
    # Por qué puede cambiar algo donde Chromium falla: Camoufox no se
    # maneja por CDP (usa Juggler), parchea el fingerprint a nivel del
    # motor en vez de con scripts inyectados, y su `humanize` mueve el
    # cursor de forma humana desde el browser — justo lo que Turnstile
    # estaba rechazando cuando el widget escaló a checkbox interactivo.
    if os.environ.get("MOTOR", "").lower() == "camoufox":
        # 3 tiradas, no 5: el login ya entra de forma confiable, y cada
        # tirada puede esperar hasta 180s por la descarga. Con 5 el job se
        # pasaba de los 15 min de timeout antes de terminar.
        _login_camoufox(
            interactuar, intento, downloaded_path, proxy=proxy, vueltas=3,
        )
        if "path" not in downloaded_path:
            raise RuntimeError("El flujo terminó sin descargar el archivo (camoufox).")
        return downloaded_path["path"]

    with StealthySession(
        # Headful bajo xvfb (ver el workflow) en vez de headless: Cloudflare
        # detecta Chrome headless con bastante fiabilidad.
        headless=False,
        # Chrome real del runner en vez del Chromium embebido: otra huella.
        real_chrome=True,
        # El runner corre en UTC. Un browser que dice ser Chrome de un
        # usuario chileno pero reporta timezone UTC es un mismatch que
        # Cloudflare puntúa (la doc de StealthyFetcher menciona explícitamente
        # los "timezone mismatch attacks" entre lo que parchea).
        locale="es-CL",
        timezone_id="America/Santiago",
        solve_cloudflare=False,
        # Sin proxy residencial el login se rechaza desde Actions (ver el
        # docstring). `None` = salida directa, que sirve corriendo a mano
        # desde una máquina con IP normal.
        proxy=proxy or None,
        timeout=90000,
        # Los waits explícitos ya cubren cada paso — esperar además a
        # "networkidle" en cada navegación solo suma tiempo muerto
        # (trackers/pixels de terceros que nunca terminan de cargar).
        network_idle=False,
    ) as session:
        for vuelta in range(1, 6):
            intento["n"] = vuelta
            print(f"--- Tirada {vuelta}/5 ---")
            try:
                session.fetch(f"{BASE_URL}/login.php", page_action=interactuar)
            except Exception as err:  # noqa: BLE001
                # Que una tirada falle no debe cortar las que siguen: el
                # objetivo es juntar evidencia de los 5 intentos.
                print(f"Tirada {vuelta} falló: {err}")
            if "path" in downloaded_path:
                print(f"Listo en la tirada {vuelta}.")
                break

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
    # Acá ya hay token: el chequeo y las re-tiradas las hace `interactuar`
    # en `scrape_presentismo_export`, antes de llamar a esta función.
    #
    # #usuario_v2 NO es un honeypot (el comentario viejo acá estaba
    # equivocado): leyendo el JS de login.php, es el campo de usuario
    # individual y el propio sitio lo muestra solo si
    # api_check_multiusuario.php dice que ese RUT usa cuentas por persona.
    # Para esta cuenta queda oculto y vacío, que es lo correcto.
    _tipear(page, "#usuario", frax_user)

    # Cuentas individuales: si el RUT es "multiusuario", el portal
    # consulta api_check_multiusuario.php mientras se tipea y recién ahí
    # muestra #usuario_v2. Sin llenarlo, esas cuentas no pueden entrar.
    usuario_v2 = (os.environ.get("FRAX_USUARIO_V2") or "").strip()
    if usuario_v2:
        try:
            page.wait_for_selector("#usuario_v2", state="visible", timeout=10000)
            _tipear(page, "#usuario_v2", usuario_v2)
            print("Cuenta individual: se llenó también el usuario.")
        except Exception as err:  # noqa: BLE001
            print(f"FRAX_USUARIO_V2 está seteado pero el campo no apareció ({err}).")

    _tipear(page, "#clave", frax_pass)

    captura(page, "01b_campos_llenos")

    # El botón arranca `disabled` y lo habilita el JS del sitio, sea por
    # `onCfOk` (token) o por su propio fallback a los 7s. Esperarlo
    # habilitado evita clickear al vacío.
    page.wait_for_selector("#btnEntrar:not([disabled])", timeout=20000)
    page.click("#btnEntrar")
    # Justo después del POST, antes de esperar la navegación: es el
    # pantallazo que muestra qué contesta el portal (el aviso de captcha,
    # un mensaje de error, etc.).
    page.wait_for_timeout(2500)
    captura(page, "02_despues_de_enviar")

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
    _exportar(page, captura, downloaded_path, fecha_fi=fecha_fi, fecha_ff=fecha_ff, download_dir=download_dir)


def _marcar_sesion_humana(page, captura=None) -> bool:
    """Genera interacción real para que el portal marque la sesión como
    "humana". SIN esto los endpoints de datos devuelven 200 pero vacíos.

    No es una suposición: `js/human.js` del propio portal lo explica en su
    cabecera — "detecta la PRIMERA interaccion humana real de la sesion y
    la reporta al servidor (api_interaccion.php). El server marca la
    sesion como 'hay un humano'. Los endpoints de datos exigen esa marca
    (anti-bot). Un bot que hace requests sin mover el mouse / scrollear /
    teclear nunca dispara esto -> su sesion queda sin marca."

    Los eventos que la disparan son mousemove, mousedown, keydown, scroll,
    touchstart, wheel y pointerdown. El bot navegaba con `goto` y llenaba
    con `fill()`, que no dispara ninguno: por eso el reporte quedaba en
    "Ningún dato disponible" con las tarjetas girando para siempre.

    Se espera la respuesta de `api_interaccion.php` para no correr una
    carrera entre la marca y la primera request de datos."""
    # Los gestos se despachan desde la página (`dispatchEvent`), NO con
    # `page.mouse`: esa API se cuelga de forma intermitente en Camoufox
    # bajo xvfb y NO es cuestión de `humanize` — colgó con True
    # (34903029137, 34903480494), acotada a 1.5s (34907546772) y también
    # con humanize=False (34909061566). Un `evaluate` no puede bloquearse
    # así.
    #
    # El recorrido va igual de aleatorizado (puntos, cantidad de pasos,
    # esperas y scroll), porque una secuencia fija repetida 4 veces al día
    # es en sí misma una firma de bot.
    # Se VERIFICA que la marca haya llegado, con un listener (no con
    # expect_response, que al bloquear dentro del `with` causaba los
    # cuelgues). Si no llega, se repiten los gestos: cuando la sesión
    # queda sin marcar, los endpoints de datos no responden nunca y el
    # reporte se queda girando para siempre (run 34976619878).
    marcada = {"ok": False}

    def _on_marca(resp):
        if "api_interaccion.php" in resp.url:
            marcada["ok"] = True

    page.on("response", _on_marca)
    try:
        for ronda in range(1, 4):
            _gestos_humanos(page)
            for _ in range(20):  # hasta 10s esperando el beacon
                if marcada["ok"]:
                    break
                page.wait_for_timeout(500)
            if marcada["ok"]:
                print(f"Sesión marcada como humana (ronda {ronda}).")
                return True
            print(f"La marca no llegó en la ronda {ronda}; se repiten los gestos.")
    finally:
        try:
            page.remove_listener("response", _on_marca)
        except Exception:  # noqa: BLE001
            pass

    print("No se pudo confirmar la marca humana tras 3 rondas.")
    return False


def _pausa_humana(page, minimo: float, maximo: float, *, motivo: str = "") -> None:
    """Espera un rato variable, generando actividad de a ratos.

    Existe porque el bot hacía TODO seguido, sin una sola pausa: cargar,
    marcar, filtrar y exportar en ~90 segundos, siempre en el mismo orden
    y a la misma velocidad. Una persona mira la pantalla, lee, duda. Y
    `human.js` manda un heartbeat cada 4 min mientras hay actividad, así
    que quedarse quieto también envejece la marca de la sesión."""
    total = uniform(minimo, maximo)
    if motivo:
        print(f"  pausa de {total:.1f}s ({motivo})")
    restante = total
    while restante > 0:
        tramo = min(restante, uniform(1.5, 4.0))
        page.wait_for_timeout(int(tramo * 1000))
        restante -= tramo
        # De vez en cuando, un gesto suelto: mantiene viva la señal de
        # actividad en vez de dejar la sesión muda.
        if restante > 0 and randint(1, 3) == 1:
            try:
                page.evaluate(
                    f"""() => window.dispatchEvent(new MouseEvent('mousemove', {{
                        bubbles: true,
                        clientX: {randint(200, 1200)}, clientY: {randint(150, 700)}
                    }}))"""
                )
            except Exception:  # noqa: BLE001
                pass


def _gestos_humanos(page) -> None:
    """Una tanda de gestos aleatorios despachados desde la página."""
    try:
        x = randint(280, 900)
        y = randint(180, 520)
        for paso in range(randint(3, 5)):
            destino_x = max(60, min(1500, x + randint(-220, 260)))
            destino_y = max(60, min(820, y + randint(-160, 200)))
            page.evaluate(
                """([x0, y0, x1, y1]) => {
                    const n = 8 + Math.floor(Math.random() * 6);
                    for (let i = 1; i <= n; i++) {
                        const t = 1 - Math.pow(1 - i / n, 2);
                        window.dispatchEvent(new MouseEvent('mousemove', {
                            bubbles: true,
                            clientX: x0 + (x1 - x0) * t + (Math.random() * 5 - 2.5),
                            clientY: y0 + (y1 - y0) * t + (Math.random() * 5 - 2.5),
                        }));
                    }
                }""",
                [x, y, destino_x, destino_y],
            )
            x, y = destino_x, destino_y
            print(f"  gesto {paso + 1}: mousemove -> ({x}, {y})")
            page.wait_for_timeout(randint(90, 320))

        page.evaluate(f"() => window.scrollBy(0, {randint(160, 400)})")
        print("  gesto: scroll abajo")
        page.wait_for_timeout(randint(150, 450))
        page.evaluate(
            f"""() => window.dispatchEvent(new MouseEvent('mousedown', {{
                bubbles: true, clientX: {x}, clientY: {y}
            }}))"""
        )
        print("  gesto: mousedown")
        page.wait_for_timeout(randint(100, 300))
        page.evaluate(f"() => window.scrollBy(0, -{randint(120, 360)})")
        print("  gesto: scroll arriba")
    except Exception as err:  # noqa: BLE001
        print(f"Falló algún gesto de la marca humana: {err}")


def _esperar_datos_reporte(page, *, segundos: int = 90) -> int:
    """Espera a que las tablas del reporte terminen de cargar por AJAX y
    devuelve cuántos registros trajeron (0 = nunca cargaron).

    DataTables escribe "Mostrando registros del X al Y de un total de N
    registros" debajo de cada tabla; mientras el AJAX corre, N es 0 y la
    tabla dice "Ningún dato disponible en esta tabla". Se toma el N más
    grande de la página (hay dos tablas: "Resumen por local" y "Detalle de
    marcas") y se espera a que sea > 0."""
    leer_total = """() => {
        const txt = document.body.innerText || '';
        const re = /de un total de\\s+([\\d.,]+)\\s+registros/g;
        let m, max = 0;
        while ((m = re.exec(txt)) !== null) {
            const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
            if (!isNaN(n) && n > max) max = n;
        }
        return max;
    }"""
    for _ in range(segundos * 2):
        try:
            total = page.evaluate(leer_total)
        except Exception:  # noqa: BLE001
            total = 0
        if total > 0:
            # Un respiro para que el DOM de la tabla termine de pintarse
            # antes de pedir el export.
            page.wait_for_timeout(800)
            return total
        page.wait_for_timeout(500)
    return 0


def _exportar(page, captura, downloaded_path, *, fecha_fi: dt.date, fecha_ff: dt.date, download_dir: Path) -> None:
    """Todo lo que va DESPUÉS de tener sesión abierta: filtrar el rango y
    bajar el Excel. Separado del login porque con `FRAX_SESSION_COOKIE` se
    entra por cookie y no se pasa por el formulario en absoluto."""
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

    # Un rato en index antes de saltar al reporte: el bot entraba y se iba
    # a /reportes/ en el mismo segundo, cosa que nadie hace.
    _pausa_humana(page, 2, 7, motivo="en el inicio")

    page.goto(f"{BASE_URL}/reportes/")
    try:
        page.wait_for_selector("#btn-export-detalle", timeout=20000)
    except Exception:
        captura(page, "05_timeout_esperando_reportes")
        raise
    captura(page, "05_reportes_ok")

    # ANTES de pedir datos: marcar la sesión como humana. El portal
    # exige esa marca en sus endpoints de datos (ver _marcar_sesion_humana).
    # El pase de clearance.js va PRIMERO: sin él los endpoints de datos no
    # entregan nada, por más marcada que esté la sesión.
    _obtener_clearance(page, captura)

    print("Marcando sesión como humana...")
    _marcar_sesion_humana(page, captura)

    # Mirar la pantalla antes de tocar los filtros, como haría alguien que
    # acaba de entrar al reporte.
    _pausa_humana(page, 3, 9, motivo="leyendo el reporte")
    print("Aplicando filtro de fechas...")

    # Inputs type=date nativos (value YYYY-MM-DD) — sin overlay de
    # calendario que cerrar. "hasta" (#f-ff) se deja tal cual lo trae
    # el portal por default (hoy), a pedido explícito: no se toca.
    page.fill("#f-fi", fecha_fi.isoformat())

    # Se lee `recordsTotal` de la respuesta de api_detalle.php en vez de
    # parsear el texto de la tabla: es el dato exacto que devuelve el
    # portal y no depende de cómo DataTables redacte su "Mostrando
    # registros del X al Y...".
    # El portal a veces devuelve api_detalle.php VACÍO (cuerpo en blanco,
    # no JSON) en vez de rechazar con un código de error — visto en el run
    # 34909925831. Es un rechazo del lado del servidor, probablemente por
    # haberlo consultado demasiado seguido, así que la respuesta correcta
    # es esperar y reintentar, no seguir insistiendo al toque ni quedarse
    # 90s contando filas en un texto que nunca va a cambiar.
    # NO usar `expect_response`, que se queda con la PRIMERA respuesta de
    # api_detalle.php que aparezca. La página de reportes ya dispara su
    # propia consulta al cargar, y al clickear "Aplicar" DataTables aborta
    # esa request en vuelo y lanza otra: la abortada llega con cuerpo
    # vacío y rompe el .json() con "Expecting value: line 1 column 1".
    # Esa carrera es lo que hacía fallar corridas enteras de forma
    # intermitente (run 34967781829: 9 respuestas vacías seguidas), y no
    # se cura esperando, porque no es saturación del portal.
    #
    # Acá se escuchan TODAS las respuestas y se ignoran las que no
    # parsean, hasta que llegue una de verdad.
    respuestas: list[int] = []

    def _capturar(resp):
        if "api_detalle.php" not in resp.url and "api_kpi.php" not in resp.url:
            return
        try:
            cuerpo = resp.text()
        except Exception:  # noqa: BLE001
            cuerpo = ""
        # Loguear SIEMPRE el status: un 403 con error "sin_clearance" es la
        # respuesta que da el portal cuando falta el pase de clearance.js,
        # y sin este print quedaba invisible detrás de un "cuerpo vacío".
        print(f"  [{resp.status}] {resp.url.split('/')[-1][:28]} len={len(cuerpo)} {cuerpo[:90]}")
        if "api_detalle.php" not in resp.url:
            return
        try:
            respuestas.append(int(resp.json().get("recordsTotal", 0) or 0))
        except Exception:  # noqa: BLE001
            # Request abortada por DataTables: cuerpo vacío, se descarta.
            pass

    page.on("response", _capturar)
    try:
        page.click("#btn-aplicar")
        filas = 0
        for vuelta in range(120):  # hasta 60s
            if respuestas:
                filas = max(respuestas)
                break
            page.wait_for_timeout(500)
            # Mientras se espera el reporte, seguir dando señales de vida:
            # una sesión muda envejece su marca (human.js manda heartbeat
            # cada 4 min sólo si hubo actividad).
            if vuelta % 12 == 11:
                try:
                    page.evaluate(
                        f"""() => window.dispatchEvent(new MouseEvent('mousemove', {{
                            bubbles: true,
                            clientX: {randint(200, 1200)}, clientY: {randint(150, 700)}
                        }}))"""
                    )
                except Exception:  # noqa: BLE001
                    pass
    finally:
        page.remove_listener("response", _capturar)

    print(f"Respuestas útiles de api_detalle.php: {respuestas or 'ninguna'}")

    # Si vino vacío, reintentar DENTRO de la misma sesión antes de gastar
    # un login nuevo. Antes cada tirada relogueaba, así que una corrida
    # fallida dejaba 3 sesiones en el portal en vez de 1 — justo lo que
    # conviene evitar si el rechazo tiene que ver con la cuenta.
    if not filas:
        for reintento in (1, 2):
            print(f"Reporte vacío; reintento {reintento}/2 en la misma sesión.")
            _pausa_humana(page, 8, 20, motivo="antes de reconsultar")
            page.reload()
            try:
                page.wait_for_selector("#btn-export-detalle", timeout=20000)
            except Exception:  # noqa: BLE001
                break
            _marcar_sesion_humana(page, captura)
            _pausa_humana(page, 3, 8, motivo="leyendo el reporte")

            respuestas.clear()
            page.on("response", _capturar)
            try:
                page.fill("#f-fi", fecha_fi.isoformat())
                page.click("#btn-aplicar")
                for _ in range(120):
                    if respuestas:
                        filas = max(respuestas)
                        break
                    page.wait_for_timeout(500)
            finally:
                page.remove_listener("response", _capturar)

            print(f"  -> respuestas: {respuestas or 'ninguna'}")
            if filas:
                break

    # Historia de las descargas "trabadas", para no volver a perseguir la
    # pista equivocada: el síntoma era un timeout esperando el evento
    # `download`, pero el portal simplemente no generaba archivo porque el
    # reporte venía VACÍO ("Ningún dato disponible", tarjetas girando).
    # Subir el timeout a 180s no cambió nada (run 34893170193). La causa
    # de fondo es el gate anti-bot de `_marcar_sesion_humana`: sin la
    # marca, api_kpi/api_detalle responden 200 pero sin datos.
    print(f"Reporte cargado con {filas} registros.")
    # Mirar los resultados antes de exportar, en vez de clickear "Exportar"
    # en el mismo instante en que la tabla termina de pintarse.
    _pausa_humana(page, 2, 8, motivo="revisando los resultados")
    captura(page, "06_antes_exportar")
    if not filas:
        captura(page, "06b_reporte_vacio")
        raise RuntimeError(
            "El reporte quedó en 0 registros; no tiene sentido exportar "
            "(o el rango no tiene marcas, o el AJAX nunca terminó)."
        )

    file_path = download_dir / f"presentismo-{fecha_fi.isoformat()}_{fecha_ff.isoformat()}.xlsx"
    try:
        # timeout explícito: el portal genera el Excel server-side y con
        # rangos grandes tarda bastante más que los 30s que Playwright usa
        # por default. No depender del default de la página.
        with page.expect_download(timeout=180000) as download_info:
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
