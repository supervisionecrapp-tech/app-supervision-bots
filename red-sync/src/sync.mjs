import { mkdirSync } from "node:fs";
import { scrapeRedExport } from "./scrape.mjs";
import { uploadRedFile } from "./upload.mjs";

// Misma fórmula que mobile/src/lib/isoWeek.ts (getIsoWeek) — el resto del
// sistema (Red/Teamcore) ya usa esta convención para anio/semana, hay que
// mantenerlas iguales.
function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { anio: d.getUTCFullYear(), semana };
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

  const now = new Date();
  const { anio, semana } = getIsoWeek(now);
  return { categoria, anio, mes: now.getMonth() + 1, semana };
}

async function main() {
  const { categoria, anio, mes, semana } = readArgs();
  const datawaltUser = requireEnv("DATAWALT_USER");
  const datawaltPass = requireEnv("DATAWALT_PASS");
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const downloadDir = "./downloads";
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
