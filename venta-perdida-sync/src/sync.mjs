import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { requestVentaPerdida, collectVentaPerdida, jobNameFor, parseJobName, targetWeekForToday } from "./scrape.mjs";
import { uploadVentaPerdidaFile } from "./upload.mjs";

// Mismo helper que teamcore-sync/presentismo-sync — ver esos para el
// detalle. Se usa solo dentro de cada fase por separado, no entre fases.
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

function hoyChile() {
  const hoyStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
  return new Date(`${hoyStr}T12:00:00Z`);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

async function logRun(supabase, { bot, categoria, startedAt, status, errorMessage, filasCargadas }) {
  const { error } = await supabase.from("bot_runs").insert({
    bot,
    categoria,
    status,
    error_message: errorMessage ?? null,
    filas_cargadas: filasCargadas ?? null,
    started_at: startedAt,
  });
  if (error) console.error("No se pudo registrar la corrida en bot_runs:", error.message);
}

/** Filas de bot_runs de HOY (Chile) para este bot, la más reciente
 * primero — usado por "retry" para decidir qué le falta a la corrida de
 * hoy sin necesitar ningún estado propio. */
async function runsDeHoy(supabase, today) {
  const inicioHoy = today.toISOString().slice(0, 10) + "T00:00:00-04:00"; // Chile continental, sin horario de verano
  const { data, error } = await supabase
    .from("bot_runs")
    .select("categoria, status, started_at")
    .eq("bot", "venta-perdida-sync")
    .gte("started_at", inicioHoy)
    .order("started_at", { ascending: false });
  if (error) throw new Error(`No se pudo leer bot_runs: ${error.message}`);
  return data || [];
}

async function runRequest({ supabase, teamcoreUser, teamcorePass, today }) {
  const { week, year } = targetWeekForToday(today);
  const jobName = jobNameFor({ week, year, today });
  const startedAt = new Date().toISOString();
  console.log(`Solicitando Venta Perdida — hoy ${today.toISOString().slice(0, 10)} (Chile), semana objetivo ${year}-W${week}`);
  try {
    const result = await withRetries(() => requestVentaPerdida({ teamcoreUser, teamcorePass, week, year, jobName }));
    console.log(`Job solicitado: "${result.jobName}".`);
    await logRun(supabase, { bot: "venta-perdida-sync", categoria: `request:${result.jobName}`, startedAt, status: "success" });
  } catch (err) {
    await logRun(supabase, {
      bot: "venta-perdida-sync",
      categoria: `request:${jobName}`,
      startedAt,
      status: "error",
      errorMessage: String(err instanceof Error ? err.message : err).slice(0, 2000),
    });
    throw err;
  }
}

async function doCollect({ supabase, teamcoreUser, teamcorePass, supabaseUrl, supabaseServiceKey, downloadDir, jobName, categoria }) {
  const startedAt = new Date().toISOString();
  try {
    const result = await withRetries(
      async () => {
        const filePath = await collectVentaPerdida({ teamcoreUser, teamcorePass, jobName, downloadDir });
        console.log(`Archivo descargado: ${filePath}`);
        return uploadVentaPerdidaFile({ filePath, supabaseUrl, supabaseServiceKey });
      },
      { maxIntentos: 2 }, // cada intento ya espera hasta su propio timeout de polling adentro
    );
    console.log(
      `Listo: ${result.cargadas} filas cargadas (${result.descartadas} sin sala reconocida` +
        (result.duplicadas > 0 ? `, ${result.duplicadas} duplicadas combinadas` : "") +
        `, ${result.total} filas en el CSV).`,
    );
    await logRun(supabase, { bot: "venta-perdida-sync", categoria, startedAt, status: "success", filasCargadas: result.cargadas });
    return true;
  } catch (err) {
    await logRun(supabase, {
      bot: "venta-perdida-sync",
      categoria,
      startedAt,
      status: "error",
      errorMessage: String(err instanceof Error ? err.message : err).slice(0, 2000),
    });
    throw err;
  }
}

async function runCollect({ supabase, teamcoreUser, teamcorePass, supabaseUrl, supabaseServiceKey, downloadDir, today }) {
  const { week, year } = targetWeekForToday(today);
  const jobName = jobNameFor({ week, year, today });
  console.log(`Buscando job de hoy: "${jobName}"`);
  await doCollect({ supabase, teamcoreUser, teamcorePass, supabaseUrl, supabaseServiceKey, downloadDir, jobName, categoria: "collect" });
}

/** Reintento automático (workflow aparte, corrido más tarde el mismo
 * día): si el collect de hoy ya quedó success, no hace nada. Si no, mira
 * el último "request:<jobName>" de hoy — si fue exitoso, solo reintenta
 * collect para ESE jobName (evita pedirle al portal el mismo reporte dos
 * veces); si también falló o no existe, reintenta el flujo completo
 * (request + collect) para la semana que le tocaba a hoy. */
async function runRetry({ supabase, teamcoreUser, teamcorePass, supabaseUrl, supabaseServiceKey, downloadDir, today }) {
  const runs = await runsDeHoy(supabase, today);

  const yaOk = runs.find((r) => r.categoria === "collect" && r.status === "success");
  if (yaOk) {
    console.log(`El collect de hoy ya se completó OK a las ${yaOk.started_at} — nada que reintentar.`);
    return;
  }

  const ultimaRequestOk = runs.find((r) => r.categoria.startsWith("request:") && r.status === "success");
  if (ultimaRequestOk) {
    const jobName = ultimaRequestOk.categoria.slice("request:".length);
    const semana = parseJobName(jobName);
    console.log(`Reintento: la solicitud de hoy ("${jobName}"${semana ? `, semana ${semana.year}-W${semana.week}` : ""}) ya se había hecho — solo reintento la descarga/carga.`);
    await doCollect({ supabase, teamcoreUser, teamcorePass, supabaseUrl, supabaseServiceKey, downloadDir, jobName, categoria: "retry:collect" });
    return;
  }

  console.log("Reintento: no hay ninguna solicitud exitosa hoy todavía — repito el flujo completo (request + collect).");
  const { week, year } = targetWeekForToday(today);
  const jobName = jobNameFor({ week, year, today });
  const startedAt = new Date().toISOString();
  try {
    await withRetries(() => requestVentaPerdida({ teamcoreUser, teamcorePass, week, year, jobName }));
    await logRun(supabase, { bot: "venta-perdida-sync", categoria: `retry:request:${jobName}`, startedAt, status: "success" });
  } catch (err) {
    await logRun(supabase, {
      bot: "venta-perdida-sync",
      categoria: `retry:request:${jobName}`,
      startedAt,
      status: "error",
      errorMessage: String(err instanceof Error ? err.message : err).slice(0, 2000),
    });
    throw err;
  }
  await doCollect({ supabase, teamcoreUser, teamcorePass, supabaseUrl, supabaseServiceKey, downloadDir, jobName, categoria: "retry:collect" });
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "request" && mode !== "collect" && mode !== "retry") {
    throw new Error(`Modo inválido "${mode}" — usar "request", "collect" o "retry" (ver package.json).`);
  }

  const teamcoreUser = requireEnv("TEAMCORE_USER");
  const teamcorePass = requireEnv("TEAMCORE_PASS");
  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const today = hoyChile();

  if (mode === "request") {
    await runRequest({ supabase, teamcoreUser, teamcorePass, today });
    return;
  }

  const downloadDir = process.env.DOWNLOAD_DIR || "./downloads";
  mkdirSync(downloadDir, { recursive: true });

  if (mode === "collect") {
    await runCollect({ supabase, teamcoreUser, teamcorePass, supabaseUrl, supabaseServiceKey, downloadDir, today });
    return;
  }

  await runRetry({ supabase, teamcoreUser, teamcorePass, supabaseUrl, supabaseServiceKey, downloadDir, today });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
