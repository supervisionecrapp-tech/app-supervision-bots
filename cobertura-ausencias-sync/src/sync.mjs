import { createClient } from "@supabase/supabase-js";
import { todaySantiagoYyyyMmDd, haceNDiasSantiagoYyyyMmDd } from "./gv.mjs";
import { sync, logRun, requireEnv } from "./core.mjs";

// Corrida programada (ver ../../.github/workflows/cobertura-ausencias-sync.yml).
// Ventana de 45 días hacia atrás (en vez de solo "mes en curso") para que la
// reconciliación (ver core.mjs) alcance a limpiar ausencias que dejaron de
// ser reales por una corrección tardía en GV (permiso aprobado después,
// turno reprogramado) aunque hayan caído en el mes anterior. El botón
// manual del admin (Edge Function) sigue limitado a rangos cortos por el
// timeout del gateway; este bot corre en GitHub Actions y no tiene esa
// restricción.
const DIAS_HACIA_ATRAS = 45;

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

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const hasta = todaySantiagoYyyyMmDd();
  const desde = haceNDiasSantiagoYyyyMmDd(DIAS_HACIA_ATRAS);

  console.log(`Sincronizando ausencias de Cobertura (GeoVictoria) ${desde}-${hasta}...`);
  const startedAt = new Date().toISOString();

  try {
    const result = await withRetries(() => sync(supabase, { desde, hasta }));
    console.log(`Listo: ${result.ausencias} ausencias (${result.activos} activos en GV, ${result.sinAsignacion} sin sala/cargo asignado en Dotación, ${result.borradas} reconciliadas/borradas).`);
    await logRun(supabase, { bot: "cobertura-ausencias-sync", startedAt, status: "success", filasCargadas: result.ausencias });
  } catch (err) {
    await logRun(supabase, {
      bot: "cobertura-ausencias-sync",
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
