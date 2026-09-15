"""Variante de sync.py que SIEMPRE loguea de cero (resolviendo el Turnstile
de Cloudflare), sin leer ni depender de ninguna cookie en bot_config.

Por qué existe: la vía por cookie (sync.py) necesita `capturar_cookie.py`
corrido a mano cada pocos días desde una máquina de confianza, y si esa
cookie muere (como pasó del 09-09 al 09-11: `frax_session_cookie` quedó
vieja 10 días sin que nadie se diera cuenta) el bot deja de traer datos
hasta que alguien la regenera. Este script no tiene ese punto de falla:
cada corrida hace login real.

Y NO hace falta un runner con IP residencial: el 14/09/2026, leyendo el JS
de login.php, se encontró que el propio portal trae un fallback — si
Turnstile no resuelve en 7s, el sitio pone `cf_fallback=1`, habilita el
botón "Entrar" y el servidor acepta el login SIN token. Verificado a mano
bloqueando `challenges.cloudflare.com` (misma condición que la IP de
GitHub Actions): el login llegó igual a index.php.

Por eso este script corre en `ubuntu-latest` sin proxies, sin solvers de
captcha y sin cookie previa."""

from __future__ import annotations

import datetime as dt
import os
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

from scrape import scrape_presentismo_export
from supabase import create_client
from upload import upload_presentismo_file

SANTIAGO = ZoneInfo("America/Santiago")


def cargar_env_local() -> None:
    env_file = Path(__file__).resolve().parent.parent / ".env.local"
    if not env_file.is_file():
        return
    for linea in env_file.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, _, valor = linea.partition("=")
        os.environ.setdefault(clave.strip(), valor.strip().strip('"').strip("'"))


def require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"Falta la variable de entorno {name}")
    return v


def read_fecha() -> dt.date:
    fecha_arg = os.environ.get("FECHA") or (sys.argv[1] if len(sys.argv) > 1 else None)
    if fecha_arg:
        return dt.date.fromisoformat(fecha_arg)
    return dt.datetime.now(SANTIAGO).date()


def read_desde() -> dt.date | None:
    """DESDE opcional (workflow_dispatch). Vacío = el día anterior a
    "hasta", el comportamiento normal del cron."""
    desde_arg = os.environ.get("DESDE") or (sys.argv[2] if len(sys.argv) > 2 else None)
    return dt.date.fromisoformat(desde_arg) if desde_arg else None


def with_retries(intentar, max_intentos: int = 1, espera_base_s: int = 90):
    """Mismo criterio de backoff exponencial que sync.py — ver ahí el porqué."""
    for intento in range(1, max_intentos + 1):
        try:
            return intentar()
        except Exception as err:  # noqa: BLE001
            es_ultimo = intento == max_intentos
            print(f"Intento {intento}/{max_intentos} falló: {err}", file=sys.stderr)
            if es_ultimo:
                raise
            espera_s = espera_base_s * (2 ** (intento - 1))
            print(f"Reintentando en {espera_s}s...")
            time.sleep(espera_s)


def log_run(supabase, *, fecha_iso: str, started_at: str, status: str, error_message: str | None = None, filas_cargadas: int | None = None):
    try:
        supabase.table("bot_runs").insert(
            {
                # Mismo nombre que el bot viejo a propósito: este lo
                # reemplaza, y panel-cliente.html filtra bot_runs por
                # "presentismo-sync" en su selector de bots.
                "bot": "presentismo-sync",
                "categoria": fecha_iso,
                "status": status,
                "error_message": error_message,
                "filas_cargadas": filas_cargadas,
                "started_at": started_at,
            }
        ).execute()
    except Exception as err:  # noqa: BLE001
        print(f"No se pudo registrar la corrida en bot_runs: {err}", file=sys.stderr)


def main() -> None:
    cargar_env_local()
    fecha = read_fecha()
    desde = read_desde()
    frax_user = require_env("FRAX_USER")
    frax_pass = require_env("FRAX_PASS")
    supabase_url = os.environ.get("SUPABASE_URL", "https://lbwwnrsbgaxjulpfbwdz.supabase.co")
    supabase_service_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
    supabase = create_client(supabase_url, supabase_service_key)

    download_dir = Path(os.environ.get("DOWNLOAD_DIR", "./downloads"))

    fecha_iso = fecha.isoformat()
    desde_msg = desde.isoformat() if desde else "el día anterior"
    print(f"Sincronizando Presentismo (login real, sin cookie) — hasta {fecha_iso} (desde {desde_msg})")
    started_at = dt.datetime.now(dt.timezone.utc).isoformat()

    try:
        def intentar():
            # session_cookie=None a propósito: fuerza la rama de scrape.py
            # que resuelve el Turnstile y loguea de cero en cada corrida,
            # nunca la rama por cookie.
            file_path = scrape_presentismo_export(
                fecha_ff=fecha, fecha_fi=desde, frax_user=frax_user, frax_pass=frax_pass,
                download_dir=download_dir, session_cookie=None, cf_clearance=None,
                proxy=os.environ.get("FRAX_PROXY"),
            )
            print(f"Archivo descargado: {file_path}")
            return upload_presentismo_file(
                file_path=file_path, supabase_url=supabase_url, supabase_service_key=supabase_service_key
            )

        result = with_retries(intentar)
        print(
            f"Listo: {result['cargadas']}/{result['total']} marcaciones cargadas "
            f"({result['sin_sala']} sin sala reconocida)."
        )
        log_run(supabase, fecha_iso=fecha_iso, started_at=started_at, status="success", filas_cargadas=result["cargadas"])
    except Exception as err:  # noqa: BLE001
        log_run(
            supabase,
            fecha_iso=fecha_iso,
            started_at=started_at,
            status="error",
            error_message=str(err)[:2000],
        )
        raise


if __name__ == "__main__":
    main()
