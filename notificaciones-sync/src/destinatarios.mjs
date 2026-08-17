// Trae todos los profiles activos con cuenta ya vinculada (auth_user_id —
// sin eso no hay external_id que targetear en OneSignal) y les resuelve sus
// salas: propias (supervisor_id/coordinador_id) para supervisor/coordinador,
// todas para admin (alcance global, aprobado explícitamente).
export async function getDestinatarios(supabase) {
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, auth_user_id, full_name, role, rut")
    .eq("is_active", true)
    .not("auth_user_id", "is", null)
    .in("role", ["supervisor", "coordinador", "admin"]);
  if (profilesError) throw profilesError;

  const { data: salas, error: salasError } = await supabase
    .from("salas")
    .select("id, nombre_geo, supervisor_id, coordinador_id, usa_teamcore, holdings(nombre), cadenas(nombre)")
    .eq("is_active", true);
  if (salasError) throw salasError;

  return profiles.map((p) => {
    const propias = salas.filter((s) => s.supervisor_id === p.id || s.coordinador_id === p.id);
    return {
      profileId: p.id,
      authUserId: p.auth_user_id,
      fullName: p.full_name,
      role: p.role,
      rut: p.rut,
      salas: p.role === "admin" ? salas : propias,
    };
  });
}
