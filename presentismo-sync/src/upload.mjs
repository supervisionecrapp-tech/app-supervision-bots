import XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

// Misma lógica que la sección "Presentismo WM — Marcaciones (DATA)" de
// admin-panel.html, portada a Node. Usa service_role key así que no pasa
// por RLS.
function parseFechaHora(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === "number") {
    const parsed = XLSX.SSF.parse_date_code(v);
    if (!parsed) return null;
    return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, Math.round(parsed.S)));
  }
  if (typeof v === "string" && v.trim() !== "") {
    const iso = v.trim().replace(" ", "T");
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function cleanText(v) {
  return v == null ? null : String(v).trim();
}

export async function uploadPresentismoFile({ filePath, supabaseUrl, supabaseServiceKey }) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const ws = wb.Sheets["Export"];
  if (!ws) throw new Error(`El archivo no tiene una hoja "Export" (hojas: ${wb.SheetNames.join(", ")})`);

  const raw = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });

  const rows = raw
    .map((r) => ({ ...r, _entrada: parseFechaHora(r["ENTRADA"]), _salida: parseFechaHora(r["SALIDA"]) }))
    .filter(
      (r) =>
        r._entrada !== null &&
        r["LOCAL"] != null &&
        r["RUT PERSONA"] &&
        // Formato SBA se descarta a pedido explícito — no corresponde a
        // las salas que trackea Presentismo WM.
        cleanText(r["FORMATO"])?.toUpperCase() !== "SBA",
    );

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data: salas, error: salasErr } = await supabase
    .from("salas")
    .select("id, local_code")
    .not("local_code", "is", null);
  if (salasErr) throw new Error(salasErr.message);
  const salaByLocal = new Map(salas.map((s) => [Number(s.local_code), s.id]));

  const upsertRows = [];
  let sinSala = 0;
  for (const r of rows) {
    const local = Number(r["LOCAL"]);
    const salaId = salaByLocal.get(local) ?? null;
    if (!salaId) sinSala++;
    upsertRows.push({
      sala_id: salaId,
      local_code: local,
      nombre_local: cleanText(r["NOMBRE LOCAL"]),
      formato: cleanText(r["FORMATO"]),
      rut_persona: String(r["RUT PERSONA"]).trim(),
      nombre_persona: cleanText(r["NOMBRE PERSONA"]),
      cargo: cleanText(r["NOMBRE CARGO"]),
      entrada: r._entrada.toISOString(),
      salida: r._salida ? r._salida.toISOString() : null,
    });
  }

  const BATCH = 1000;
  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const batch = upsertRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from("presentismo_registros")
      .upsert(batch, { onConflict: "rut_persona,local_code,entrada" });
    if (error) throw new Error(`presentismo_registros: ${error.message}`);
  }

  return { total: rows.length, cargadas: upsertRows.length, sinSala };
}
