import { mkdirSync } from "node:fs";
import { scrapeRedExport } from "./scrape.mjs";
import { uploadRedFile } from "./upload.mjs";
import { getIsoWeek, isoWeekMonday } from "./isoWeek.mjs";

// El "mes" tiene que ser el mes del LUNES de la semana, no el mes
// calendario de "hoy" — Datawalt agrupa las semanas del árbol de filtro
// por el mes de su lunes (ver isoWeekMonday/firstIsoWeekOfMonth), y cerca
// de fin de mes eso puede diferir de now.getMonth(). Ej.: si hoy es
// martes 1 de septiembre pero el lunes de la semana actual fue 31 de
// agosto, la semana sigue agrupada bajo Agosto en el filtro.
function weekParamsFor(date) {
  const { anio: isoYear, semana } = getIsoWeek(date);
  const monday = isoWeekMonday(isoYear, semana);
  return { anio: monday.getUTCFullYear(), mes: monday.getUTCMonth() + 1, semana };
}

function readArgs() {
  // Inputs de workflow_dispatch llegan como env vars (ver el .yml);
  // corriendo local se pueden pasar como argumentos de línea de comando.
  const categoria = process.env.CATEGORIA || process.argv[2] || "NARTD";
  const anioArg = process.env.ANIO || process.argv[3];
  const mesArg = process.env.MES || process.argv[4];
  const semanaArg = process.env.SEMANA || process.argv[5];

  if (anioArg && mesArg && semanaArg) {
    return { categoria, anio: Number(anioArg), mes: Number(mesArg), semana: Number(semanaArg) };
  }

  // WEEKS_BACK=1 → semana anterior a la actual (usado la corrida de los
  // martes, ver .github/workflows/red-sync.yml). Default 0 = semana actual.
  const weeksBack = Number(process.env.WEEKS_BACK || 0);
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - weeksBack * 7);
  return { categoria, ...weekParamsFor(now) };
}

async function main() {
  const { categoria, anio, mes, semana } = readArgs();
  const datawaltUser = requireEnv("DATAWALT_USER");
  const datawaltPass = requireEnv("DATAWALT_PASS");
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  // Configurable para que las dos corridas del martes (semana actual +
  // semana anterior) no se pisen las capturas de debug entre sí.
  const downloadDir = process.env.DOWNLOAD_DIR || "./downloads";
  mkdirSync(downloadDir, { recursive: true });

  console.log(`Sincronizando Red ${categoria} — año ${anio}, semana ${semana} (mes ${mes})`);

  const filePath = await scrapeRedExport({
    categoria,
    anio,
    mes,
    semana,
    datawaltUser,
    datawaltPass,
    downloadDir,
  });
  console.log(`Archivo descargado: ${filePath}`);

  const result = await uploadRedFile({ filePath, categoria, anio, semana, supabaseUrl, supabaseServiceKey });
  console.log(`Listo: ${result.cargadas}/${result.total} filas cargadas (${result.descartadas} descartadas).`);
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
