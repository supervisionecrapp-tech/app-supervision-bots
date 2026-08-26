import { gvLogin, gvActiveUsers, gvAttendanceBookAll, gvUsersToFilas, normalizeRut } from "./gv.mjs";

// Núcleo compartido entre sync.mjs (corrida programada, mes en curso) y
// backfill.mjs (rango manual, ej. la carga inicial de agosto completo) —
// misma lógica de resolución sala/cargo y upsert para los dos casos.

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

const UPSERT_BATCH = 500;

/** Para un rut y fecha dados, busca la asignación vigente esa fecha
 * (fecha_inicio <= fecha <= fecha_fin, o fecha_fin null = sigue vigente).
 * Si hay más de una que matchea (no debería, pero por si acaso) se queda
 * con la de fecha_inicio más reciente. */
function resolverAsignacion(asignacionesPorRut, rut, fechaISO) {
  const lista = asignacionesPorRut.get(rut);
  if (!lista) return null;
  let mejor = null;
  for (const a of lista) {
    if (a.fecha_inicio > fechaISO) continue;
    if (a.fecha_fin != null && a.fecha_fin < fechaISO) continue;
    if (!mejor || a.fecha_inicio > mejor.fecha_inicio) mejor = a;
  }
  return mejor;
}

/** Ejecuta el sync para el rango [desde, hasta] (YYYYMMDD, formato GV) y
 * deja el resultado en cbtrs_ausencias. Solo se guardan los días donde la
 * persona figura Absent=true en GV (a diferencia de asistencia_diaria, que
 * guarda también los días trabajados) — cbtrs_ausencias es histórico de
 * AUSENCIAS, no de asistencia completa.
 *
 * El upsert NO toca estado/cubierto_por_rut/cubierto_por_nombre/
 * turno_extra_sugerido_id de una fila ya existente — esos son datos que el
 * admin pudo haber cargado manualmente en coberturas/admin.html, y
 * volver a correr el sync (programado o el botón "Actualizar") no debe
 * pisarlos. Solo se refrescan rut/nombre/sala/cargo/turno programado.
 */
export async function sync(supabase, { desde, hasta }) {
  const gvKey = requireEnv("GEOVICTORIA_KEY");
  const gvSecret = requireEnv("GEOVICTORIA_SECRET");

  const token = await gvLogin(gvKey, gvSecret);
  const activeUsers = await gvActiveUsers(token);
  const attendance = await gvAttendanceBookAll(
    token,
    activeUsers.filter((u) => u.Identifier).map((u) => normalizeRut(u.Identifier)),
    { desde, hasta },
  );
  const filas = gvUsersToFilas(attendance).filter((f) => f.absent);

  const { data: asignaciones, error: asigError } = await supabase
    .from("cbtrs_asignaciones")
    .select("rut, sala_id, cargo, fecha_inicio, fecha_fin");
  if (asigError) throw new Error(asigError.message);
  const asignacionesPorRut = new Map();
  for (const a of asignaciones ?? []) {
    if (!asignacionesPorRut.has(a.rut)) asignacionesPorRut.set(a.rut, []);
    asignacionesPorRut.get(a.rut).push(a);
  }

  const filasParaGuardar = filas.map((f) => {
    const asignacion = resolverAsignacion(asignacionesPorRut, f.rut, f.fecha);
    return {
      rut: f.rut,
      nombre_completo: f.nombre,
      fecha: f.fecha,
      sala_id: asignacion?.sala_id ?? null,
      // Cargo sale de GeoVictoria (PositionDescription) — Dotación
      // (asignacion.cargo) queda solo como respaldo si GV no lo trae.
      cargo: f.cargo ?? asignacion?.cargo ?? null,
      grupo_gv: f.grupo_gv ?? null,
      turno_inicio_programado: f.shift_begins ?? null,
      origen: "geovictoria",
    };
  });

  for (let i = 0; i < filasParaGuardar.length; i += UPSERT_BATCH) {
    const { error } = await supabase
      .from("cbtrs_ausencias")
      .upsert(filasParaGuardar.slice(i, i + UPSERT_BATCH), { onConflict: "rut,fecha" });
    if (error) throw new Error(error.message);
  }

  const sinAsignacion = filasParaGuardar.filter((f) => f.sala_id == null).length;
  return { activos: activeUsers.length, ausencias: filasParaGuardar.length, sinAsignacion };
}

export async function logRun(supabase, { bot, startedAt, status, errorMessage, filasCargadas }) {
  const { error } = await supabase.from("bot_runs").insert({
    bot,
    status,
    error_message: errorMessage ?? null,
    filas_cargadas: filasCargadas ?? null,
    started_at: startedAt,
  });
  if (error) console.error("No se pudo registrar la corrida en bot_runs:", error.message);
}
