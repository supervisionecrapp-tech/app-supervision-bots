import { createClient } from "@supabase/supabase-js";
import { sync, logRun, requireEnv } from "./core.mjs";

// Carga puntual de un rango arbitrario — usado la primera vez para traer
// agosto completo antes de que exista un histórico. No corre programado
// (no está en el workflow); se ejecuta a mano:
//
//   GEOVICTORIA_KEY=... GEOVICTORIA_SECRET=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node src/backfill.mjs --desde 20260801 --hasta 20260826
//
// Sin argumentos, por defecto trae agosto 2026 completo (hasta hoy si el
// mes todavía no terminó).

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--desde") out.desde = argv[++i];
    if (argv[i] === "--hasta") out.hasta = argv[++i];
  }
  return out;
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const args = parseArgs(process.argv.slice(2));
  const desde = args.desde ?? "20260801";
  const hoyStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("-", "");
  const hasta = args.hasta ?? (hoyStr < "20260831" ? hoyStr : "20260831");

  console.log(`Backfill de ausencias Cobertura (GeoVictoria) ${desde}-${hasta}...`);
  const startedAt = new Date().toISOString();

  try {
    const result = await sync(supabase, { desde, hasta });
    console.log(`Listo: ${result.ausencias} ausencias (${result.activos} activos en GV, ${result.sinAsignacion} sin sala/cargo asignado en Dotación, ${result.borradas} reconciliadas/borradas).`);
    await logRun(supabase, { bot: "cobertura-ausencias-sync-backfill", startedAt, status: "success", filasCargadas: result.ausencias });
  } catch (err) {
    await logRun(supabase, {
      bot: "cobertura-ausencias-sync-backfill",
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
