import XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { RED_COLUMNS, RED_TABLE } from "./redColumns.mjs";

// Misma lógica que la sección "Red" de admin-panel.html, portada a Node
// para poder correr sin navegador ni usuario logueado — usa la
// service_role key así que no pasa por RLS (equivalente a is_admin()).
export async function uploadRedFile({ filePath, categoria, anio, semana, supabaseUrl, supabaseServiceKey }) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets["Export"];
  if (!ws) throw new Error(`El archivo no tiene una hoja "Export" (hojas: ${wb.SheetNames.join(", ")})`);

  const raw = XLSX.utils.sheet_to_json(ws, { defval: null });

  // Guarda contra el modo de falla más peligroso del scraper: si el
  // drill-down no llegó hasta el nivel Sala, el export sale igual pero
  // agregado por Planta/Oficina/etc. Sin este chequeo eso entraría como
  // "0 filas cargadas, N descartadas" y parecería un problema de cruce
  // con la maestra en vez de un bot roto. Pasó de verdad: una corrida
  // exportó las 7 filas de Planta creyendo que estaba en Sala.
  const headers = Object.keys(raw[0] ?? {});
  if (!headers.includes("Sala")) {
    throw new Error(
      `El export no está a nivel Sala — el drill-down del scraper falló. ` +
        `Columnas encontradas: ${headers.join(", ")}`,
    );
  }

  // El export trae una fila "Total" y un bloque "Filtros aplicados..." al
  // final; ambas tienen Salas != 1 (cada local real trae exactamente 1).
  const rows = raw.filter((r) => r["Sala"] != null && r["Salas"] === 1);

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data: salas, error: salasErr } = await supabase.from("salas").select("id, sap, nombre_cadem");
  if (salasErr) throw new Error(salasErr.message);

  const salaByKey = new Map();
  for (const s of salas) {
    if (s.nombre_cadem) salaByKey.set(`${s.sap}-${s.nombre_cadem}`, s.id);
  }

  const cols = RED_COLUMNS[categoria];
  if (!cols) throw new Error(`Categoría inválida: ${categoria}`);

  const upsertRows = [];
  let descartadas = 0;
  for (const r of rows) {
    const salaId = salaByKey.get(String(r["Sala"]).trim());
    if (!salaId) {
      descartadas++;
      continue;
    }
    const row = { sala_id: salaId, anio, semana };
    for (const [excelCol, dbCol] of cols) {
      const v = r[excelCol];
      row[dbCol] = v === null || v === undefined || v === "" ? null : Number(v);
    }
    upsertRows.push(row);
  }

  const table = RED_TABLE[categoria];
  const { error } = await supabase.from(table).upsert(upsertRows, { onConflict: "sala_id,anio,semana" });
  if (error) throw new Error(`${table}: ${error.message}`);

  await supabase.from("cargas_red").insert({
    categoria,
    anio,
    semana,
    archivo_nombre: filePath.split(/[\\/]/).pop(),
    filas_excel: rows.length,
    filas_cargadas: upsertRows.length,
    filas_descartadas: descartadas,
  });

  return { total: rows.length, cargadas: upsertRows.length, descartadas };
}
