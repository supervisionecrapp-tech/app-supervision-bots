import { createClient } from "@supabase/supabase-js";

import { getDestinatarios } from "./destinatarios.mjs";
import { sendPush } from "./onesignal.mjs";
import { getIsoWeek, hoyChile, isoWeekMonday, previousIsoWeek } from "./isoWeek.mjs";
import * as presentismo from "./metrics/presentismo.mjs";
import * as teamcore from "./metrics/teamcore.mjs";
import * as red from "./metrics/red.mjs";
import * as ventaPerdida from "./metrics/ventaPerdida.mjs";
import * as documentos from "./metrics/documentos.mjs";

const TITULOS = {
  "presentismo-semanal": "Presentismo",
  "teamcore-semanal": "Teamcore",
  "red-semanal": "Red",
  "venta-perdida-semanal": "Venta Perdida",
  "documentos-pendientes": "Documentos pendientes",
  "intradia-combinado": "Avance del día",
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

function formatPct(v) {
  return Math.round(v * 100);
}

/** Arma el mensaje personalizado de un destinatario para `tipo`, o null si
 * no aplica (sin salas del alcance, sin datos cargados esa semana, etc). */
async function buildMensaje(tipo, supabase, destinatario, fechas) {
  const { hoy, anio, semana, anioPasado, semanaPasada, lunesPasado } = fechas;
  const { salas, role, fullName } = destinatario;

  if (tipo === "presentismo-semanal") {
    const r = await presentismo.computeSemanaPasada(supabase, salas, anioPasado, semanaPasada);
    if (!r) return null;
    return `📊 Presentismo semana pasada: tu presentismo en WM fue de ${formatPct(r.pct)}%. La sala con menor rendimiento fue ${r.peorSalaNombre}.`;
  }

  if (tipo === "teamcore-semanal") {
    const r = await teamcore.computeSemanaPasada(supabase, salas, lunesPasado);
    if (!r) return null;
    return `Así cerró Teamcore la semana pasada: ${formatPct(r.pct)}%. Sala a reforzar: ${r.peorSalaNombre}.`;
  }

  if (tipo === "red-semanal") {
    const r = await red.computeSemanaPasada(supabase, salas, anioPasado, semanaPasada);
    if (!r) return null;
    const partes = [];
    if (r.nartd != null) partes.push(`NARTD ${formatPct(r.nartd)}%`);
    if (r.abi != null) partes.push(`ABI ${formatPct(r.abi)}%`);
    if (r.vsr != null) partes.push(`VSR ${formatPct(r.vsr)}%`);
    if (partes.length === 0) return null;
    return `Resultados de Red por categoría: ${partes.join(", ")}. Revisá el detalle en la app.`;
  }

  if (tipo === "venta-perdida-semanal") {
    const r = await ventaPerdida.computeSemanaPasada(supabase, salas, anioPasado, semanaPasada);
    if (!r) return null;
    return `📊 Venta Perdida semana pasada: ${formatPct(r.pct)}% de venta perdida en ${r.nProductos} productos. Ranking en la app.`;
  }

  if (tipo === "documentos-pendientes") {
    const n = await documentos.countPendientes(supabase, role === "admin" ? null : fullName);
    if (n <= 0) return null;
    return `Recordatorio: ${n} documentos de mercaderistas siguen pendientes de firma.`;
  }

  if (tipo === "intradia-combinado") {
    const [p, t] = await Promise.all([
      presentismo.computeHoy(supabase, salas, hoy, anio, semana),
      teamcore.computeHoy(supabase, salas, hoy),
    ]);
    if (!p || p.pct == null || !t || t.pct == null) return null;
    return `Avance del día — Presentismo ${formatPct(p.pct)}% / Teamcore ${formatPct(t.pct)}%. Salas pendientes de Teamcore: ${t.nSalasPendientes}.`;
  }

  throw new Error(`Tipo desconocido: ${tipo}`);
}

async function main() {
  const tipo = process.argv[2];
  if (!tipo || !TITULOS[tipo]) {
    throw new Error(`Uso: node src/index.mjs <tipo>. Tipos válidos: ${Object.keys(TITULOS).join(", ")}`);
  }

  const supabaseUrl = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const supabaseServiceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const startedAt = new Date().toISOString();
  console.log(`Notificaciones — tipo: ${tipo}`);

  try {
    // La bandeja de entrada solo guarda los últimos 3 días — se poda acá
    // en vez de con un cron aparte, aprovechando que este bot ya corre
    // varias veces al día entre los 5 workflows de notificaciones-sync.
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { error: purgeError } = await supabase.from("notificaciones").delete().lt("created_at", cutoff);
    if (purgeError) console.error("No se pudo podar la bandeja de notificaciones:", purgeError.message);

    const hoy = hoyChile();
    const { anio, semana } = getIsoWeek(hoy);
    const { anio: anioPasado, semana: semanaPasada } = previousIsoWeek(hoy);
    const fechas = { hoy, anio, semana, anioPasado, semanaPasada, lunesPasado: isoWeekMonday(anioPasado, semanaPasada) };

    const destinatarios = await getDestinatarios(supabase);
    console.log(`${destinatarios.length} destinatarios activos con cuenta vinculada.`);

    let enviados = 0;
    let conDatos = 0;
    for (const destinatario of destinatarios) {
      let message;
      try {
        message = await buildMensaje(tipo, supabase, destinatario, fechas);
      } catch (err) {
        console.error(`No se pudo calcular "${tipo}" para ${destinatario.fullName}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!message) continue;
      conDatos++;

      const { error: insertError } = await supabase.from("notificaciones").insert({
        auth_user_id: destinatario.authUserId,
        tipo,
        titulo: TITULOS[tipo],
        mensaje: message,
      });
      if (insertError) {
        console.error(`No se pudo guardar en la bandeja de ${destinatario.fullName}: ${insertError.message}`);
      }

      try {
        await sendPush(destinatario.authUserId, TITULOS[tipo], message);
        enviados++;
      } catch (err) {
        console.error(`No se pudo enviar a ${destinatario.fullName}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`${conDatos}/${destinatarios.length} tenían datos para esta notificación — ${enviados} push enviados.`);

    await logRun(supabase, { tipo, startedAt, status: "success", filasCargadas: enviados });
  } catch (err) {
    await logRun(supabase, {
      tipo,
      startedAt,
      status: "error",
      errorMessage: String(err instanceof Error ? err.message : err).slice(0, 2000),
    });
    throw err;
  }
}

async function logRun(supabase, { tipo, startedAt, status, errorMessage, filasCargadas }) {
  const { error } = await supabase.from("bot_runs").insert({
    bot: "notificaciones-sync",
    categoria: tipo,
    status,
    error_message: errorMessage ?? null,
    filas_cargadas: filasCargadas ?? null,
    started_at: startedAt,
  });
  if (error) console.error("No se pudo registrar la corrida en bot_runs:", error.message);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
