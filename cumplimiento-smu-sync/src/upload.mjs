import XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

// El reporte trae todos los locales de la cuenta SMU de Coca-Cola Embonor
// (~411), no sólo los que supervisamos. Se cruza por salas.codigo_cadena
// (scoped a holding SMU, igual que smu-presentismo-sync) y se descarta el
// resto en vez de guardarlo.

/** "29-09-2026" (DD-MM-YYYY) -> "2026-09-29". */
function parseFecha(v) {
  const s = v == null ? null : String(v).trim();
  if (!s) return null;
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

export async function uploadCumplimientoFile({ filePath, supabaseUrl, supabaseServiceKey }) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("El archivo no tiene hojas");

  // Por posición (como smu-presentismo-sync): Fecha, Semana, Region, Formato,
  // Cod. Local, Local, Visitado, Visitantes, Horas Cumplidas, Demanda,
  // Cumplimiento. Se descarta la fila 0 (cabecera).
  const rows2d = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const raw = rows2d.slice(1);

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: salasSmu, error: salasErr } = await supabase
    .from("salas")
    .select("id, codigo_cadena, holdings!inner(nombre)")
    .eq("holdings.nombre", "SMU");
  if (salasErr) throw new Error(salasErr.message);
  const salaByCodigo = new Map(salasSmu.filter((s) => s.codigo_cadena).map((s) => [s.codigo_cadena.trim(), s.id]));

  const porClave = new Map();
  let descartadas = 0;
  let noNuestras = 0;
  for (const row of raw) {
    const [fechaRaw, semana, region, formato, codRaw, , visitado, visitantes, horas, demanda, cumpl] = row;
    const fecha = parseFecha(fechaRaw);
    const localCode = codRaw != null ? String(codRaw).trim() : null;
    if (!fecha || !localCode) {
      descartadas++;
      continue;
    }
    const salaId = salaByCodigo.get(localCode);
    if (!salaId) {
      noNuestras++;
      continue;
    }
    porClave.set(`${salaId}|${fecha}`, {
      sala_id: salaId,
      fecha,
      semana: semana != null ? Math.round(num(semana)) : null,
      region: region != null ? String(region).trim() : null,
      formato: formato != null ? String(formato).trim() : null,
      local_code: localCode,
      visitado: String(visitado ?? "").trim().toLowerCase() === "si",
      visitantes: Math.round(num(visitantes)),
      horas_cumplidas: num(horas),
      demanda_horas: num(demanda),
      cumplimiento: num(cumpl),
      cargado_at: new Date().toISOString(),
    });
  }
  const upsertRows = [...porClave.values()];

  const BATCH = 1000;
  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const { error } = await supabase
      .from("cumplimiento_smu")
      .upsert(upsertRows.slice(i, i + BATCH), { onConflict: "sala_id,fecha" });
    if (error) throw new Error(`cumplimiento_smu: ${error.message}`);
  }

  return { total: raw.length, cargadas: upsertRows.length, descartadas, noNuestras };
}
