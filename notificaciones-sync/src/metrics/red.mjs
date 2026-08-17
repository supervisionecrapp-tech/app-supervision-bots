// Red por categoría — promedio simple de red_pct entre las salas del
// alcance para la semana ISO pasada, misma idea que getRedPromedios() en
// mobile/src/db/localQueries.ts pero fijado a "semana pasada" en vez de
// "última semana cargada".
const TABLAS = { nartd: "red_nartd", abi: "red_abi", vsr: "red_vsr" };

async function promedioCategoria(supabase, tabla, salaIds, anio, semana) {
  const { data, error } = await supabase.from(tabla).select("red_pct").in("sala_id", salaIds).eq("anio", anio).eq("semana", semana);
  if (error) throw error;
  const valores = (data ?? []).map((r) => r.red_pct).filter((v) => v != null);
  if (valores.length === 0) return null;
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

/** {nartd, abi, vsr} en 0-1 (o null si esa categoría no tiene datos para la
 * semana), promediado sobre TODAS las salas del alcance (sin filtrar por
 * usa_teamcore ni holding — Red aplica en general). null si el alcance no
 * tiene salas. */
export async function computeSemanaPasada(supabase, salas, anio, semana) {
  if (salas.length === 0) return null;
  const salaIds = salas.map((s) => s.id);
  const [nartd, abi, vsr] = await Promise.all([
    promedioCategoria(supabase, TABLAS.nartd, salaIds, anio, semana),
    promedioCategoria(supabase, TABLAS.abi, salaIds, anio, semana),
    promedioCategoria(supabase, TABLAS.vsr, salaIds, anio, semana),
  ]);
  if (nartd == null && abi == null && vsr == null) return null;
  return { nartd, abi, vsr };
}
