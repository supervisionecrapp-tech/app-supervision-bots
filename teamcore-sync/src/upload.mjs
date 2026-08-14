import XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

// Misma lógica que la sección "Teamcore — Usabilidad" de admin-panel.html
// (sheetToRows sin cellDates: "Fecha" llega como número de serie de
// Excel, no como Date), portada a Node.
function fechaSerialToIso(fecha) {
  if (typeof fecha === "number") return XLSX.SSF.format("yyyy-mm-dd", fecha);
  return String(fecha).slice(0, 10);
}

export async function uploadTeamcoreFile({ filePath, supabaseUrl, supabaseServiceKey }) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets["Toma detalles"];
  if (!ws) throw new Error(`El archivo no tiene una hoja "Toma detalles" (hojas: ${wb.SheetNames.join(", ")})`);

  const raw = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });

  // Solo importa que exista al menos una fila por (sala, fecha) — una
  // fila del Excel es un SKU revisado, no una visita.
  const pairs = new Map();
  for (const r of raw) {
    const codigoLocal = r["Código Local"];
    const fecha = r["Fecha"];
    if (codigoLocal == null || fecha == null) continue;
    const fechaStr = fechaSerialToIso(fecha);
    pairs.set(`${codigoLocal}|${fechaStr}`, { sap_teamcore: String(codigoLocal).trim(), fecha: fechaStr });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data: salas, error: salasErr } = await supabase.from("salas").select("id, sap_teamcore");
  if (salasErr) throw new Error(salasErr.message);
  const salaByTeamcore = new Map(salas.filter((s) => s.sap_teamcore != null).map((s) => [String(s.sap_teamcore), s.id]));

  const upsertRows = [];
  let descartadas = 0;
  for (const { sap_teamcore, fecha } of pairs.values()) {
    const salaId = salaByTeamcore.get(sap_teamcore);
    if (!salaId) {
      descartadas++;
      continue;
    }
    upsertRows.push({ sala_id: salaId, fecha });
  }

  const { error } = await supabase.from("teamcore_usabilidad_registros").upsert(upsertRows, { onConflict: "sala_id,fecha" });
  if (error) throw new Error(error.message);

  return { total: raw.length, pares: pairs.size, cargadas: upsertRows.length, descartadas };
}
