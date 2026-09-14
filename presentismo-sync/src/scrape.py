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


def _click_checkbox_camoufox(page, captura) -> bool:
    """Clickea el checkbox de Turnstile con el mouse del propio browser.

    En Camoufox no hace falta xdotool: Firefox se maneja por Juggler, no
    por CDP, así que `page.mouse` no deja el rastro que Turnstile detecta
    en Chromium, y con `humanize=True` el recorrido del cursor lo genera
    el browser de forma humana.

    El checkbox va pegado al borde izquierdo del widget, ~20px adentro
    (medido sobre los pantallazos del run 34869715526 — el click viejo
    apuntaba a 28-33px, que caía en el borde o afuera)."""
    caja = page.evaluate(
        """() => {
            const d = document.querySelector('.cf-turnstile');
            if (!d) return null;
            const r = d.getBoundingClientRect();
            if (!r.width || !r.height) return null;
            return {x: r.x, y: r.y, w: r.width, h: r.height};
        }"""
    )
    if not caja:
        print("No se encontró el widget .cf-turnstile.")
        return False

    x = caja["x"] + 20
    y = caja["y"] + caja["h"] * 0.5
    print(f"[camoufox] widget={caja} -> click en ({x:.0f}, {y:.0f})")
    page.mouse.move(x - 60, y + 40)
    page.wait_for_timeout(250)
    page.mouse.move(x, y)
    page.wait_for_timeout(200)
    page.mouse.click(x, y)
    page.wait_for_timeout(1500)
    captura(page, "01d_click_camoufox")
    return True


def _login_camoufox(interactuar, intento, downloaded_path, *, proxy: str | None, vueltas: int) -> None:
    """Corre el login con Camoufox (Firefox endurecido) en vez de
    Chromium. Entrega una `page` de Playwright normal, así que todo el
    resto del flujo (`_interactuar_paso`, `_exportar`) se reusa igual."""
    from camoufox.sync_api import Camoufox

    opciones = {
        "headless": False,
        "humanize": True,
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
                clickear = (
                    _click_checkbox_camoufox
                    if os.environ.get("MOTOR", "").lower() == "camoufox"
                    else _click_real_xdotool
                )
                if clickear(page, captura) and _esperar_token(page, segundos=25):
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
