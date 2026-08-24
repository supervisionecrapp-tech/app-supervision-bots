import XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

// Misma lógica que la sección "Presentismo SMU — Reporte de Accesos" de
// panel-cliente.html, portada a Node — mismo parseo de columnas, mismo
// cruce por salas.codigo_cadena scoped a holding SMU, mismo upsert
// idempotente (rut, local_code, fecha, acceso).

/** "982 - TEMUCO ALEMANIA" -> { code: "982", nombre: "TEMUCO ALEMANIA" }. */
function parseSmuLocal(v) {
  const s = v == null ? null : String(v).trim();
  if (!s) return null;
  const idx = s.indexOf("-");
  if (idx === -1) return { code: s, nombre: null };
  const nombre = s.slice(idx + 1).trim();
  return { code: s.slice(0, idx).trim(), nombre: nombre || null };
}

/** "24-08-2026" (DD-MM-YYYY, texto plano, sin hora) -> "2026-08-24". */
function parseSmuFecha(v) {
  const s = v == null ? null : String(v).trim();
  if (!s) return null;
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export async function uploadSmuAccessFile({ filePath, supabaseUrl, supabaseServiceKey }) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets["Reporte Documentos"];
  if (!ws) throw new Error(`El archivo no tiene una hoja "Reporte Documentos" (hojas: ${wb.SheetNames.join(", ")})`);

  // header:1 en vez de leer por nombre de columna — confirmado en una
  // corrida real (CI) que este export no siempre trae la fila 1 con texto
  // de cabecera reconocible por sheet_to_json (salió con keys "", "_1",
  // "_2"... y la fila 0 resultó ser la primera fila de DATOS, no la
  // cabecera). El orden de columnas sí es fijo (Rut, Nombre, Acceso,
  // Fecha, Local), así que se lee por posición y se descarta la fila 0
  // sea lo que sea que tenga (título, cabecera real, o basura).
  const rows2d = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const raw = rows2d.slice(1);

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data: salasSmu, error: salasErr } = await supabase
    .from("salas")
    .select("id, codigo_cadena, holdings!inner(nombre)")
    .eq("holdings.nombre", "SMU");
  if (salasErr) throw new Error(salasErr.message);
  const salaByCodigo = new Map(salasSmu.filter((s) => s.codigo_cadena).map((s) => [s.codigo_cadena.trim(), s.id]));

  const upsertRows = [];
  let descartadas = 0;
  let sinSala = 0;
  for (const row of raw) {
    // Orden fijo de columnas del export: Rut, Nombre, Acceso, Fecha, Local.
    const [rutRaw, nombreRaw, accesoRaw, fechaRaw, localRaw] = row;
    const rut = rutRaw != null ? String(rutRaw).trim() : null;
    const acceso = accesoRaw != null ? String(accesoRaw).trim() : null;
    const fecha = parseSmuFecha(fechaRaw);
    const local = parseSmuLocal(localRaw);
    if (!rut || !fecha || !local || (acceso !== "Ingreso" && acceso !== "Salida")) {
      descartadas++;
      continue;
    }
    const salaId = salaByCodigo.get(local.code) ?? null;
    if (!salaId) sinSala++;
    upsertRows.push({
      sala_id: salaId,
      local_code: local.code,
      local_nombre: local.nombre,
      rut,
      nombre_persona: nombreRaw != null ? String(nombreRaw).trim() : null,
      acceso,
      fecha,
      cargado_at: new Date().toISOString(),
    });
  }

  const BATCH = 1000;
  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const batch = upsertRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from("presentismo_smu_registros")
      .upsert(batch, { onConflict: "rut,local_code,fecha,acceso" });
    if (error) throw new Error(`presentismo_smu_registros: ${error.message}`);
  }

  return { total: raw.length, cargadas: upsertRows.length, descartadas, sinSala };
}
