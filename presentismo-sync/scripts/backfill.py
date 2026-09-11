"""Backfill puntual de un rango de fechas para Presentismo (marcaciones).

Uso (desde presentismo-sync/, con .env.local):
    python scripts/backfill.py 2026-08-29 2026-09-11

A diferencia de src/sync.py (que siempre trae "ayer + hoy"), este script
pide el rango completo en una sola pasada al portal — que acepta hasta 31
días por consulta (visto en el filtro de "Reportes de Marcas")."""

from __future__ import annotations

import datetime as dt
import os
import sys
from pathlib import Path

BOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BOT / "src"))

from scrape import scrape_presentismo_export  # noqa: E402
from supabase import create_client  # noqa: E402
from sync import cargar_env_local, require_env  # noqa: E402
from upload import upload_presentismo_file  # noqa: E402


def main() -> None:
    cargar_env_local()
    if len(sys.argv) != 3:
        raise SystemExit("Uso: python scripts/backfill.py DESDE(YYYY-MM-DD) HASTA(YYYY-MM-DD)")
    fecha_fi = dt.date.fromisoformat(sys.argv[1])
    fecha_ff = dt.date.fromisoformat(sys.argv[2])

    frax_user = require_env("FRAX_USER")
    frax_pass = require_env("FRAX_PASS")
    supabase_url = os.environ.get("SUPABASE_URL", "https://lbwwnrsbgaxjulpfbwdz.supabase.co")
    supabase_service_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
    supabase = create_client(supabase_url, supabase_service_key)

    cookie_row = supabase.table("bot_config").select("value").eq("key", "frax_session_cookie").maybe_single().execute()
    session_cookie = (cookie_row.data or {}).get("value") if cookie_row else None
    cf_row = supabase.table("bot_config").select("value").eq("key", "frax_cf_clearance").maybe_single().execute()
    cf_clearance = (cf_row.data or {}).get("value") if cf_row else None

    download_dir = Path(os.environ.get("DOWNLOAD_DIR", "./downloads"))

    print(f"Backfill Presentismo: {fecha_fi.isoformat()} a {fecha_ff.isoformat()}")
    file_path = scrape_presentismo_export(
        fecha_ff=fecha_ff, fecha_fi=fecha_fi, frax_user=frax_user, frax_pass=frax_pass,
        download_dir=download_dir, session_cookie=session_cookie, cf_clearance=cf_clearance,
    )
    print(f"Archivo descargado: {file_path}")
    result = upload_presentismo_file(file_path=file_path, supabase_url=supabase_url, supabase_service_key=supabase_service_key)
    print(f"Listo: {result['cargadas']}/{result['total']} marcaciones cargadas ({result['sin_sala']} sin sala reconocida).")


if __name__ == "__main__":
    main()
