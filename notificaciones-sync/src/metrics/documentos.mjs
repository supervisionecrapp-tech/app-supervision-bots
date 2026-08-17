// Documentos pendientes de mercaderistas a cargo — mismo matching que
// mobile/src/app/(app)/(tabs)/indicadores/documentos.tsx (cargo ILIKE
// MERCADERISTA + supervisor_nombre normalizado contra profiles.full_name),
// pero recalculado a mano porque el bot corre con service_role y no pasa
// por las policies de RLS que hacen ese filtro del lado de Postgres
// (supabase/migrations/20260813050000_documentos_pendientes.sql).
function normalizeSupervisorName(raw) {
  return (raw ?? "")
    .toUpperCase()
    .trim()
    .replace(/\s*-\s*RG\s*$/i, "");
}

/** Cuenta pendientes de mercaderistas para UN supervisor/coordinador
 * (por nombre normalizado), o el total global si `fullName` es null
 * (alcance admin). */
export async function countPendientes(supabase, fullName) {
  const { data, error } = await supabase.from("documentos_pendientes").select("supervisor_nombre, cargo").ilike("cargo", "%MERCADERISTA%");
  if (error) throw error;

  if (fullName == null) return (data ?? []).length;

  const target = normalizeSupervisorName(fullName);
  return (data ?? []).filter((d) => normalizeSupervisorName(d.supervisor_nombre) === target).length;
}
