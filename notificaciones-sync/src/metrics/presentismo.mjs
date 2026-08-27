// Presentismo WM: % de horas realizadas vs. objetivo. Mismo scope y misma
// fórmula que mobile/src/hooks/useLobby.ts (agregado real/objetivo entre
// las salas del alcance, no promedio de porcentajes por sala).
const HOLDING_PRESENTISMO = "WALMART";
const CADENA_EXCLUIDA = "ACUENTA";

const DAY_COLS = [
  "horas_lunes",
  "horas_martes",
  "horas_miercoles",
  "horas_jueves",
  "horas_viernes",
  "horas_sabado",
  "horas_domingo",
];

function dayColForDate(date) {
  const day = date.getUTCDay(); // 0=domingo .. 6=sábado
  return DAY_COLS[day === 0 ? 6 : day - 1];
}

function salasPresentismo(salas) {
  return salas.filter((s) => s.holdings?.nombre === HOLDING_PRESENTISMO && s.cadenas?.nombre !== CADENA_EXCLUIDA);
}

/** % agregado + peor sala para una semana ISO puntual (anio/semana ya
 * cerrada — "semana pasada"). null si el alcance no tiene salas WM. */
export async function computeSemanaPasada(supabase, salas, anio, semana) {
  const scoped = salasPresentismo(salas);
  if (scoped.length === 0) return null;
  const salaIds = scoped.map((s) => s.id);

  const [{ data: objetivo, error: e1 }, { data: realizadas, error: e2 }] = await Promise.all([
    supabase
      .from("presentismo_horas_objetivo")
      .select("sala_id, horas_objetivo_total")
      .in("sala_id", salaIds)
      .eq("anio", anio)
      .eq("semana", semana),
    supabase
      .from("presentismo_horas_realizadas_por_sala")
      .select("sala_id, horas_realizadas_total")
      .in("sala_id", salaIds)
      .eq("anio", anio)
      .eq("semana", semana),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const realById = new Map((realizadas ?? []).map((r) => [r.sala_id, r.horas_realizadas_total ?? 0]));
  let sumTarget = 0;
  let sumReal = 0;
  let sobrecumplimiento = 0;
  let faltante = 0;
  let peorSala = null;
  let peorPct = Infinity;
  for (const row of objetivo ?? []) {
    const target = row.horas_objetivo_total ?? 0;
    if (target <= 0) continue;
    const real = realById.get(row.sala_id) ?? 0;
    sumTarget += target;
    // Se topa en el objetivo de la sala antes de sumar — el presentismo nunca
    // debe pasar de 100%, y el exceso de una sala no debe tapar el déficit de
    // otra en el agregado (mismo criterio que mobile/presentismo.tsx).
    sumReal += Math.min(real, target);
    // Documentado aparte, sin afectar el %: no se usa en la notificación por
    // defecto, pero queda disponible para quien consuma este metric.
    if (real > target) sobrecumplimiento += real - target;
    else faltante += target - real;
    const pct = real / target;
    if (pct < peorPct) {
      peorPct = pct;
      peorSala = scoped.find((s) => s.id === row.sala_id) ?? null;
    }
  }
  if (sumTarget === 0) return null;
  return { pct: sumReal / sumTarget, sobrecumplimiento, faltante, peorSalaNombre: peorSala?.nombre_geo ?? "—" };
}

/** % agregado del día en curso (semana ISO actual, columna del día de hoy),
 * mismo cálculo que useLobby.ts presentismoHoyPct. null si el alcance no
 * tiene salas WM o todavía no hay objetivo cargado para la semana actual. */
export async function computeHoy(supabase, salas, hoy, anio, semana) {
  const scoped = salasPresentismo(salas);
  if (scoped.length === 0) return null;
  const salaIds = scoped.map((s) => s.id);
  const col = dayColForDate(hoy);
  const fechaIso = hoy.toISOString().slice(0, 10);

  const [{ data: objetivo, error: e1 }, { data: realizadas, error: e2 }] = await Promise.all([
    supabase.from("presentismo_horas_objetivo").select(`sala_id, ${col}`).in("sala_id", salaIds).eq("anio", anio).eq("semana", semana),
    supabase.from("presentismo_horas_realizadas_por_sala_dia").select("sala_id, horas_realizadas").in("sala_id", salaIds).eq("fecha", fechaIso),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const realById = new Map((realizadas ?? []).map((r) => [r.sala_id, r.horas_realizadas ?? 0]));
  let sumTarget = 0;
  let sumReal = 0;
  let sobrecumplimiento = 0;
  let faltante = 0;
  for (const row of objetivo ?? []) {
    const target = row[col];
    if (target == null) continue;
    const real = realById.get(row.sala_id) ?? 0;
    sumTarget += target;
    // Tope por sala/día antes de sumar — ver nota en computeSemanaPasada().
    sumReal += Math.min(real, target);
    if (real > target) sobrecumplimiento += real - target;
    else faltante += target - real;
  }
  if (sumTarget === 0) return null;
  return { pct: sumReal / sumTarget, sobrecumplimiento, faltante };
}
