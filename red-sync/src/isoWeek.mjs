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

// El árbol de filtro de Datawalt agrupa las semanas bajo el mes de SU
// LUNES, no bajo el mes del día 1 — verificado en vivo: la semana 31/2026
// (27 jul - 2 ago) aparece bajo Julio, no Agosto, aunque getIsoWeek(1 de
// agosto) devuelva 31. Sin este ajuste, selectWeek() en scrape.mjs cuenta
// mal cuántas filas hay que bajar dentro del mes expandido.
export function firstIsoWeekOfMonth(anio, mes) {
  const day1 = new Date(anio, mes - 1, 1);
  let { semana, anio: weekYear } = getIsoWeek(day1);
  const monday = isoWeekMonday(weekYear, semana);
  if (monday.getUTCMonth() + 1 !== mes) semana += 1;
  return semana;
}
