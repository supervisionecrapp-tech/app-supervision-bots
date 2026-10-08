import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { scrapeCausasQuiebre } from "./scrape.mjs";
import { uploadCausasQuiebre } from "./upload.mjs";
import { getIsoWeek, isoWeekOwnerMonth, isoWeekThursday } from "./isoWeek.mjs";

// El "mes" es el del JUEVES de la semana (así agrupa Datawalt el árbol de
// filtro; ver isoWeekOwnerMonth).
function weekParamsFor(date) {
  const { anio: isoYear, semana } = getIsoWeek(date);
  const mes = isoWeekOwnerMonth(isoYear, semana);
  const anio = isoWeekThursday(isoYear, semana).getUTCFullYear();
  return { anio, mes, semana };
}

// Lista de semanas a cargar:
//  - ANIO/MES/SEMANA explícitos (o argumentos 2-4) → solo esa.
//  - SEMANAS=N → las últimas N semanas, de la actual hacia atrás (backfill).
//  - WEEKS_BACK=k → solo la semana de hace k semanas (default 0 = actual).
function readWeeks() {
  const anioArg = process.env.ANIO || process.argv[2];
  const mesArg = process.env.MES || process.argv[3];
  const semanaArg = process.env.SEMANA || process.argv[4];
  if (anioArg && mesArg && semanaArg) {
    return [{ anio: Number(anioArg), mes: Number(mesArg), semana: Number(semanaArg) }];
  }
  const n = Number(process.env.SEMANAS || 0);
  const desde = n > 0 ? 0 : Number(process.env.WEEKS_BACK || 0);
  const hasta = n > 0 ? n - 1 : desde;
  const out = [];
  for (let back = desde; back <= hasta; back++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - back * 7);
    out.push(weekParamsFor(d));
  }
  return out;
}

async function main() {
  const weeks = readWeeks();
  const datawaltUser = requireEnv("DATAWALT_USER");
  const datawaltPass = requireEnv("DATAWALT_PASS");
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const baseDir = process.env.DOWNLOAD_DIR || "./downloads";

  let fallidas = 0;
  for (const { anio, mes, semana } of weeks) {
    // Una carpeta por semana: las capturas de debug de una no pisan a otra.
    const downloadDir = `${baseDir}/s${semana}`;
    mkdirSync(downloadDir, { recursive: true });
    console.log(`Sincronizando Causas de quiebre — año ${anio}, semana ${semana} (mes ${mes})`);
    const startedAt = new Date().toISOString();
    try {
      const MAX_INTENTOS = 3;
      let filePath;
      let ultimoError;
      for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
        try {
          if (intento > 1) console.log(`Reintento ${intento}/${MAX_INTENTOS} (esperas x${intento})…`);
          filePath = await scrapeCausasQuiebre({
            anio,
            mes,
            semana,
            datawaltUser,
            datawaltPass,
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
      console.log(`Archivo descargado: ${filePath}`);

      const result = await uploadCausasQuiebre({ filePath, anio, semana, supabaseUrl, supabaseServiceKey });
      console.log(`Listo: ${result.cargadas}/${result.total} filas cargadas (${result.descartadas} descartadas).`);
      await logRun(supabase, { anio, mes, semana, startedAt, status: "success", filasCargadas: result.cargadas });
    } catch (err) {
      fallidas++;
      console.error(err);
      await logRun(supabase, {
        anio,
        mes,
        semana,
        startedAt,
        status: "error",
        errorMessage: String(err instanceof Error ? err.message : err).slice(0, 2000),
      });
    }
  }
  if (fallidas > 0) throw new Error(`${fallidas} de ${weeks.length} semanas fallaron.`);
}

async function logRun(supabase, { anio, mes, semana, startedAt, status, errorMessage, filasCargadas }) {
  const { error } = await supabase.from("bot_runs").insert({
    bot: "causas-quiebre-sync",
    categoria: null,
    anio,
    mes,
    semana,
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
