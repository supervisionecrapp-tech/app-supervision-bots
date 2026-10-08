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
  const rellenadas = await rellenarSemanasEnBlanco(supabase, upsertRows);

  const BATCH = 1000;
  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const { error } = await supabase
      .from("cumplimiento_smu")
      .upsert(upsertRows.slice(i, i + BATCH), { onConflict: "sala_id,fecha" });
    if (error) throw new Error(`cumplimiento_smu: ${error.message}`);
  }

  return { total: raw.length, cargadas: upsertRows.length, descartadas, noNuestras, rellenadas };
}

const DIA_MS = 24 * 3600 * 1000;
/** Menos filas que esto en una semana no alcanzan para decir que "el portal no
 * publicó la demanda": podría ser un día suelto sin exigencia. */
const MIN_FILAS_SEMANA = 10;

const aMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const aIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const lunesDe = (iso) => aIso(aMs(iso) - ((new Date(aMs(iso)).getUTCDay() + 6) % 7) * DIA_MS);

/**
 * El portal publica la demanda de la semana en curso en blanco (0 horas en TODOS
 * los locales) y recién la completa unos días después; mientras tanto el
 * cumplimiento queda en 0% y la pantalla de Presentismo SMU no muestra nada.
 *
 * Cuando TODA una semana del archivo viene sin demanda, se usa la del mismo día
 * de la semana anterior (mismo local) y el % se calcula como lo hace el portal:
 * horas / demanda, redondeado hacia arriba al entero y con tope 100. Si el
 * portal ya publicó la demanda real, esa fila llega con valor y esto no actúa;
 * y como el upsert pisa la fila, la cifra real reemplaza a la estimada sola.
 *
 * Una semana con algo de demanda NO se toca: un día sin exigencia ahí es real.
 * Devuelve cuántas filas se rellenaron.
 */
export async function rellenarSemanasEnBlanco(supabase, filas) {
  const porSemana = new Map();
  for (const f of filas) {
    const lunes = lunesDe(f.fecha);
    const g = porSemana.get(lunes) ?? { n: 0, demanda: 0 };
    g.n++;
    g.demanda += f.demanda_horas;
    porSemana.set(lunes, g);
  }
  const enBlanco = new Set([...porSemana].filter(([, g]) => g.n >= MIN_FILAS_SEMANA && g.demanda === 0).map(([l]) => l));
  if (enBlanco.size === 0) return 0;

  const objetivo = filas.filter((f) => enBlanco.has(lunesDe(f.fecha)));
  const fechasPrevias = [...new Set(objetivo.map((f) => aIso(aMs(f.fecha) - 7 * DIA_MS)))];
  const { data: previas, error } = await supabase
    .from("cumplimiento_smu")
    .select("sala_id, fecha, demanda_horas")
    .in("fecha", fechasPrevias)
    .limit(5000);
  if (error) throw new Error(`cumplimiento_smu (semana anterior): ${error.message}`);
  const demandaPrevia = new Map(previas.map((p) => [`${p.sala_id}|${p.fecha}`, Number(p.demanda_horas)]));

  let rellenadas = 0;
  for (const f of objetivo) {
    const previa = demandaPrevia.get(`${f.sala_id}|${aIso(aMs(f.fecha) - 7 * DIA_MS)}`);
    if (!(previa > 0)) continue;
    f.demanda_horas = previa;
    f.cumplimiento = Math.min(100, Math.ceil((f.horas_cumplidas / previa) * 100 - 1e-9));
    rellenadas++;
  }
  console.log(
    `Semana(s) ${[...enBlanco].join(", ")} sin demanda en el portal: ${rellenadas}/${objetivo.length} filas rellenadas con la semana anterior.`,
  );
  return rellenadas;
}
