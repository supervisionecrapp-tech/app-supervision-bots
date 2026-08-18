import { createClient } from "@supabase/supabase-js";

// Corre ~3:00 AM Chile (ver .github/workflows/asistencia-sync.yml) — vacía
// la caché para arrancar el día en limpio. No hace falta preservar nada:
// el primer sync de las 7:00 vuelve a pedirle a GV el mes en curso completo
// (día 1 → hoy), así que el historial para las rachas se reconstruye solo.
// No toca asistencia_sync_estado — a esta hora ya pasaron horas desde el
// último sync de las 23:00, así que igual está vencido; si algún
// supervisor consulta entre las 3 y las 7, la Edge Function dispara su
// propio refresco en vivo sin ningún caso especial.

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  console.log("Vaciando caché de asistencia diaria...");
  const startedAt = new Date().toISOString();

  // rut nunca es null — condición siempre verdadera, forma estándar de
  // supabase-js para "delete de toda la tabla" sin filtro real.
  const { error, count } = await supabase.from("asistencia_diaria").delete({ count: "exact" }).not("rut", "is", null);

  if (error) {
    await supabase.from("bot_runs").insert({
      bot: "asistencia-sync-reset",
      status: "error",
      error_message: error.message.slice(0, 2000),
      started_at: startedAt,
    });
    throw new Error(error.message);
  }

  console.log(`Listo: ${count ?? 0} filas borradas.`);
  await supabase.from("bot_runs").insert({
    bot: "asistencia-sync-reset",
    status: "success",
    filas_cargadas: count ?? 0,
    started_at: startedAt,
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
