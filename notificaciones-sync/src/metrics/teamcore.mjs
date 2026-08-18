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

/** % de salas propias que YA marcaron Teamcore HOY sobre las que lo
 * necesitan hoy (no eximidas) — "cómo vas hoy", no acumulado del mes (a
 * diferencia de useLobby.ts teamcoreMonthPct, que es para la pantalla de
 * indicadores, no para un aviso de "avance del día"). null si hoy es
 * domingo (Teamcore no se exige) o si todas las salas están eximidas hoy. */
export async function computeHoy(supabase, salas, hoy) {
  const scoped = salasTeamcore(salas);
  if (scoped.length === 0 || hoy.getUTCDay() === 0) return null;
  const salaIds = scoped.map((s) => s.id);
  const hoyIso = hoy.toISOString().slice(0, 10);

  const [{ data: registrosHoy, error: e1 }, { data: excepcionesHoy, error: e2 }] = await Promise.all([
    supabase.from("teamcore_usabilidad_registros").select("sala_id").in("sala_id", salaIds).eq("fecha", hoyIso),
    supabase.from("teamcore_excepciones").select("sala_id").in("sala_id", salaIds).eq("fecha", hoyIso),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const cumplidos = new Set((registrosHoy ?? []).map((r) => r.sala_id));
  const eximidos = new Set((excepcionesHoy ?? []).map((r) => r.sala_id));

  let exigidos = 0;
  let cumplidosCount = 0;
  for (const sala of scoped) {
    if (eximidos.has(sala.id)) continue;
    exigidos++;
    if (cumplidos.has(sala.id)) cumplidosCount++;
  }
  if (exigidos === 0) return null;

  return { pct: cumplidosCount / exigidos, nSalasPendientes: exigidos - cumplidosCount };
}
