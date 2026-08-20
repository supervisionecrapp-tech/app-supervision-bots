import { createClient } from "@supabase/supabase-js";
import { gvLogin, gvActiveUsers } from "./gv.mjs";

// Corre una vez al día (ver .github/workflows/asistencia-sync.yml) y
// mantiene `turnos_colaboradores` — el roster que usa la app móvil para
// elegir a quién asignarle un Turno Extra, scoped por supervisor vía
// grupo_gv → salas.grupo_gv_id → salas.supervisor_id (ver
// turnosQueries.ts / migración 20260821020000_turnos_extras_migracion.sql).
//
// A diferencia del sync horario de asistencia_diaria (que pide
// AttendanceBook, day-based), acá alcanza con una sola llamada a
// User/ActiveUsers: confirmado contra la doc oficial (API-GV3.pdf) que esa
// respuesta SÍ trae GroupDescription poblado (el comentario viejo en gv.mjs/
// ausencias-hoy que dice lo contrario aplica a la lógica de asistencia, no
// se toca acá para no arriesgar esa feature — ver nota en el plan de
// migración de Turnos Extras).
//
// "Activo" es la fuente de verdad de GV en el momento del pull: cualquier
// rut que ya no venga en la respuesta de hoy se marca activo=false (nunca
// se borra la fila, para no perder el historial de turnos_extras que ya la
// referencia) — así un supervisor no ve para elegir a alguien que ya no
// trabaja ahí, a pedido explícito del usuario.

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

function todaySantiagoYyyyMmDd() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}

const UPSERT_BATCH = 500;

async function sync(supabase) {
  const gvKey = requireEnv("GEOVICTORIA_KEY");
  const gvSecret = requireEnv("GEOVICTORIA_SECRET");

  const hoy = todaySantiagoYyyyMmDd();
  const token = await gvLogin(gvKey, gvSecret);
  const activos = await gvActiveUsers(token);

  const filas = activos
    .filter((u) => u.Identifier)
    .map((u) => ({
      rut: u.Identifier,
      nombre: `${u.Name ?? ""} ${u.LastName ?? ""}`.trim(),
      grupo_gv: u.GroupDescription || null,
      activo: true,
      visto_el: hoy,
      updated_at: new Date().toISOString(),
    }));

  for (let i = 0; i < filas.length; i += UPSERT_BATCH) {
    const { error } = await supabase.from("turnos_colaboradores").upsert(filas.slice(i, i + UPSERT_BATCH), { onConflict: "rut" });
    if (error) throw new Error(error.message);
  }

  // Cualquiera que no haya venido en el pull de hoy (visto_el < hoy) y
  // seguía marcado activo, pasa a inactivo — ya no aparece en el picker.
  const { error: inactivarError, count } = await supabase
    .from("turnos_colaboradores")
    .update({ activo: false, updated_at: new Date().toISOString() }, { count: "exact" })
    .lt("visto_el", hoy)
    .eq("activo", true);
  if (inactivarError) throw new Error(inactivarError.message);

  return { activos: filas.length, desactivados: count ?? 0 };
}

async function logRun(supabase, { startedAt, status, errorMessage, filasCargadas }) {
  const { error } = await supabase.from("bot_runs").insert({
    bot: "asistencia-sync-roster",
    status,
    error_message: errorMessage ?? null,
    filas_cargadas: filasCargadas ?? null,
    started_at: startedAt,
  });
  if (error) console.error("No se pudo registrar la corrida en bot_runs:", error.message);
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  console.log("Sincronizando roster de colaboradores (Turnos Extras) desde GeoVictoria...");
  const startedAt = new Date().toISOString();

  try {
    const result = await sync(supabase);
    console.log(`Listo: ${result.activos} activos, ${result.desactivados} marcados inactivos.`);
    await logRun(supabase, { startedAt, status: "success", filasCargadas: result.activos });
  } catch (err) {
    await logRun(supabase, {
      startedAt,
      status: "error",
      errorMessage: String(err instanceof Error ? err.message : err).slice(0, 2000),
    });
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
