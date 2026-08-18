import { createClient } from "@supabase/supabase-js";

// Misma lógica que la sección "Teamcore — Venta Perdida" de
// admin-panel.html (recálculo de "operacional" + upsert), portada a
// Node. Ver los comentarios ahí para el detalle de cada decisión (por
// qué se descartan stock_nulo/comercial, por qué se dedupea por
// sala+producto, etc.) — no repetidos acá para no divergir con el tiempo
// entre las dos copias.
//
// A DIFERENCIA de admin-panel.html, acá el parser SÍ respeta comillas.
// Confirmado descargando un CSV real del portal (semana 33, "VP REAL"):
// el nombre de producto viene entre comillas con comas adentro cuando el
// nombre las tiene, ej. `"AGUA AQUARIUS PET 1.6 LT, UVA"` o
// `"VINO MEDALL REAL CAB SAU 13,5° X12 V 750"` (la coma es del separador
// decimal del grado alcohólico). El comentario original de
// admin-panel.html decía "sin comas dentro de campos, verificado con el
// archivo real" — evidentemente no contra un archivo con estos
// productos; con un split(",") ingenuo esas filas quedan con las
// columnas corridas (todo lo que sigue al nombre del producto cae en el
// campo equivocado). admin-panel.html queda con ese bug preexistente sin
// tocar acá (fuera de alcance de este bot), pero el bot no lo hereda.
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCsv(text) {
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function numOrNull(v) {
  const s = (v ?? "").trim();
  return s === "" ? null : Number(s);
}

const VP_INDICADORES = [
  "venta_perdida_stock_negativo",
  "venta_perdida_stock_cero",
  "venta_perdida_instock",
  "venta_perdida_ajuste",
  "venta_perdida_osa",
];

export async function uploadVentaPerdidaFile({ filePath, supabaseUrl, supabaseServiceKey }) {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(filePath, "utf8");
  const raw = parseCsv(text);

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data: salas, error: salasErr } = await supabase.from("salas").select("id, sap_teamcore");
  if (salasErr) throw new Error(salasErr.message);
  const salaByTeamcore = new Map(salas.filter((s) => s.sap_teamcore != null).map((s) => [String(s.sap_teamcore), s.id]));

  const upsertRows = [];
  let descartadas = 0;
  for (const r of raw) {
    const salaId = salaByTeamcore.get(String(r["codigo_local_proveedor"]).trim());
    if (!salaId) {
      descartadas++;
      continue;
    }

    const indicadores = {};
    for (const col of VP_INDICADORES) indicadores[col] = numOrNull(r[col]);
    const presentes = Object.values(indicadores).filter((v) => v !== null);
    const operacional = presentes.length > 0 ? presentes.reduce((a, b) => a + b, 0) : null;

    upsertRows.push({
      sala_id: salaId,
      proveedor: r["cliente"].trim(),
      anio: Number(r["year"]),
      semana: Number(r["week"]),
      producto: r["producto"].trim(),
      venta_clp_dia: numOrNull(r["venta_clp_dia"]),
      venta_perdida_stock_negativo: indicadores.venta_perdida_stock_negativo,
      venta_perdida_stock_cero: indicadores.venta_perdida_stock_cero,
      venta_perdida_instock: indicadores.venta_perdida_instock,
      venta_perdida_ajuste: indicadores.venta_perdida_ajuste,
      venta_perdida_osa: indicadores.venta_perdida_osa,
      venta_perdida_operacional: operacional,
      cargado_at: new Date().toISOString(),
    });
  }

  // Ver el comentario equivalente en admin-panel.html: Postgres no acepta
  // dos filas con la misma llave de conflicto en el mismo upsert.
  const dedupMap = new Map();
  for (const row of upsertRows) {
    const key = `${row.sala_id}|${row.proveedor}|${row.anio}|${row.semana}|${row.producto}`;
    dedupMap.set(key, row);
  }
  const deduped = [...dedupMap.values()];

  // Reemplazo COMPLETO por semana — ver el comentario equivalente en
  // admin-panel.html (misma decisión, mismo motivo: una rectificación no
  // debe dejar filas huérfanas de productos que salieron del archivo
  // nuevo). Se borra por (anio, semana) antes de insertar; normalmente un
  // solo par por corrida, pero se recorre por si el CSV trajera más de
  // una semana.
  const semanasEnArchivo = [...new Set(deduped.map((r) => `${r.anio}|${r.semana}`))]
    .map((k) => { const [anio, semana] = k.split("|").map(Number); return { anio, semana }; });
  for (const { anio, semana } of semanasEnArchivo) {
    console.log(`Reemplazando carga previa de la semana ${semana}/${anio} (si existía)...`);
    const { error: delErr } = await supabase.from("teamcore_venta_perdida").delete().eq("anio", anio).eq("semana", semana);
    if (delErr) throw new Error(delErr.message);
  }

  const BATCH = 1000;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH);
    const { error } = await supabase.from("teamcore_venta_perdida").insert(batch);
    if (error) throw new Error(error.message);
    console.log(`  lote ${i / BATCH + 1}: ${batch.length} filas OK`);
  }

  await limpiarSemanasViejas(supabase);

  return { total: raw.length, cargadas: deduped.length, descartadas, duplicadas: upsertRows.length - deduped.length };
}

// Retención: solo se conservan las últimas VP_RETENCION_SEMANAS semanas
// cargadas — al pasar de esa cantidad, se borra la más antigua en cada
// corrida nueva. Mismo criterio y misma implementación que
// admin-panel.html#limpiarSemanasViejasVentaPerdida — mantenidas
// separadas a propósito (una es Node, la otra browser+supabase-js UMD).
const VP_RETENCION_SEMANAS = 5;
async function limpiarSemanasViejas(supabase) {
  // Se consulta la vista agregada por sala (no la tabla base) para no
  // traer las ~23k filas de detalle solo para saber qué semanas existen.
  const { data: rows, error } = await supabase.from("teamcore_venta_perdida_por_sala").select("anio, semana");
  if (error) {
    console.error(`No se pudo revisar el histórico para limpiar semanas viejas: ${error.message}`);
    return;
  }
  const semanas = [...new Map(rows.map((r) => [`${r.anio}-${r.semana}`, r])).values()]
    .sort((a, b) => b.anio - a.anio || b.semana - a.semana);
  const aBorrar = semanas.slice(VP_RETENCION_SEMANAS);
  for (const { anio, semana } of aBorrar) {
    console.log(`Histórico > ${VP_RETENCION_SEMANAS} semanas: borrando semana ${semana}/${anio}...`);
    const { error: delErr } = await supabase.from("teamcore_venta_perdida").delete().eq("anio", anio).eq("semana", semana);
    if (delErr) console.error(`  no se pudo borrar semana ${semana}/${anio}: ${delErr.message}`);
  }
}
