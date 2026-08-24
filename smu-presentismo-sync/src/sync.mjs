import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { scrapeSmuAccessExcel } from "./scrape.mjs";
import { uploadSmuAccessFile } from "./upload.mjs";

/** Mismo patrón de reintentos que teamcore-sync/presentismo-sync: espera
 * creciente entre intentos (60s, 120s, ...) para fallas transitorias de
 * red/login. Solo se loguea el resultado FINAL en bot_runs. */
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

function readArgs() {
  // FECHA opcional en formato YYYY-MM-DD (workflow_dispatch); default =
  // hoy en huso horario de Chile.
  const fechaArg = process.env.FECHA || process.argv[2];
  if (fechaArg) return { fecha: new Date(`${fechaArg}T12:00:00`) };

  const hoyChile = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
  return { fecha: new Date(`${hoyChile}T12:00:00`) };
}

async function main() {
  const { fecha } = readArgs();
  const smuUser = requireEnv("SMU_GV_USER");
  const smuPass = requireEnv("SMU_GV_PASS");
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const downloadDir = process.env.DOWNLOAD_DIR || "./downloads";
  mkdirSync(downloadDir, { recursive: true });

  const fechaIso = fecha.toISOString().slice(0, 10);
  console.log(`Sincronizando Presentismo SMU (Accesos) — fecha ${fechaIso}`);
  const startedAt = new Date().toISOString();

  try {
    const result = await withRetries(async () => {
      const filePath = await scrapeSmuAccessExcel({ fecha, smuUser, smuPass, downloadDir });
      console.log(`Archivo descargado: ${filePath}`);
      return uploadSmuAccessFile({ filePath, supabaseUrl, supabaseServiceKey });
    });
    console.log(
      `Listo: ${result.cargadas}/${result.total} filas cargadas (${result.descartadas} descartadas por datos incompletos, ${result.sinSala} sin sala reconocida).`,
    );

    await logRun(supabase, { fechaIso, startedAt, status: "success", filasCargadas: result.cargadas });
  } catch (err) {
    await logRun(supabase, {
      fechaIso,
      startedAt,
      status: "error",
      errorMessage: String(err instanceof Error ? err.message : err).slice(0, 2000),
    });
    throw err;
  }
}

async function logRun(supabase, { fechaIso, startedAt, status, errorMessage, filasCargadas }) {
  const { error } = await supabase.from("bot_runs").insert({
    bot: "smu-presentismo-sync",
    categoria: fechaIso,
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
