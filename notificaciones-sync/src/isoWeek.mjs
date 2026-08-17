// Copiado de bots/red-sync/src/isoWeek.mjs — misma fórmula que
// mobile/src/lib/isoWeek.ts (getIsoWeek), única convención de anio/semana
// usada en todo el sistema (Red/Teamcore/Presentismo/Venta Perdida).
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

/** anio/semana ISO de la semana anterior a la que contiene `date` — maneja
 * el rollover de año (semana 1 -> última semana del año anterior). */
export function previousIsoWeek(date) {
  const { anio, semana } = getIsoWeek(date);
  if (semana > 1) return { anio, semana: semana - 1 };
  const ultimaSemanaAnioAnterior = getIsoWeek(new Date(Date.UTC(anio - 1, 11, 28)));
  return ultimaSemanaAnioAnterior;
}

/** Hoy en huso horario de Chile, como Date a mediodía UTC (evita
 * corrimientos de día por TZ al comparar solo la fecha) — mismo patrón que
 * bots/teamcore-sync/src/sync.mjs readArgs(). */
export function hoyChile() {
  const hoyIso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
  return new Date(`${hoyIso}T12:00:00Z`);
}
