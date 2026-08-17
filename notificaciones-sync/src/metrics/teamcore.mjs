// Teamcore Usabilidad: cumplimiento booleano por (sala, día) — no hay una
// métrica continua por día, así que el % siempre es "días cumplidos / días
// exigidos" sobre una ventana. Mismo criterio que useLobby.ts: domingo no
// exige Teamcore (6 días hábiles por semana ISO).
function salasTeamcore(salas) {
  return salas.filter((s) => s.usa_teamcore);
}

function diasHabilesSemana(lunes) {
  const dias = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(lunes);
    d.setUTCDate(lunes.getUTCDate() + i);
    dias.push(d.toISOString().slice(0, 10));
  }
  return dias; // lunes..sábado
}

/** % promedio entre salas + peor sala, para la semana ISO que terminó
 * (lunes = isoWeekMonday(anio, semana) de esa semana). null si no aplica. */
export async function computeSemanaPasada(supabase, salas, lunesSemana) {
  const scoped = salasTeamcore(salas);
  if (scoped.length === 0) return null;
  const salaIds = scoped.map((s) => s.id);
  const dias = diasHabilesSemana(lunesSemana);
  const desde = dias[0];
  const hasta = dias[dias.length - 1];

  const [{ data: registros, error: e1 }, { data: excepciones, error: e2 }] = await Promise.all([
    supabase.from("teamcore_usabilidad_registros").select("sala_id, fecha").in("sala_id", salaIds).gte("fecha", desde).lte("fecha", hasta),
    supabase.from("teamcore_excepciones").select("sala_id, fecha").in("sala_id", salaIds).gte("fecha", desde).lte("fecha", hasta),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const cumplidos = new Set((registros ?? []).map((r) => `${r.sala_id}|${r.fecha}`));
  const eximidos = new Set((excepciones ?? []).map((r) => `${r.sala_id}|${r.fecha}`));

  let sumaPct = 0;
  let peorSala = null;
  let peorPct = Infinity;
  for (const sala of scoped) {
    let exigidos = 0;
    let cumplidosSala = 0;
    for (const fecha of dias) {
      const key = `${sala.id}|${fecha}`;
      if (eximidos.has(key)) continue;
      exigidos++;
      if (cumplidos.has(key)) cumplidosSala++;
    }
    const pct = exigidos === 0 ? 1 : cumplidosSala / exigidos;
    sumaPct += pct;
    if (pct < peorPct) {
      peorPct = pct;
      peorSala = sala;
    }
  }
  return { pct: sumaPct / scoped.length, peorSalaNombre: peorSala?.nombre_geo ?? "—" };
}

/** % de cumplimiento mes-a-la-fecha (mismo cálculo que useLobby.ts
 * teamcoreMonthPct — el % "de avance" es acumulado desde el inicio del mes,
 * no un valor de un solo día booleano) + cantidad de salas propias que
 * todavía no marcan Teamcore HOY. */
export async function computeHoy(supabase, salas, hoy) {
  const scoped = salasTeamcore(salas);
  if (scoped.length === 0) return null;
  const salaIds = scoped.map((s) => s.id);
  const hoyIso = hoy.toISOString().slice(0, 10);
  const desdeMes = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1)).toISOString().slice(0, 10);

  const [{ data: registrosMes, error: e1 }, { data: excepcionesMes, error: e2 }] = await Promise.all([
    supabase.from("teamcore_usabilidad_registros").select("sala_id, fecha").in("sala_id", salaIds).gte("fecha", desdeMes).lte("fecha", hoyIso),
    supabase.from("teamcore_excepciones").select("sala_id, fecha").in("sala_id", salaIds).gte("fecha", desdeMes).lte("fecha", hoyIso),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const cumplidos = new Set((registrosMes ?? []).map((r) => `${r.sala_id}|${r.fecha}`));
  const eximidos = new Set((excepcionesMes ?? []).map((r) => `${r.sala_id}|${r.fecha}`));

  let diasHabilesTranscurridos = 0;
  for (let d = 1; d <= hoy.getUTCDate(); d++) {
    const fecha = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), d));
    if (fecha.getUTCDay() !== 0) diasHabilesTranscurridos++;
  }
  if (diasHabilesTranscurridos === 0) return null;

  let exigidos = 0;
  let cumplidosCount = 0;
  let pendientesHoy = 0;
  for (const sala of scoped) {
    for (let d = 1; d <= hoy.getUTCDate(); d++) {
      const fecha = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), d));
      if (fecha.getUTCDay() === 0) continue;
      const fechaIso = fecha.toISOString().slice(0, 10);
      const key = `${sala.id}|${fechaIso}`;
      if (eximidos.has(key)) continue;
      exigidos++;
      if (cumplidos.has(key)) cumplidosCount++;
    }
    const keyHoy = `${sala.id}|${hoyIso}`;
    if (!eximidos.has(keyHoy) && !cumplidos.has(keyHoy)) pendientesHoy++;
  }

  return {
    pct: exigidos === 0 ? null : Math.max(0, cumplidosCount / exigidos),
    nSalasPendientes: pendientesHoy,
  };
}
