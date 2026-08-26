import { createClient } from "@supabase/supabase-js";
import { gvLogin, gvActiveUsers, gvAttendanceBookAll, gvUsersToFilas, normalizeRut } from "./gv.mjs";

// Corre una vez al día (ver .github/workflows/asistencia-sync.yml) y
// mantiene `turnos_colaboradores` — el roster que usa la app móvil para
// elegir a quién asignarle un Turno Extra, scoped por supervisor vía
// grupo_gv → salas.grupo_gv_id → salas.supervisor_id (ver
// turnosQueries.ts / migración 20260821020000_turnos_extras_migracion.sql).
// También lo usa Cobertura para pre-llenar cargo/fecha de contrato al
// asignar dotación.
//
// Dos fuentes distintas, confirmado contra la cuenta real de este proyecto
// (muestras crudas pedidas a propósito, no la doc oficial — que prometía
// GroupDescription en /User/List, /User/Get y /User/ActiveUsers, y en
// ninguno de los tres viene):
//   - /User/ActiveUsers (el mismo llamado que ya se usa para saber quién
//     está activo) también trae PositionDescription (cargo) y ContractDate
//     (fecha de contrato) por usuario, sin depender de ningún rango de
//     fechas — así que no hace falta pegarle a /User/List aparte, es
//     información redundante.
//   - GroupDescription solo viene poblado en /AttendanceBook, escaneando
//     una ventana ±días alrededor de hoy — deja sin grupo a quien no tuvo
//     ni tiene turno planificado en esa ventana (deshabilitado, sin turnos
//     este mes, etc.), pero no hay otra fuente para ese dato en esta cuenta.
//
// "Activo" es la fuente de verdad de GV en el momento del pull: cualquier
// rut que ya no venga en ActiveUsers hoy se marca activo=false (nunca se
// borra la fila, para no perder el historial de turnos_extras que ya la
// referencia).

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

// ContractDate viene como "yyyyMMddHHmmss" compacto (confirmado contra la
// cuenta real, ej. "20221201000000") — NO "yyyy-MM-dd HH:mm:ss" como dice
// la doc oficial (mismo desfase que ya tenían otros campos de fecha de GV
// en este proyecto). Se guarda solo la fecha.
function soloFecha(contractDate) {
  if (!contractDate) return null;
  const m = contractDate.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const UPSERT_BATCH = 500;
// Ventana simétrica ±15 días (antes 30 solo hacia atrás) — el caso que
// faltaba: alguien con fecha de contrato a futuro (ingresa en los
// próximos días) ya puede tener turno planificado en GV antes de que
// arranque, y solo mirando hacia atrás nunca se cruzaba. A costa de
// lotes más chicos por llamada a AttendanceBook
// (GV_MAX_REGISTROS_POR_LLAMADA / días) y por lo tanto más llamadas.
const VENTANA_DIAS_ATRAS = 15;
const VENTANA_DIAS_ADELANTE = 15;

async function sync(supabase) {
  const gvKey = requireEnv("GEOVICTORIA_KEY");
  const gvSecret = requireEnv("GEOVICTORIA_SECRET");

  const hoy = fechaSantiago(0);
  const desde = fechaSantiago(-VENTANA_DIAS_ATRAS).replaceAll("-", "");
  const hastaCompacto = fechaSantiago(VENTANA_DIAS_ADELANTE).replaceAll("-", "");

  const token = await gvLogin(gvKey, gvSecret);
  const activos = await gvActiveUsers(token);
  const activosConRut = activos.filter((u) => u.Identifier);

  // Cargo y fecha de contrato: ya vienen en el mismo ActiveUsers de arriba,
  // sin depender de fecha (ver comentario de cabecera).
  const datosPorRut = new Map();
  for (const u of activosConRut) {
    datosPorRut.set(normalizeRut(u.Identifier), {
      cargo: u.PositionDescription?.trim() || null,
      fechaContrato: soloFecha(u.ContractDate),
    });
  }

  // Grupo: solo sale de AttendanceBook — se toma el más reciente visto por
  // rut en la ventana ±días (ver comentario de cabecera).
  const attendance = await gvAttendanceBookAll(
    token,
    activosConRut.map((u) => normalizeRut(u.Identifier)),
    { desde, hasta: hastaCompacto },
  );
  // Clave normalizada en los dos lados del mapa — GV devuelve el
  // Identifier de AttendanceBook con su propio casing (ej. "20759542k",
  // con la "k" en minúscula) sin importar cómo se lo pedimos, así que si
  // acá se guarda sin normalizar y después se busca con normalizeRut()
  // (que pone la "k" en mayúscula), el .get() nunca calza y el grupo
  // queda en null aunque GV sí lo haya mandado — confirmado con un caso
  // real (20759542k) que en AttendanceBook trae grupo pero acá salía null.
  const grupoPorRut = new Map();
  for (const fila of gvUsersToFilas(attendance)) {
    if (!fila.grupo_gv) continue;
    const rutKey = normalizeRut(fila.rut);
    const actual = grupoPorRut.get(rutKey);
    if (!actual || fila.fecha > actual.fecha) grupoPorRut.set(rutKey, { grupo: fila.grupo_gv, fecha: fila.fecha });
  }

  const nowIso = new Date().toISOString();
  const filas = activosConRut.map((u) => {
    const rutNormalizado = normalizeRut(u.Identifier);
    const datos = datosPorRut.get(rutNormalizado);
    return {
      rut: u.Identifier,
      nombre: `${u.Name ?? ""} ${u.LastName ?? ""}`.trim(),
      grupo_gv: grupoPorRut.get(rutNormalizado)?.grupo ?? null,
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
