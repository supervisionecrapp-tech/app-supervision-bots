import XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

const COLS = {
  sala: "Sala",
  sku: "Sku-Item",
  dias: "Días sin venta OOS",
  fecha: "Última fecha de venta desde visita",
  stock: "Stock",
  prom: "Prom. Vta. Sem.",
  causa: "Última Causa Quiebre",
  venta: "Venta $ perdida OOS",
};

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// Excel (serial o Date) → "YYYY-MM-DD".
function isoDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Portada de la lógica de red-sync/upload.mjs: service_role, sin RLS.
export async function uploadCausasQuiebre({ filePath, anio, semana, supabaseUrl, supabaseServiceKey }) {
  const wb = // Sin cellDates: "Días sin venta OOS" trae celdas con valor 0 y formato de
  // fecha, que con cellDates salen como Date(1900) y Number() daba
  // -2209161600000 (fuera de rango del integer). La fecha real llega como
  // serial y la convierte isoDate().
  XLSX.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets["Export"];
  if (!ws) throw new Error(`El archivo no tiene una hoja "Export" (hojas: ${wb.SheetNames.join(", ")})`);

  const raw = XLSX.utils.sheet_to_json(ws, { defval: null });
  const headers = Object.keys(raw[0] ?? {});
  for (const c of Object.values(COLS)) {
    if (!headers.includes(c)) {
      throw new Error(`Falta la columna "${c}" en el export. Columnas encontradas: ${headers.join(", ")}`);
    }
  }

  // El export termina con una fila "Total" general y un bloque "Filtros
  // aplicados: ..." que dice qué semana quedó realmente filtrada. Se
  // verifica antes de cargar: mejor fallar que guardar otra semana con la
  // etiqueta de ésta.
  const nota = raw.map((r) => String(r[COLS.sala] ?? "")).find((t) => t.startsWith("Filtros aplicados"));
  if (nota) {
    const incluido = nota.match(/Incluido \((\d+)\)([^\n]*)/);
    const ok = incluido && incluido[1] === "1" && new RegExp(`\\b${semana} \\(Semana`).test(incluido[2]);
    if (!ok) {
      throw new Error(`El export no es solo la semana ${semana}: ${incluido ? incluido[0] : nota.slice(0, 200)}`);
    }
  } else {
    console.warn('El export no trae el bloque "Filtros aplicados" — no se pudo verificar la semana.');
  }

  // Filas de SKU reales: se descartan la "Total" de cada sala (sku = "Total"),
  // la "Total" general (sala = "Total") y la nota de filtros.
  const rows = raw.filter((r) => {
    const sala = r[COLS.sala];
    const sku = r[COLS.sku];
    return sala != null && sala !== "Total" && !String(sala).startsWith("Filtros aplicados") && sku != null && sku !== "Total";
  });
  if (rows.length === 0) throw new Error("El export no trae filas de SKU.");

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: salas, error: salasErr } = await supabase.from("salas").select("id, sap, nombre_cadem");
  if (salasErr) throw new Error(salasErr.message);
  const salaByKey = new Map();
  for (const s of salas) if (s.nombre_cadem) salaByKey.set(`${s.sap}-${s.nombre_cadem}`, s.id);

  const porClave = new Map();
  let descartadas = 0;
  for (const r of rows) {
    const salaId = salaByKey.get(String(r[COLS.sala]).trim());
    if (!salaId) {
      descartadas++;
      continue;
    }
    const skuTxt = String(r[COLS.sku]).trim();
    const corte = skuTxt.indexOf("-");
    const ean = corte > 0 ? skuTxt.slice(0, corte) : skuTxt;
    const nombre = corte > 0 ? skuTxt.slice(corte + 1) : null;
    porClave.set(`${salaId}|${ean}`, {
      sala_id: salaId,
      anio,
      semana,
      sku_ean: ean,
      sku_nombre: nombre,
      dias_sin_venta: num(r[COLS.dias]),
      ultima_fecha_venta: isoDate(r[COLS.fecha]),
      stock: num(r[COLS.stock]),
      prom_vta_sem: num(r[COLS.prom]),
      causa: r[COLS.causa] ?? null,
      venta_perdida: num(r[COLS.venta]),
    });
  }
  const upsertRows = [...porClave.values()];
  if (upsertRows.length === 0) throw new Error(`Ninguna de las ${rows.length} filas cruzó con la maestra de salas.`);

  // Se reemplaza la semana completa: lo que ya no viene en el BI no se queda.
  // El delete va después del upsert (en lotes) para que un fallo a medias no
  // deje la semana vacía.
  for (let i = 0; i < upsertRows.length; i += 500) {
    const { error } = await supabase
      .from("causas_quiebre")
      .upsert(upsertRows.slice(i, i + 500), { onConflict: "sala_id,anio,semana,sku_ean" });
    if (error) throw new Error(`causas_quiebre: ${error.message}`);
  }

  const vienen = new Set(upsertRows.map((r) => `${r.sala_id}|${r.sku_ean}`));
  const { data: existentes, error: exErr } = await supabase
    .from("causas_quiebre")
    .select("id, sala_id, sku_ean")
    .eq("anio", anio)
    .eq("semana", semana)
    .limit(100000);
  if (exErr) throw new Error(`causas_quiebre: ${exErr.message}`);
  const sobrantes = existentes.filter((e) => !vienen.has(`${e.sala_id}|${e.sku_ean}`)).map((e) => e.id);
  for (let i = 0; i < sobrantes.length; i += 200) {
    const { error } = await supabase.from("causas_quiebre").delete().in("id", sobrantes.slice(i, i + 200));
    if (error) throw new Error(`causas_quiebre: ${error.message}`);
  }
  if (sobrantes.length) console.log(`Se eliminaron ${sobrantes.length} filas de la semana ${semana} que el BI ya no trae.`);

  await supabase.from("cargas_causas_quiebre").insert({
    anio,
    semana,
    archivo_nombre: filePath.split(/[\\/]/).pop(),
    filas_excel: rows.length,
    filas_cargadas: upsertRows.length,
    filas_descartadas: descartadas,
  });

  return { total: rows.length, cargadas: upsertRows.length, descartadas, eliminadas: sobrantes.length };
}
