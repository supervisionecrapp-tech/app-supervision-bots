import { mkdirSync } from "node:fs";
import { scrapeRedExport } from "./scrape.mjs";

// Informe puntual: baja el export de RED de UNA categoría para un mes entero
// y lo deja en DOWNLOAD_DIR. No toca Supabase.
const categoria = process.env.CATEGORIA || process.argv[2];
const anio = Number(process.env.ANIO || process.argv[3]);
const mes = Number(process.env.MES || process.argv[4]);
const downloadDir = process.env.DOWNLOAD_DIR || "./downloads-mes";
if (!categoria || !anio || !mes) throw new Error("Uso: CATEGORIA, ANIO y MES");
for (const n of ["DATAWALT_USER", "DATAWALT_PASS"]) if (!process.env[n]) throw new Error(`Falta ${n}`);
mkdirSync(downloadDir, { recursive: true });

let ultimoError;
for (let intento = 1; intento <= 3; intento++) {
  try {
    const f = await scrapeRedExport({
      categoria, anio, mes, semana: 0, mesCompleto: true,
      datawaltUser: process.env.DATAWALT_USER, datawaltPass: process.env.DATAWALT_PASS,
      downloadDir, waitMultiplier: intento,
    });
    console.log(`Archivo descargado: ${f}`);
    ultimoError = null;
    break;
  } catch (err) {
    ultimoError = err;
    console.error(`Intento ${intento} falló: ${err instanceof Error ? err.message : err}`);
  }
}
if (ultimoError) { console.error(ultimoError); process.exitCode = 1; }
