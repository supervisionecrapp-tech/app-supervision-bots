"""Enrola en Walmart (portal APE2/FRAX) a los mercaderistas de GeoVictoria.

Flujo semanal:
  1. Arma el Excel de la plantilla PlantillaCarga_REPOSICION con el roster que
     roster-sync deja en `turnos_colaboradores` (GeoVictoria): todos los
     activos que pertenecen a un grupo de supervisor (`grupos_gv`), con
     SERVICIO = REPONEDOR. El apellido materno es todo lo que va después del
     primer espacio de LastName (ya viene partido en la tabla).
  2. Entra al portal con el MISMO login que presentismo (sync_login.py) y
     usa "Registro Excel": sube el archivo y corre "Iniciar procesamiento".
  3. Lee el resumen del portal y lo deja en bot_runs.

El portal procesa en tandas de 100 y siempre cuenta 1.000 filas (las vacías
salen como VACIA), así que no hace falta recortar la planilla. Personas que
ya estaban habilitadas por Walmart con otro proveedor quedan "ACTUALIZADO -
HABILITADA" (verificado el 02/10/2026 con 3 personas); las nuevas quedan
PROVISORIO hasta que Walmart las habilite.

Uso: python src/enrolar_wm.py          (carga real)
     DRY_RUN=1 python src/enrolar_wm.py (solo arma el Excel, no abre el portal)
"""

from __future__ import annotations

import datetime as dt
import os
import re
import sys
from pathlib import Path

from openpyxl import load_workbook
from scrape import (
    BASE_URL,
    _marcar_sesion_humana,
    _obtener_clearance,
    _pausa_humana,
    scrape_presentismo_export,
)
from supabase import create_client
from sync_login import cargar_env_local, require_env

PLANTILLA = Path(__file__).resolve().parent.parent / "assets" / "PlantillaCarga_REPOSICION.xlsx"
SERVICIO = "REPONEDOR"
MAX_FILAS = 1000  # tope de la hoja Registro (fila 1001)
SOLO_LETRAS = re.compile(r"[A-ZÁÉÍÓÚÑÜ ]+")


def leer_roster(supabase) -> list[dict]:
    grupos = {g["nombre"] for g in supabase.table("grupos_gv").select("nombre").execute().data}
    gente: list[dict] = []
    desde = 0
    while True:
        lote = (
            supabase.table("turnos_colaboradores")
            .select("rut,nombres,apellido_paterno,apellido_materno,grupo_gv")
            .eq("activo", True)
            .order("apellido_paterno")
            .order("apellido_materno")
            .order("nombres")
            .range(desde, desde + 999)
            .execute()
            .data
        )
        gente += lote
        if len(lote) < 1000:
            break
        desde += 1000
    return [p for p in gente if p["grupo_gv"] in grupos]


def armar_excel(gente: list[dict], salida: Path) -> list[str]:
    """Llena la plantilla y devuelve los avisos (filas que el portal va a
    rechazar por las reglas de la plantilla: mínimo 3 letras, solo letras)."""
    if len(gente) > MAX_FILAS:
        raise RuntimeError(f"{len(gente)} personas: la plantilla admite {MAX_FILAS}; hay que partir en dos cargas")
    wb = load_workbook(PLANTILLA)
    ws = wb["Registro"]
    for fila in ws.iter_rows(min_row=2, max_row=MAX_FILAS + 1, max_col=5):
        for c in fila:
            c.value = None
    avisos: list[str] = []
    for i, p in enumerate(gente, start=2):
        rut = p["rut"].replace(".", "").replace("-", "").upper()
        fila = [rut, p["nombres"], p["apellido_paterno"], p["apellido_materno"], SERVICIO]
        fila = [v.strip().upper() if isinstance(v, str) else v for v in fila]
        for col, v in enumerate(fila, start=1):
            ws.cell(row=i, column=col, value=v)
        for campo, v in zip(("NOMBRE", "APELLIDO PATERNO", "APELLIDO MATERNO"), fila[1:4]):
            if not v or len(v.replace(" ", "")) < 3 or not SOLO_LETRAS.fullmatch(v):
                avisos.append(f"{rut}: {campo} = {v!r}")
    salida.parent.mkdir(parents=True, exist_ok=True)
    wb.save(salida)
    return avisos


def _contadores(texto: str) -> dict[str, int]:
    out = {}
    for n, etiqueta in re.findall(r"(\d+)\s*\n\s*(Ingresados|Actualizados|Errores|Provisorios|Ya habilitadas|Vacias)", texto):
        out[etiqueta.lower().replace(" ", "_")] = int(n)
    return out


def subir_excel(page, captura, archivo: Path, resultado: dict) -> None:
    """Corre con la sesión ya abierta (index.php)."""
    cerrar_impago = page.locator("#btnCerrarImpago")
    try:
        if cerrar_impago.is_visible(timeout=5000):
            cerrar_impago.click()
            page.wait_for_timeout(300)
    except Exception:  # noqa: BLE001
        pass

    _pausa_humana(page, 2, 6, motivo="en el inicio")
    page.goto(f"{BASE_URL}/sube_excel.php")
    page.wait_for_selector('input[type="file"]', timeout=30000)
    captura(page, "10_sube_excel")

    # Mismos dos requisitos que los endpoints de datos del reporte: el pase
    # de clearance.js y la marca de sesión humana (human.js).
    _obtener_clearance(page, captura)
    _marcar_sesion_humana(page, captura)

    page.set_input_files('input[type="file"]', str(archivo))
    captura(page, "11_archivo_adjunto")
    page.click('button[type="submit"]:has-text("Guardar")')
    page.wait_for_url("**/lee_excel_chunks.php**", timeout=60000)
    captura(page, "12_lee_excel_chunks")

    # Etapa 2: acá recién se registra. Procesa en tandas de 100 por AJAX.
    page.get_by_role("button", name="Iniciar procesamiento").click()
    page.wait_for_function("document.body.innerText.includes('Procesamiento completo')", timeout=300000)
    page.wait_for_timeout(1000)
    captura(page, "13_procesamiento_completo")

    texto = page.evaluate("document.body.innerText")
    resultado["contadores"] = _contadores(texto)
    # Detalle por fila, sin las vacías (son ~300 de relleno).
    filas = page.evaluate(
        "[...document.querySelectorAll('table tbody tr')].map(tr => [...tr.cells].map(c => c.innerText.trim()))"
    )
    resultado["no_ok"] = [f for f in filas if len(f) >= 4 and not re.search(r"ACTUALIZADO|INGRESADO|VACIA|PROVISORIO", f[3].upper())]
    resultado["estados"] = {}
    for f in filas:
        if len(f) >= 4 and "VACIA" not in f[3].upper():
            resultado["estados"][f[3]] = resultado["estados"].get(f[3], 0) + 1


def log_run(supabase, *, categoria: str, started_at: str, status: str, error_message: str | None, filas: int | None) -> None:
    try:
        supabase.table("bot_runs").insert(
            {
                "bot": "enrolamiento-wm",
                "categoria": categoria,
                "status": status,
                "error_message": error_message,
                "filas_cargadas": filas,
                "started_at": started_at,
            }
        ).execute()
    except Exception as err:  # noqa: BLE001
        print(f"No se pudo registrar la corrida en bot_runs: {err}", file=sys.stderr)


def main() -> None:
    cargar_env_local()
    supabase_url = os.environ.get("SUPABASE_URL", "https://lbwwnrsbgaxjulpfbwdz.supabase.co")
    supabase = create_client(supabase_url, require_env("SUPABASE_SERVICE_ROLE_KEY"))
    download_dir = Path(os.environ.get("DOWNLOAD_DIR", "./downloads"))
    hoy = dt.date.today().isoformat()
    started_at = dt.datetime.now(dt.timezone.utc).isoformat()

    gente = leer_roster(supabase)
    archivo = download_dir / f"Enrolamiento_WM_{hoy}.xlsx"
    avisos = armar_excel(gente, archivo)
    print(f"Excel armado: {len(gente)} personas -> {archivo}")
    for a in avisos:
        print(f"  REVISAR {a}")
    if os.environ.get("DRY_RUN"):
        print("DRY_RUN: no se abre el portal.")
        return

    resultado: dict = {}
    try:
        scrape_presentismo_export(
            fecha_ff=dt.date.today(),
            frax_user=require_env("FRAX_USER"),
            frax_pass=require_env("FRAX_PASS"),
            download_dir=download_dir,
            session_cookie=None,
            cf_clearance=None,
            proxy=os.environ.get("FRAX_PROXY"),
            accion_post_login=lambda page, captura: subir_excel(page, captura, archivo, resultado),
        )
        c = resultado.get("contadores", {})
        if not c:
            raise RuntimeError("El portal no entregó contadores: no se puede confirmar la carga.")
        resumen = (
            f"{len(gente)} enviadas · actualizados {c.get('actualizados', 0)}, ingresados {c.get('ingresados', 0)}, "
            f"provisorios {c.get('provisorios', 0)}, ya habilitadas {c.get('ya_habilitadas', 0)}, errores {c.get('errores', 0)}"
        )
        print(f"Listo: {resumen}")
        print(f"Estados por fila: {resultado.get('estados')}")
        for f in resultado.get("no_ok", []):
            print(f"  FILA NO OK: {f}")
        problemas = bool(c.get("errores")) or bool(resultado.get("no_ok")) or bool(avisos)
        log_run(
            supabase, categoria=hoy, started_at=started_at, status="success",
            error_message=(resumen + f" · rechazadas por plantilla {len(avisos)}") if problemas else None,
            filas=c.get("actualizados", 0) + c.get("ingresados", 0),
        )
    except Exception as err:  # noqa: BLE001
        log_run(supabase, categoria=hoy, started_at=started_at, status="error", error_message=str(err)[:2000], filas=None)
        raise


if __name__ == "__main__":
    main()
