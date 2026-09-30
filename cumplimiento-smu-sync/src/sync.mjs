import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { scrapeCumplimientoExcel } from "./scrape.mjs";
import { uploadCumplimientoFile } from "./upload.mjs";

/** Mismo patrón de reintentos que smu-presentismo-sync. */
async function withRetries(intentar, { maxIntentos = 3, esperaBaseMs = 60000 } = {}) {
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

function isoChile(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(d);
}

function readArgs() {
  // DESDE/HASTA opcionales (YYYY-MM-DD, workflow_dispatch). Default: ayer y
  // hoy en huso Chile — hoy se va completando en el día y ayer se cierra con
  // las marcas que llegaron tarde.
  const hasta = process.env.HASTA || isoChile(new Date());
  const desde = process.env.DESDE || isoChile(new Date(Date.now() - 24 * 3600 * 1000));
  return { desde, hasta };
}

async function main() {
  const { desde, hasta } = readArgs();
  const smuUser = requireEnv("SMU_GV_USER");
  const smuPass = requireEnv("SMU_GV_PASS");
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const downloadDir = process.env.DOWNLOAD_DIR || "./downloads";
  mkdirSync(downloadDir, { recursive: true });

  console.log(`Sincronizando Cumplimiento SMU — ${desde} a ${hasta}`);
  const startedAt = new Date().toISOString();

  try {
    const result = await withRetries(async () => {
      const filePath = await scrapeCumplimientoExcel({ desde, hasta, smuUser, smuPass, downloadDir });
      console.log(`Archivo descargado: ${filePath}`);
      return uploadCumplimientoFile({ filePath, supabaseUrl, supabaseServiceKey });
    });
    console.log(
      `Listo: ${result.cargadas}/${result.total} filas cargadas (${result.noNuestras} de locales que no son nuestros, ${result.descartadas} descartadas por datos incompletos).`,
    );
    await logRun(supabase, { categoria: `${desde}_${hasta}`, startedAt, status: "success", filasCargadas: result.cargadas });
  } catch (err) {
    await logRun(supabase, {
      categoria: `${desde}_${hasta}`,
      startedAt,
      status: "error",
      errorMessage: String(err instanceof Error ? err.message : err).slice(0, 2000),
    });
    throw err;
  }
}

async function logRun(supabase, { categoria, startedAt, status, errorMessage, filasCargadas }) {
  const { error } = await supabase.from("bot_runs").insert({
    bot: "cumplimiento-smu-sync",
    categoria,
    status,
    error_message: errorMessage ?? null,
    filas_cargadas: filasCargadas ?? null,
    started_at: startedAt,
  });
  if (error) console.error("No se pudo registrar la corrida en bot_runs:", error.message);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
