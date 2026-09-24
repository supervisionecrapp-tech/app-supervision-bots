// Misma fórmula que mobile/src/lib/isoWeek.ts (getIsoWeek) — el resto del
// sistema (Red/Teamcore) ya usa esta convención para anio/semana.
export function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { anio: d.getUTCFullYear(), semana };
}

/** Lunes (UTC) de una semana ISO dada. */
export function isoWeekMonday(anio, semana) {
  const simple = new Date(Date.UTC(anio, 0, 1 + (semana - 1) * 7));
  const dow = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() - dow + 1);
  return monday;
}

/** Jueves (UTC) de una semana ISO dada — ver comentario de isoWeekOwnerMonth. */
export function isoWeekThursday(anio, semana) {
  const monday = isoWeekMonday(anio, semana);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  return thursday;
}

// El árbol de filtro de Datawalt agrupa las semanas bajo el mes de SU
// JUEVES (la misma convención de ISO-8601 que ya usa getIsoWeek para el
// año — d.setUTCDate(... + 4 - dayNum) ahí arriba apunta al jueves), NO
// bajo el mes de su lunes. Se creyó lo contrario y quedó así documentado
// hasta que un backfill real de las semanas 27-39/2026 lo desmintió: la
// semana 36/2026 (lunes 31/ago, jueves 3/sep) falló SIEMPRE al buscarla
// bajo Agosto porque Datawalt la tiene bajo Septiembre — confirmado
// mirando el árbol expandido real (debug-03a-filtro-mes-expandido.png de
// la corrida 36054215562: Agosto solo lista semanas 32-35). La semana
// 31/2026 (lunes 27/jul, jueves 30/jul) no lo delataba antes porque ahí
// lunes y jueves caen en el mismo mes — coincidencia, no evidencia de la
// regla real.
export function isoWeekOwnerMonth(anio, semana) {
  return isoWeekThursday(anio, semana).getUTCMonth() + 1;
}

export function firstIsoWeekOfMonth(anio, mes) {
  const day1 = new Date(anio, mes - 1, 1);
  let { semana, anio: weekYear } = getIsoWeek(day1);
  if (isoWeekOwnerMonth(weekYear, semana) !== mes) semana += 1;
  return semana;
}
