import { createClient } from "@supabase/supabase-js";
import { gvLogin, gvActiveUsers, gvUserList, normalizeRut } from "./gv.mjs";

// Corre una vez al día (ver .github/workflows/asistencia-sync.yml) y
// mantiene `turnos_colaboradores` — el roster que usa la app móvil para
// elegir a quién asignarle un Turno Extra, scoped por supervisor vía
// grupo_gv → salas.grupo_gv_id → salas.supervisor_id (ver
// turnosQueries.ts / migración 20260821020000_turnos_extras_migracion.sql).
// También lo usa Cobertura para pre-llenar cargo/fecha de contrato al
// asignar dotación.
//
// Primera versión de este archivo pedía solo User/ActiveUsers asumiendo
// que traía GroupDescription (así lo describe la doc oficial, API-GV3.pdf)
// — probado contra la cuenta real de este proyecto y NO vino poblado en
// ningún caso (745/745 filas con grupo_gv null). Una segunda versión lo
// sacaba escaneando AttendanceBook de los últimos 14 días, pero eso deja
// sin grupo/cargo a cualquiera que no haya tenido un turno planificado en
// esa ventana (de licencia larga, recién ingresado, etc.).
//
// Versión actual: /User/List (https://wiki.geovictoria.com/knowledge-base/user-list/)
// trae GroupDescription, PositionDescription y ContractDate directo por
// usuario, sin depender de ningún rango de fechas — no requiere parámetros
// y no hay que escanear turnos.
//
// "Activo" sigue siendo la fuente de verdad de GV en el momento del pull
// (ActiveUsers, no Enabled de User/List — no se cambia ese criterio):
// cualquier rut que ya no venga en ActiveUsers hoy se marca activo=false
// (nunca se borra la fila, para no perder el historial de turnos_extras
// que ya la referencia).

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

// ContractDate viene como "yyyy-MM-dd HH:mm:ss" — se guarda solo la fecha.
function soloFecha(contractDate) {
  if (!contractDate) return null;
  const m = contractDate.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

const UPSERT_BATCH = 500;

async function sync(supabase) {
  const gvKey = requireEnv("GEOVICTORIA_KEY");
  const gvSecret = requireEnv("GEOVICTORIA_SECRET");

  const hoy = fechaSantiago(0);

  const token = await gvLogin(gvKey, gvSecret);
  const [activos, userList] = await Promise.all([gvActiveUsers(token), gvUserList(token)]);
  const activosConRut = activos.filter((u) => u.Identifier);

  const datosPorRut = new Map();
  for (const u of userList) {
    if (!u.Identifier) continue;
    datosPorRut.set(normalizeRut(u.Identifier), {
      grupo: u.GroupDescription?.trim() || null,
      cargo: u.PositionDescription?.trim() || null,
      fechaContrato: soloFecha(u.ContractDate),
    });
  }

  const nowIso = new Date().toISOString();
  const filas = activosConRut.map((u) => {
    const datos = datosPorRut.get(normalizeRut(u.Identifier));
    return {
      rut: u.Identifier,
      nombre: `${u.Name ?? ""} ${u.LastName ?? ""}`.trim(),
      grupo_gv: datos?.grupo ?? null,
      cargo: datos?.cargo ?? null,
      fecha_contrato: datos?.fechaContrato ?? null,
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
