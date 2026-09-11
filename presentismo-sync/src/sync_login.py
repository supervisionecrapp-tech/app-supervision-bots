"""Variante de sync.py que SIEMPRE loguea de cero (resolviendo el Turnstile
de Cloudflare), sin leer ni depender de ninguna cookie en bot_config.

Por qué existe: la vía por cookie (sync.py) necesita `capturar_cookie.py`
corrido a mano cada pocos días desde una máquina de confianza, y si esa
cookie muere (como pasó del 09-09 al 09-11: `frax_session_cookie` quedó
vieja 10 días sin que nadie se diera cuenta) el bot deja de traer datos
hasta que alguien la regenera. Este script no tiene ese punto de falla:
cada corrida hace login real.

El costo es el de siempre — confirmado en `bots/MIGRACION.md` §5: Turnstile
solo entrega el token desde una IP con buena reputación (residencial/casa),
nunca desde los runners de GitHub Actions (rangos de Azure). Por eso este
script está pensado para correr en un runner self-hosted con IP normal
(ver `.github/workflows/presentismo-sync-selfhosted.yml`), no en
`ubuntu-latest`."""

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


def with_retries(intentar, max_intentos: int = 2, espera_base_s: int = 90):
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
                # Nombre distinto de "presentismo-sync" a propósito: son dos
                # bots corriendo en paralelo (cookie vs. login real) mientras
                # se confirma que este reemplaza al otro, y bot_runs debe
                # poder distinguir cuál trajo cada corrida.
                "bot": "presentismo-sync-login",
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
    frax_user = require_env("FRAX_USER")
    frax_pass = require_env("FRAX_PASS")
    supabase_url = os.environ.get("SUPABASE_URL", "https://lbwwnrsbgaxjulpfbwdz.supabase.co")
    supabase_service_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
    supabase = create_client(supabase_url, supabase_service_key)

    download_dir = Path(os.environ.get("DOWNLOAD_DIR", "./downloads"))

    fecha_iso = fecha.isoformat()
    print(f"Sincronizando Presentismo (login real, sin cookie) — hasta {fecha_iso} (desde el día anterior)")
    started_at = dt.datetime.now(dt.timezone.utc).isoformat()

    try:
        def intentar():
            # session_cookie=None a propósito: fuerza la rama de scrape.py
            # que resuelve el Turnstile y loguea de cero en cada corrida,
            # nunca la rama por cookie.
            file_path = scrape_presentismo_export(
                fecha_ff=fecha, frax_user=frax_user, frax_pass=frax_pass, download_dir=download_dir,
                session_cookie=None, cf_clearance=None,
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
