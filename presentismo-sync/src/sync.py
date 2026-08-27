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


def require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"Falta la variable de entorno {name}")
    return v


def read_fecha() -> dt.date:
    """FECHA opcional en formato YYYY-MM-DD (workflow_dispatch); default =
    hoy en huso horario de Chile. Es la fecha que queda en el campo
    "hasta" del filtro del portal."""
    fecha_arg = os.environ.get("FECHA") or (sys.argv[1] if len(sys.argv) > 1 else None)
    if fecha_arg:
        return dt.date.fromisoformat(fecha_arg)
    return dt.datetime.now(SANTIAGO).date()


def with_retries(intentar, max_intentos: int = 2, espera_base_s: int = 90):
    """Reintenta `intentar()` hasta `max_intentos` veces, con espera
    EXPONENCIAL (90s, 180s, 360s, ...) entre intentos.

    Solo 2 intentos, a propósito: el workflow corre cada hora y el filtro
    del portal siempre va desde el día anterior, así que una corrida que
    falla no pierde datos — la siguiente vuelve a traer el rango completo
    y el upsert (rut_persona, local_code, entrada) deduplica. Insistir
    más dentro de la misma corrida no gana nada y sí alimenta la escalada
    del challenge: con 4 intentos eran hasta 72 logins fallidos por día
    desde la misma IP de GitHub Actions.

    Backoff exponencial en vez de lineal, a propósito: confirmado a mano
    por el usuario (corriendo el login manualmente muchas veces seguidas
    desde la misma IP) que el portal empieza a escalar el challenge de
    Cloudflare a modo interactivo cuanto más seguido se lo golpea — mismo
    criterio que documenta Scrapling para su AutoThrottle
    (`autothrottle_block_backoff`): cualquier respuesta bloqueada DUPLICA
    el delay del dominio en vez de un incremento fijo, precisamente para
    no seguir alimentando esa escalada. Los reintentos rápidos (lineal,
    60/120s) que probamos antes nunca le daban tiempo a la sesión/IP a
    "enfriarse" entre intento e intento."""
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
                "bot": "presentismo-sync",
                "categoria": fecha_iso,  # se reusa esta columna genérica para guardar la fecha consultada
                "status": status,
                "error_message": error_message,
                "filas_cargadas": filas_cargadas,
                "started_at": started_at,
            }
        ).execute()
    except Exception as err:  # noqa: BLE001
        print(f"No se pudo registrar la corrida en bot_runs: {err}", file=sys.stderr)


def main() -> None:
    fecha = read_fecha()
    frax_user = require_env("FRAX_USER")
    frax_pass = require_env("FRAX_PASS")
    supabase_url = os.environ.get("SUPABASE_URL", "https://lbwwnrsbgaxjulpfbwdz.supabase.co")
    supabase_service_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
    supabase = create_client(supabase_url, supabase_service_key)

    download_dir = Path(os.environ.get("DOWNLOAD_DIR", "./downloads"))

    fecha_iso = fecha.isoformat()
    print(f"Sincronizando Presentismo (marcaciones) — hasta {fecha_iso} (desde el día anterior)")
    started_at = dt.datetime.now(dt.timezone.utc).isoformat()

    try:
        def intentar():
            file_path = scrape_presentismo_export(
                fecha_ff=fecha, frax_user=frax_user, frax_pass=frax_pass, download_dir=download_dir
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
