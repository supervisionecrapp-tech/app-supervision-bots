import { gvLogin, gvActiveUsers, gvAttendanceBookAll, gvUsersToFilas, normalizeRut, nowSantiagoYyyyMmDdHhMmSs, isoFromYyyyMmDd } from "./gv.mjs";

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
 * rut se normaliza porque GV no es consistente con mayúsculas/minúsculas
 * del RUT entre sus propios endpoints — sin esto el cruce fallaba en
 * silencio (mismo bug que el de grupo_gv en roster.mjs).
 *
 * Una persona con "ruta" tiene VARIAS asignaciones vigentes a la vez, una
 * por sala (ver migración 20260826080000) — esto es el caso normal para
 * esas personas, no una excepción. cbtrs_asignaciones no guarda calendario
 * ni día de la semana por sala, así que hoy no hay forma de saber en cuál
 * de sus salas estaba programada la persona el día puntual de la ausencia;
 * se elige la de fecha_inicio más reciente y, en empate, la de sala_id
 * menor (comparación de string) para que el resultado sea determinístico
 * y reproducible entre corridas — no para que sea necesariamente la sala
 * correcta. Si se llega a necesitar precisión real por sala/día para gente
 * con ruta, hace falta agregar esa información al esquema. */
function resolverAsignacion(asignacionesPorRut, rut, fechaISO) {
  const lista = asignacionesPorRut.get(normalizeRut(rut));
  if (!lista) return null;
  let mejor = null;
  for (const a of lista) {
    if (a.fecha_inicio > fechaISO) continue;
    if (a.fecha_fin != null && a.fecha_fin < fechaISO) continue;
    if (!mejor) { mejor = a; continue; }
    if (a.fecha_inicio > mejor.fecha_inicio) { mejor = a; continue; }
    if (a.fecha_inicio === mejor.fecha_inicio && String(a.sala_id) < String(mejor.sala_id)) mejor = a;
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
  // Una fila cuenta como "ausencia real que necesita cobertura" solo si:
  //  - GV la marca Absent="True" (como antes), Y
  //  - el turno ya empezó (comparado en hora Santiago) — GV puede marcar
  //    Absent="True" para un turno de esta tarde antes de que abra la
  //    ventana de marcaje, y eso no es una ausencia todavía, Y
  //  - no tiene un permiso/licencia/vacaciones aprobado ese día (TimeOffs) —
  //    si GV ya registró un permiso, no es una ausencia sin cobertura.
  // shift_begins (Shifts[].Begins) se asume en hora Santiago, no GMT0 —
  // verificado empíricamente contra datos reales sincronizados: la
  // distribución de turno_inicio_programado tiene su pico en 08:00 y se
  // concentra entre 07:00-17:00 (con casos sueltos a las 22:30), calzando
  // con un horario retail chileno normal. Si viniera en GMT0 ese pico
  // caería a las 04:00-05:00 hora Santiago, que no tiene sentido para
  // apertura de tienda — descartado.
  const nowSantiago = nowSantiagoYyyyMmDdHhMmSs();
  const filas = gvUsersToFilas(attendance).filter(
    (f) => f.absent && !f.timeoff_type && f.shift_begins && f.shift_begins <= nowSantiago,
  );

  const { data: asignaciones, error: asigError } = await supabase
    .from("cbtrs_asignaciones")
    .select("rut, sala_id, cargo, fecha_inicio, fecha_fin");
  if (asigError) throw new Error(asigError.message);
  const asignacionesPorRut = new Map();
  for (const a of asignaciones ?? []) {
    const key = normalizeRut(a.rut);
    if (!asignacionesPorRut.has(key)) asignacionesPorRut.set(key, []);
    asignacionesPorRut.get(key).push(a);
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

  // Reconciliación: si alguien que ya estaba guardado como ausente en este
  // rango dejó de aparecer como tal en esta corrida (marcó, le aprobaron un
  // permiso después, o el turno se movió), la fila vieja se borra siempre
  // — no debe quedar una ausencia fantasma en cbtrs_ausencias solo porque
  // ya tenía cobertura asignada.
  const { data: existentes, error: existError } = await supabase
    .from("cbtrs_ausencias")
    .select("id, rut, fecha")
    .gte("fecha", isoFromYyyyMmDd(desde))
    .lte("fecha", isoFromYyyyMmDd(hasta));
  if (existError) throw new Error(existError.message);
  const clavesAConservar = new Set(filasParaGuardar.map((f) => `${normalizeRut(f.rut)}|${f.fecha}`));
  const idsABorrar = (existentes ?? [])
    .filter((e) => !clavesAConservar.has(`${normalizeRut(e.rut)}|${e.fecha}`))
    .map((e) => e.id);
  if (idsABorrar.length > 0) {
    const { error: delError } = await supabase.from("cbtrs_ausencias").delete().in("id", idsABorrar);
    if (delError) throw new Error(delError.message);
  }

  const sinAsignacion = filasParaGuardar.filter((f) => f.sala_id == null).length;
  return { activos: activeUsers.length, ausencias: filasParaGuardar.length, sinAsignacion, borradas: idsABorrar.length };
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
