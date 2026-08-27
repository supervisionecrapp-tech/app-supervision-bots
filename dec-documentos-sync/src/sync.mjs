import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { scrapeDecReporte } from "./scrape.mjs";
import { uploadDecReporte } from "./upload.mjs";

async function main() {
  const decUser = requireEnv("DEC_IDD_USER");
  const decPass = requireEnv("DEC_IDD_PASS");
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const downloadDir = process.env.DOWNLOAD_DIR || "./downloads";
  mkdirSync(downloadDir, { recursive: true });

  console.log("Sincronizando Documentos Pendientes de Firma (DEC)…");
  const startedAt = new Date().toISOString();

  try {
    // El login por Identidad Digital (Acepta) es la parte más frágil del
    // flujo (reCAPTCHA, timing) — reintenta con esperas crecientes, mismo
    // patrón que red-sync.
    const MAX_INTENTOS = 3;
    let xlsxPath;
    let ultimoError;
    for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
      try {
        if (intento > 1) console.log(`Reintento ${intento}/${MAX_INTENTOS}…`);
        xlsxPath = await scrapeDecReporte({
          decUser,
          decPass,
          downloadDir,
          waitMultiplier: intento,
        });
        ultimoError = null;
        break;
      } catch (err) {
        ultimoError = err;
        console.error(`Intento ${intento} falló: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (ultimoError) throw ultimoError;
    console.log(`Reporte descargado y descomprimido: ${xlsxPath}`);

    const result = await uploadDecReporte({ xlsxPath, supabaseUrl, supabaseServiceKey });
    console.log(`Listo: ${result.cargadas}/${result.total} filas cargadas (${result.descartadas} descartadas).`);

    await logRun(supabase, { startedAt, status: "success", filasCargadas: result.cargadas });
  } catch (err) {
    // Se registra el error en Supabase ANTES de relanzarlo — mismo criterio
    // que los demás bots (el step de GitHub Actions también queda rojo).
    await logRun(supabase, {
      startedAt,
      status: "error",
      errorMessage: String(err instanceof Error ? err.message : err).slice(0, 2000),
    });
    throw err;
  }
}

async function logRun(supabase, { startedAt, status, errorMessage, filasCargadas }) {
  const { error } = await supabase.from("bot_runs").insert({
    bot: "dec-documentos-sync",
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
