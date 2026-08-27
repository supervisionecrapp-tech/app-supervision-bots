import XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

// Mismo criterio de reemplazo total que usa hoy la carga manual de
// "Documentos Pendientes de Firma" en panel-cliente.html (líneas ~4353-4455):
// esto NO es una carga incremental, cada corrida borra documentos_pendientes
// entero (cascada a documentos_pendientes_salas) y lo vuelve a insertar desde
// cero — es un snapshot de "lo que está pendiente hoy", no un historial.
//
// A diferencia de la carga manual (que recibe un Excel de RRHH ya con
// Cargo/Supervisor/Zona resueltos a mano), el reporte "Estado de Firma de
// Docs" del portal DEC solo trae RUT/nombre-de-documento — cargo/sala/
// supervisor/zona se resuelven acá cruzando contra la dotación propia, en
// dos niveles (ver resolverPersona más abajo).
export async function uploadDecReporte({ xlsxPath, supabaseUrl, supabaseServiceKey }) {
  const wb = XLSX.readFile(xlsxPath, { cellDates: false });
  // El nombre de la hoja de datos varía según el reporte (ej. "reporte_69398"),
  // igual que en la carga manual — se busca por header en vez de por nombre fijo.
  const sheetName = wb.SheetNames.find((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, raw: true, range: 0 });
    return rows.length > 0 && Object.keys(rows[0]).some((k) => k.trim() === "dni_firmante");
  });
  if (!sheetName) throw new Error(`Ninguna hoja de ${xlsxPath} tiene una columna "dni_firmante".`);

  const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: true }).map((r) => {
    const clean = {};
    for (const [k, v] of Object.entries(r)) clean[k.trim()] = v;
    return clean;
  });

  // Solo "pendiente de firma" — coincide con el filtro que ya se aplicó en
  // el portal (estado_documento="Pendiente"), esto es una guarda extra por
  // si el reporte trae algo más.
  const rows = raw.filter((r) => String(r["estado_documento"] || "").toUpperCase().includes("PENDIENTE"));

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const resolver = await buildResolver(supabase);

  const docRows = [];
  let descartadas = 0;
  for (const r of rows) {
    const rutRaw = cleanText(r["dni_firmante"]);
    const nombreDocumento = cleanText(r["descripcion"]);
    if (!rutRaw || !nombreDocumento) {
      descartadas++;
      continue;
    }

    const persona = resolver.resolve(rutRaw);
    if (!persona) {
      descartadas++;
      continue;
    }

    docRows.push({
      nombre_documento: nombreDocumento,
      rut: rutRaw,
      nombre_colaborador: persona.nombre,
      cargo: persona.cargo,
      is_part_time: esPartTime(persona.cargo),
      supervisor_nombre: persona.supervisorNombre,
      zona: persona.zona,
      sap_raw: persona.sap != null ? String(persona.sap) : null,
    });
  }

  console.log(
    `${rows.length} filas pendientes en el reporte, ${docRows.length} con persona resuelta ` +
      `(${descartadas} descartadas sin match en cbtrs_asignaciones/turnos_colaboradores).`,
  );

  // documentos_pendientes_salas cae en cascada al borrar el documento
  // (mismo comportamiento que la carga manual).
  const { error: delErr } = await supabase.from("documentos_pendientes").delete().not("id", "is", null);
  if (delErr) throw new Error(`borrar anteriores: ${delErr.message}`);

  const BATCH = 1000;
  let insertedDocs = [];
  for (let i = 0; i < docRows.length; i += BATCH) {
    const batch = docRows.slice(i, i + BATCH);
    const { data, error } = await supabase.from("documentos_pendientes").insert(batch).select("id, sap_raw");
    if (error) throw new Error(`documentos_pendientes: ${error.message}`);
    insertedDocs = insertedDocs.concat(data);
  }

  const salaJunctionRows = [];
  for (const doc of insertedDocs) {
    if (!doc.sap_raw) continue;
    // sap_raw acá siempre es un único código (viene de salas.sap, tier 1 del
    // resolver) — a diferencia de la carga manual no hay tokens "//"
    // múltiples, pero se resuelve igual contra salaBySap por consistencia.
    const salaId = resolver.salaIdBySap.get(doc.sap_raw) ?? null;
    salaJunctionRows.push({ documento_id: doc.id, sap_token: doc.sap_raw, sala_id: salaId });
  }
  for (let i = 0; i < salaJunctionRows.length; i += BATCH) {
    const batch = salaJunctionRows.slice(i, i + BATCH);
    const { error } = await supabase.from("documentos_pendientes_salas").insert(batch);
    if (error) throw new Error(`documentos_pendientes_salas: ${error.message}`);
  }

  return { total: rows.length, cargadas: insertedDocs.length, descartadas };
}

function normalizeRut(raw) {
  return (raw ?? "").toString().replace(/[.-]/g, "").toUpperCase();
}

// Confirmado en vivo con el usuario tras ver los cargos reales cargados: el
// texto "PART TIME" solo cubre el vocabulario de cbtrs_asignaciones
// (Cobertura) — turnos_colaboradores (roster GV, usado en el fallback)
// abrevia el mismo concepto como códigos de turno "W1"/"W2"/"W3" (ej.
// "VOLANTE W1", "CUBRE VACACIONES W1", "SUPERVISOR PART TIME W2") y como
// "MDJ"/"MJ" para media jornada (ej. "MDJ" solo, "CUBRE LICENCIA MJ") — el
// mismo concepto que "MEDIA JORNADA" en cbtrs_asignaciones, que tampoco
// contiene el texto "PART TIME" pese a ser part-time. Se detectan como
// tokens completos (con \b) para no confundir con substrings de otras
// palabras.
function esPartTime(cargo) {
  const c = (cargo ?? "").toUpperCase();
  return (
    c.includes("PART TIME") ||
    c.includes("MEDIA JORNADA") ||
    /\bW\d\b/.test(c) ||
    /\bM\.?D?J\b/.test(c)
  );
}

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Resuelve cargo/nombre/supervisor/zona/sap para un RUT en dos niveles:
//   1) cbtrs_asignaciones (Cobertura) — vigente hoy, da sala_id directo.
//   2) turnos_colaboradores (roster GV completo, sin exigir sala) — para
//      cargos excluidos de Cobertura (ej. AUDITOR) — el supervisor se
//      resuelve vía grupo_gv -> grupos_gv.nombre -> salas.grupo_gv_id ->
//      salas.supervisor_id, mismo join que ya usa la RLS policy de
//      turnos_colaboradores (20260821020000_turnos_extras_migracion.sql).
//      Sin sala_id propio, así que no entra a documentos_pendientes_salas.
// Si no hay match en ninguna de las dos, resolve() devuelve null y la fila
// se descarta (no hay cargo/nombre confiables para las columnas NOT NULL).
async function buildResolver(supabase) {
  const [asignaciones, salas, profiles, zonas, turnos, gruposGv] = await Promise.all([
    selectAll(supabase, "cbtrs_asignaciones", "rut, nombre_completo, sala_id, cargo, fecha_inicio, fecha_fin"),
    selectAll(supabase, "salas", "id, sap, supervisor_id, zona_id, grupo_gv_id"),
    selectAll(supabase, "profiles", "id, full_name"),
    selectAll(supabase, "zonas", "id, nombre"),
    selectAll(supabase, "turnos_colaboradores", "rut, nombre, grupo_gv, cargo, activo"),
    selectAll(supabase, "grupos_gv", "id, nombre"),
  ]);

  const salaById = new Map(salas.map((s) => [s.id, s]));
  const profileNombreById = new Map(profiles.map((p) => [p.id, p.full_name]));
  const zonaNombreById = new Map(zonas.map((z) => [z.id, z.nombre]));

  // Un grupo_gv puede tener varias salas — se toma la primera con
  // supervisor_id no nulo (mismo tipo de aproximación que documenta el join
  // de la RLS policy: solo confiable si todas las salas de un grupo apuntan
  // al mismo supervisor).
  const salaByGrupoGvId = new Map();
  for (const s of salas) {
    if (s.grupo_gv_id && s.supervisor_id && !salaByGrupoGvId.has(s.grupo_gv_id)) {
      salaByGrupoGvId.set(s.grupo_gv_id, s);
    }
  }
  const grupoGvIdByNombre = new Map(gruposGv.map((g) => [g.nombre, g.id]));

  // Tier 1: mejor asignación vigente hoy por RUT (misma lógica que
  // resolverAsignacion() en supabase/functions/cobertura-ausencias-sync/index.ts:
  // fecha_inicio <= hoy, fecha_fin null o >= hoy, se queda con la de
  // fecha_inicio más reciente si hay varias simultáneas).
  const hoy = todayIso();
  const mejorAsignacionPorRut = new Map();
  for (const a of asignaciones) {
    if (a.fecha_inicio > hoy) continue;
    if (a.fecha_fin != null && a.fecha_fin < hoy) continue;
    const rutNorm = normalizeRut(a.rut);
    const actual = mejorAsignacionPorRut.get(rutNorm);
    if (!actual || a.fecha_inicio > actual.fecha_inicio) mejorAsignacionPorRut.set(rutNorm, a);
  }

  const turnosPorRut = new Map();
  for (const t of turnos) {
    if (t.activo === false) continue;
    turnosPorRut.set(normalizeRut(t.rut), t);
  }

  const salaIdBySap = new Map(salas.filter((s) => s.sap != null).map((s) => [String(s.sap), s.id]));

  function resolve(rutRaw) {
    const rutNorm = normalizeRut(rutRaw);

    const asignacion = mejorAsignacionPorRut.get(rutNorm);
    if (asignacion) {
      const sala = salaById.get(asignacion.sala_id);
      return {
        nombre: asignacion.nombre_completo,
        cargo: asignacion.cargo,
        supervisorNombre: sala ? profileNombreById.get(sala.supervisor_id) ?? null : null,
        zona: sala ? zonaNombreById.get(sala.zona_id) ?? null : null,
        sap: sala ? sala.sap : null,
      };
    }

    const turno = turnosPorRut.get(rutNorm);
    if (turno) {
      const grupoId = grupoGvIdByNombre.get(turno.grupo_gv);
      const sala = grupoId ? salaByGrupoGvId.get(grupoId) : null;
      return {
        nombre: turno.nombre,
        cargo: turno.cargo,
        supervisorNombre: sala ? profileNombreById.get(sala.supervisor_id) ?? null : null,
        zona: sala ? zonaNombreById.get(sala.zona_id) ?? null : null,
        sap: null, // sin sala propia — no entra a documentos_pendientes_salas
      };
    }

    return null;
  }

  return { resolve, salaIdBySap };
}

async function selectAll(supabase, table, columns) {
  const PAGE = 1000;
  let from = 0;
  let all = [];
  for (;;) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}
