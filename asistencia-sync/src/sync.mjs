import { createClient } from "@supabase/supabase-js";
import { gvLogin, gvActiveUsers, gvAttendanceBookAll, gvUsersToFilas, normalizeRut, todaySantiagoYyyyMmDd, primerDiaMesSantiagoYyyyMmDd } from "./gv.mjs";

// Corre cada hora (7:00-23:00 Chile, ver .github/workflows/asistencia-sync.yml)
// y le pide a GV el mes en curso completo (día 1 → hoy) — igual que hacía
// la Edge Function ausencias-hoy en vivo — para dejar la caché
// `asistencia_diaria` fresca. La Edge Function ahora lee de acá primero, y
// solo hace su propio refresco en vivo si esta caché tiene más de 20 min
// (candado atómico claim_asistencia_refresh).

/** Reintenta `intentar()` hasta `maxIntentos` veces, con espera creciente
 * entre cada intento — mismo patrón que teamcore-sync/presentismo-sync.
 * Solo se loguea el resultado FINAL en bot_runs, no una fila por intento. */
async function withRetries(intentar, { maxIntentos = 3, esperaBaseMs = 30000 } = {}) {
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      return await intentar();
    } catch (err) {
      const esUltimo = intento === maxIntentos;
      console.error(`Intento ${intento}/${maxIntentos} falló: ${err instanceof Error ? err.message : err}`);
      if (esUltimo) throw err;
      const esperaMs = esperaBaseMs * intento;
      console.log(`Reintentando en ${Math.round(esperaMs / 1000)}s...`);
      await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

const UPSERT_BATCH = 500;

async function sync(supabase) {
  const gvKey = requireEnv("GEOVICTORIA_KEY");
  const gvSecret = requireEnv("GEOVICTORIA_SECRET");

  const fecha = todaySantiagoYyyyMmDd();
  const desde = primerDiaMesSantiagoYyyyMmDd();

  const token = await gvLogin(gvKey, gvSecret);
  const activeUsers = await gvActiveUsers(token);
  const attendance = await gvAttendanceBookAll(
    token,
    activeUsers.filter((u) => u.Identifier).map((u) => normalizeRut(u.Identifier)),
    { desde, hasta: fecha },
  );

  const filas = gvUsersToFilas(attendance);
  for (let i = 0; i < filas.length; i += UPSERT_BATCH) {
    const { error } = await supabase.from("asistencia_diaria").upsert(filas.slice(i, i + UPSERT_BATCH), { onConflict: "rut,fecha" });
    if (error) throw new Error(error.message);
  }

  const { error: estadoError } = await supabase
    .from("asistencia_sync_estado")
    .update({ last_updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (estadoError) throw new Error(estadoError.message);

  return { activos: activeUsers.length, filas: filas.length };
}

async function logRun(supabase, { startedAt, status, errorMessage, filasCargadas }) {
  const { error } = await supabase.from("bot_runs").insert({
    bot: "asistencia-sync",
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

  console.log("Sincronizando asistencia diaria (GeoVictoria)...");
  const startedAt = new Date().toISOString();

  try {
    const result = await withRetries(() => sync(supabase));
    console.log(`Listo: ${result.filas} filas cargadas (${result.activos} activos en GV).`);
    await logRun(supabase, { startedAt, status: "success", filasCargadas: result.filas });
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
