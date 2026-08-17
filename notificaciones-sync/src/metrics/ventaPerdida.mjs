// % de venta perdida = operacional / venta_clp_dia, agregado (suma sobre
// suma, no promedio de %) entre las salas del alcance — misma fórmula
// exacta que mobile/src/hooks/useLobby.ts:98 (confirmada contra el negocio,
// no es el mismo denominador que las columnas pct_* generadas en la base).
export async function computeSemanaPasada(supabase, salas, anio, semana) {
  if (salas.length === 0) return null;
  const salaIds = salas.map((s) => s.id);

  const { data: porSala, error } = await supabase
    .from("teamcore_venta_perdida_por_sala")
    .select("sala_id, venta_perdida_operacional_total, venta_clp_dia_total")
    .in("sala_id", salaIds)
    .eq("anio", anio)
    .eq("semana", semana);
  if (error) throw error;
  if (!porSala || porSala.length === 0) return null;

  let sumOperacional = 0;
  let sumVentaClp = 0;
  for (const row of porSala) {
    sumOperacional += row.venta_perdida_operacional_total ?? 0;
    sumVentaClp += row.venta_clp_dia_total ?? 0;
  }
  if (sumVentaClp === 0) return null;

  const { count, error: countError } = await supabase
    .from("teamcore_venta_perdida")
    .select("*", { count: "exact", head: true })
    .in("sala_id", salaIds)
    .eq("anio", anio)
    .eq("semana", semana)
    .gt("venta_perdida_operacional", 0);
  if (countError) throw countError;

  return { pct: sumOperacional / sumVentaClp, nProductos: count ?? 0 };
}
