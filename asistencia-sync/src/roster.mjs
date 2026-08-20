import { createClient } from "@supabase/supabase-js";
import { gvLogin, gvActiveUsers, gvAttendanceBookAll, gvUsersToFilas, normalizeRut } from "./gv.mjs";

// Corre una vez al día (ver .github/workflows/asistencia-sync.yml) y
// mantiene `turnos_colaboradores` — el roster que usa la app móvil para
// elegir a quién asignarle un Turno Extra, scoped por supervisor vía
// grupo_gv → salas.grupo_gv_id → salas.supervisor_id (ver
// turnosQueries.ts / migración 20260821020000_turnos_extras_migracion.sql).
//
// Primera versión de este archivo pedía solo User/ActiveUsers asumiendo
// que traía GroupDescription (así lo describe la doc oficial, API-GV3.pdf)
// — probado contra la cuenta real de este proyecto y NO vino poblado en
// ningún caso (745/745 filas con grupo_gv null), dejando el picker vacío
// para todos los supervisores. Se corrige acá usando el mismo mecanismo
// que ya funciona en producción para asistencia_diaria: GroupDescription
// solo viene poblado en /AttendanceBook, no en /ActiveUsers (el comentario
// original de gv.mjs/ausencias-hoy tenía razón después de todo).
//
// Ventana de 14 días (no solo "hoy") para no perder de vista a alguien con
// turno rotativo que justo no trabajó en el rango pedido — se toma el
// grupo más reciente visto por persona. Todos los activos de ActiveUsers
// quedan igual en el roster aunque no tengan grupo en la ventana (mejor
// tenerlos sin grupo, filtrables solo por admin, que no tenerlos).
//
// "Activo" es la fuente de verdad de GV en el momento del pull: cualquier
// rut que ya no venga en ActiveUsers hoy se marca activo=false (nunca se
// borra la fila, para no perder el historial de turnos_extras que ya la
// referencia) — así un supervisor no ve para elegir a alguien que ya no
// trabaja ahí, a pedido explícito del usuario.

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

function fechaSantiago(offsetDias = 0) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" });
  const d = new Date(Date.now() + offsetDias * 86400000);
  return fmt.format(d);
}

const UPSERT_BATCH = 500;
const VENTANA_DIAS = 14;

async function sync(supabase) {
  const gvKey = requireEnv("GEOVICTORIA_KEY");
  const gvSecret = requireEnv("GEOVICTORIA_SECRET");

  const hoy = fechaSantiago(0);
  const desde = fechaSantiago(-VENTANA_DIAS).replaceAll("-", "");
  const hastaCompacto = hoy.replaceAll("-", "");

  const token = await gvLogin(gvKey, gvSecret);
  const activos = await gvActiveUsers(token);
  const activosConRut = activos.filter((u) => u.Identifier);

  const attendance = await gvAttendanceBookAll(
    token,
    activosConRut.map((u) => normalizeRut(u.Identifier)),
    { desde, hasta: hastaCompacto },
  );

  // gvUsersToFilas trae una fila por (persona, día con turno) en la
  // ventana — nos quedamos con la más reciente por rut para el grupo.
  const grupoPorRut = new Map();
  for (const fila of gvUsersToFilas(attendance)) {
    if (!fila.grupo_gv) continue;
    const actual = grupoPorRut.get(fila.rut);
    if (!actual || fila.fecha > actual.fecha) grupoPorRut.set(fila.rut, { grupo: fila.grupo_gv, fecha: fila.fecha });
  }

  const nowIso = new Date().toISOString();
  const filas = activosConRut.map((u) => {
    const rutNormalizado = normalizeRut(u.Identifier);
    return {
      rut: u.Identifier,
      nombre: `${u.Name ?? ""} ${u.LastName ?? ""}`.trim(),
      grupo_gv: grupoPorRut.get(rutNormalizado)?.grupo ?? null,
      activo: true,
      visto_el: hoy,
      updated_at: nowIso,
    };
  });

  for (let i = 0; i < filas.length; i += UPSERT_BATCH) {
    const { error } = await supabase.from("turnos_colaboradores").upsert(filas.slice(i, i + UPSERT_BATCH), { onConflict: "rut" });
    if (error) throw new Error(error.message);
  }

  // Cualquiera que no haya venido en el pull de hoy (visto_el < hoy) y
  // seguía marcado activo, pasa a inactivo — ya no aparece en el picker.
  const { error: inactivarError, count } = await supabase
    .from("turnos_colaboradores")
    .update({ activo: false, updated_at: nowIso }, { count: "exact" })
    .lt("visto_el", hoy)
    .eq("activo", true);
  if (inactivarError) throw new Error(inactivarError.message);

  const conGrupo = filas.filter((f) => f.grupo_gv).length;
  return { activos: filas.length, conGrupo, desactivados: count ?? 0 };
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
    console.log(`Listo: ${result.activos} activos (${result.conGrupo} con grupo), ${result.desactivados} marcados inactivos.`);
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
