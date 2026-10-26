// Punto de entrada.
//   npm run start -- envio <envio_id> [si|no]   un envío configurado en el portal
//                                                (si = disparado a mano)
//   npm run start -- salas_foco <zona|todas> <destinatarios>   prueba suelta
//   npm run start -- comparativo <zona> [destinatarios]   informe de la zona + 3 hojas
//                                                (otras zonas) de comparación
//   npm run start -- resumen_zonas <destinatarios>   los informes de todas las zonas en un
//                                                    solo correo para Mauro, con el uso de la app de Talca
//   npm run start -- prueba <destinatarios>
//   npm run start -- alarmas [dias]   alarmas B2B del correo → catálogo de promociones
// Con SOLO_ARCHIVO=<carpeta> los PDF se guardan ahí y no se envía nada.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { enviarCorreo, REMITENTE } from "./correo.mjs";
import { cargarAlarmas, completarResumenAlarmas, volcarResumenAlarmas } from "./alarmas.mjs";
import { cargarDatos, armarZona, aPdf, pct, clp, esc, diaLargo, diaMes, masDias, titulo } from "./salas_foco.mjs";
import { cargarExtrasGestion, registrarCompromisos } from "./gestion.mjs";
import { htmlGestion } from "./gestion_html.mjs";
import { htmlEjecutivo, paginasPdf } from "./ejecutivo_html.mjs";
import { htmlComparativo } from "./comparativo_html.mjs";
import { generarIncidencias } from "./incidencias.mjs";

// Por defecto sale el informe ejecutivo (3 páginas, para gerencia). FORMATO=detallado
// arma el informe de gestión completo (fichas por supervisor, anexos).
const DETALLADO = process.env.FORMATO === "detallado";
const MAX_PAGINAS = 3;

const [modo = "prueba", arg1, arg2] = process.argv.slice(2);

function supabase() {
  const url = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}


/** Hora de Chile de un instante, "dd/mm HH:MM". */
const horaChile = (d) => (d ? new Date(d).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "") : "–");

/** Instante en que empieza una fecha (YYYY-MM-DD) en hora de Chile. */
function inicioChile(f) {
  const d = new Date(`${f}T12:00:00Z`);
  const off = (new Date(d.toLocaleString("en-US", { timeZone: "America/Santiago" })) - new Date(d.toLocaleString("en-US", { timeZone: "UTC" }))) / 3600000;
  return new Date(new Date(`${f}T00:00:00Z`).getTime() - off * 3600000);
}

/** Uso de la app por los supervisores de una zona: encuestas de la última semana cerrada y la última encuesta. */
async function usoApp(sb, datos, zonaNombre) {
  const zona = datos.zonas.find((z) => z.nombre.toLowerCase() === zonaNombre.toLowerCase());
  if (!zona) throw new Error(`Zona ${zonaNombre} no encontrada`);
  const { data: salas, error } = await sb.from("salas").select("supervisor_id").eq("zona_id", zona.id).eq("is_active", true).not("supervisor_id", "is", null);
  if (error) throw new Error(`salas: ${error.message}`);
  const ids = [...new Set(salas.map((s) => s.supervisor_id))];
  const { data: sups, error: e2 } = await sb.from("profiles").select("id, full_name").in("id", ids).eq("role", "supervisor").eq("is_active", true);
  if (e2) throw new Error(`profiles: ${e2.message}`);
  const desde = datos.lunes.toISOString().slice(0, 10);
  const hasta = masDias(datos.lunes, 7).toISOString().slice(0, 10);
  const filas = [];
  for (const sp of [...sups].sort((a, b) => a.full_name.localeCompare(b.full_name, "es"))) {
    const { count } = await sb.from("encuesta_visitas").select("id", { count: "exact", head: true }).eq("promotor_id", sp.id)
      .gte("created_at", inicioChile(desde).toISOString()).lt("created_at", inicioChile(hasta).toISOString());
    const { data: ult } = await sb.from("encuesta_visitas").select("created_at").eq("promotor_id", sp.id).order("created_at", { ascending: false }).limit(1);
    filas.push({ nombre: titulo(sp.full_name), encuestas: count ?? 0, ultimaEncuesta: ult?.[0]?.created_at });
  }
  return { filas, desde, rango: `${diaMes(datos.lunes)}–${diaMes(masDias(datos.lunes, 6))}` };
}

/** Arma los PDF de las zonas pedidas (null = todas) y el cuerpo del correo. */
async function generarSalasFoco(sb, zonaId, incluirVisitas) {
  const datos = await cargarDatos(sb, { incluirVisitas });
  const zonas = zonaId ? datos.zonas.filter((z) => z.id === zonaId) : [...datos.zonas].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  if (!zonas.length) throw new Error(`Zona ${zonaId} no encontrada`);
  const armadas = zonas.map((z) => armarZona(datos, z.id)).filter((z) => z.salasZona.length);
  // Informe de gestión: problemas por sala, compromisos y su seguimiento.
  const htmls = [];
  for (const z of armadas) {
    const extras = await cargarExtrasGestion(sb, datos, z);
    const n = await registrarCompromisos(sb, datos, z, extras);
    console.log(`${z.zona}: ${extras.problemas.length} problemas, ${n} compromisos registrados, ${extras.previos.length} de la semana anterior.`);
    htmls.push(DETALLADO ? htmlGestion(datos, z, extras) : htmlEjecutivo(datos, z, extras));
  }
  const pdfs = await aPdf(htmls);
  if (!DETALLADO) pdfs.forEach((b, i) => {
    const n = paginasPdf(b);
    if (n > MAX_PAGINAS) throw new Error(`El informe ejecutivo de ${armadas[i].zona} salió de ${n} páginas (máx. ${MAX_PAGINAS})`);
  });
  const sem = datos.semanas[2].semana;
  const fecha = datos.emitido.toISOString().slice(0, 10);

  const adjuntos = armadas.map((z, i) => ({
    filename: `informe_${z.zona.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_")}_gestion_semanal_${fecha}.pdf`,
    content: pdfs[i], contentType: "application/pdf",
  }));

  const resumenZona = (z) => {
    const w = z.ind[2];
    const fila = (l, v, meta) => `<td style="padding:2px 10px 2px 0">${l}</td><td style="padding:2px 18px 2px 0;font-weight:600;color:${v == null ? "#6b7280" : v >= meta ? "#15803d" : "#b91c1c"}">${pct(v)}</td>`;
    const vis = z.visitas;
    const visTxt = !incluirVisitas ? "" : vis.length
      ? `<p style="margin:6px 0 0">Visitas del ${diaLargo(datos.ayer)}: <b>${vis.length}</b> en ${new Set(vis.map((v) => v.sala)).size} salas.</p>`
      : `<p style="margin:6px 0 0;color:#6b7280">Sin visitas registradas el ${diaLargo(datos.ayer)}.</p>`;
    return `<div style="margin:14px 0"><b style="font-size:15px">${esc(z.zona)}</b>
      <table style="border-collapse:collapse;margin-top:4px;font-size:13px">
        <tr>${fila("NARTD", w.nartd, z.metas.red_nartd)}${fila("ABI", w.abi, z.metas.red_abi)}${fila("VSR", w.vsr, z.metas.red_vsr)}</tr>
        <tr>${fila("Pres. SMU", w.SMU, z.metas.presentismo)}${fila("Pres. WM", w.WM, z.metas.presentismo)}<td style="padding:2px 10px 2px 0">Vta. perdida Cadem</td><td style="font-weight:600">${clp(z.cadem.total)}</td></tr>
      </table>${visTxt}</div>`;
  };
  const html = `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1f2937">
    <p>Adjunto el informe semanal de gestión${armadas.length > 1 ? ", uno por zona" : ""} (semana ${sem}): indicadores contra meta, comparativa general por supervisor, plan de trabajo, salas con oportunidad por indicador y venta perdida por supervisor y sala.</p>
    ${armadas.map(resumenZona).join("")}
    <p style="color:#6b7280;font-size:12px">Rojo = fuera de meta. El PDF son 3 páginas; el detalle por sala y por SKU está en el portal.</p></div>`;
  const asunto = `${armadas.length === 1 ? armadas[0].zona : "Zonas"} · Informe semanal de gestión · Semana ${sem}`;
  return { adjuntos, html, asunto };
}

async function guardarOEnviar({ para, cc, asunto, html, adjuntos }) {
  if (process.env.SOLO_ARCHIVO) {
    await mkdir(process.env.SOLO_ARCHIVO, { recursive: true });
    for (const a of adjuntos) await writeFile(path.join(process.env.SOLO_ARCHIVO, a.filename), a.content);
    await writeFile(path.join(process.env.SOLO_ARCHIVO, "correo.html"), html);
    console.log(`Guardado en ${process.env.SOLO_ARCHIVO}: ${adjuntos.map((a) => a.filename).join(", ")}`);
    return;
  }
  await enviarCorreo({ para, cc, asunto, html, adjuntos });
}

const modos = {
  async prueba() {
    const ahora = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    await enviarCorreo({
      para: arg1 || REMITENTE,
      asunto: "Prueba de envío de informes",
      html: `<p>Este es un correo de prueba enviado desde GitHub Actions.</p><p style="color:#888">Enviado el ${ahora}</p>`,
    });
  },

  async salas_foco() {
    const sb = supabase();
    let zonaId = null;
    if (arg1 && arg1.toLowerCase() !== "todas") {
      const { data } = await sb.from("zonas").select("id, nombre");
      zonaId = data.find((z) => z.nombre.toLowerCase() === arg1.toLowerCase())?.id;
      if (!zonaId) throw new Error(`Zona desconocida: ${arg1}`);
    }
    const r = await generarSalasFoco(sb, zonaId, true);
    await guardarOEnviar({ para: arg2 || REMITENTE, ...r });
  },

  async comparativo() {
    const sb = supabase();
    if (!arg1) throw new Error("Falta la zona: npm run start -- comparativo <zona> [destinatarios]");
    const datos = await cargarDatos(sb, { incluirVisitas: false });
    const zona = datos.zonas.find((z) => z.nombre.toLowerCase() === arg1.toLowerCase());
    if (!zona) throw new Error(`Zona desconocida: ${arg1}`);
    const armadas = datos.zonas.map((z) => armarZona(datos, z.id)).filter((z) => z.salasZona.length);
    const foco = armadas.find((z) => z.zonaId === zona.id);
    const extras = await cargarExtrasGestion(sb, datos, foco);
    const pdf = (await aPdf([htmlComparativo(datos, foco, extras, armadas.filter((z) => z !== foco))]))[0];
    const sem = datos.semanas[2].semana;
    const fecha = datos.emitido.toISOString().slice(0, 10);
    const slug = foco.zona.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_");
    await guardarOEnviar({
      para: arg2 || REMITENTE,
      asunto: `${foco.zona} · Informe semanal y comparativo con otras zonas · Semana ${sem}`,
      html: `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1f2937"><p>Adjunto el informe de ${esc(foco.zona)} (semana ${sem}) con las 2 salas con peor resultado arrastrado en RED NARTD y tres hojas de comparación contra las demás zonas: indicadores, componentes RED y venta perdida NARTD.</p></div>`,
      adjuntos: [{ filename: `informe_${slug}_comparativo_${fecha}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
  },

  async resumen_zonas() {
    const sb = supabase();
    const r = await generarSalasFoco(sb, null, false);
    const datos = await cargarDatos(sb, { incluirVisitas: false });
    const uso = await usoApp(sb, datos, "Talca");
    const sem = datos.semanas[2].semana;
    const th = `style="padding:4px 10px;border-bottom:2px solid #d1d5db;text-align:left;font-size:12px;color:#4b5563"`;
    const td = `style="padding:4px 10px;border-bottom:1px solid #eef0f2;font-size:13px"`;
    const html = `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1f2937">
      <p>Mauro,</p>
      <p>Te envío los avances por zonas de la semana ${sem}: un informe por cada una (Arica, Iquique, Talca y Viña), adjuntos.</p>
      <p>Igualmente te dejo el uso de la app por los supervisores de Talca: número de encuestas.</p>
      <table style="border-collapse:collapse;margin:8px 0">
        <tr><th ${th}>Supervisor</th><th ${th}>Encuestas semana ${sem} (${uso.rango})</th><th ${th}>Última encuesta</th></tr>
        ${uso.filas.map((f) => `<tr><td ${td}><b>${esc(f.nombre)}</b></td><td ${td} align="center">${f.encuestas}</td><td ${td}>${horaChile(f.ultimaEncuesta)}</td></tr>`).join("")}
      </table></div>`;
    await guardarOEnviar({ para: arg1 || REMITENTE, asunto: `${process.env.ASUNTO_PREFIJO ?? ""}Avances por zonas · Semana ${sem}`, html, adjuntos: r.adjuntos });
  },

  async alarmas() {
    if (arg1 === "volcar") return volcarResumenAlarmas();
    if (arg1 === "completar") return void (await completarResumenAlarmas(supabase()));
    const r = await cargarAlarmas(supabase(), { dias: Number(arg1) || 14 });
    console.log(`Alarmas: ${r.revisadas} en el correo, ${r.nuevas} nuevas cargadas, ${r.aPapelera ?? 0} a la papelera, ${r.imperdonablesCompletados ?? 0} con imperdonables completados`, JSON.stringify(r.estados));
  },

  async envio() {
    const sb = supabase();
    const manual = arg2 === "si";
    const { data: envio, error } = await sb.from("informes_envios").select("*").eq("id", arg1).maybeSingle();
    if (error) throw new Error(`informes_envios: ${error.message}`);
    if (!envio) throw new Error(`Envío ${arg1} no existe`);
    if (!envio.activo && !manual) { console.log(`"${envio.nombre}" está desactivado; no se envía.`); return; }
    const { data: dest, error: e2 } = await sb.from("informes_destinatarios").select("email, copia").eq("envio_id", envio.id).eq("activo", true);
    if (e2) throw new Error(`informes_destinatarios: ${e2.message}`);
    // SOLO_A: prueba desde el workflow; va únicamente a esos correos y no
    // queda en el log (así no cuenta como el envío del día).
    const soloA = (process.env.SOLO_A || "").split(",").map((s) => s.trim()).filter(Boolean);
    // Los marcados "copia" van en Cc; si todos lo están, van como destinatarios.
    const principales = dest.filter((d) => !d.copia).map((d) => d.email);
    const copias = principales.length ? dest.filter((d) => d.copia).map((d) => d.email) : [];
    const para = soloA.length ? soloA : principales.length ? principales : dest.map((d) => d.email);
    if (!para.length) { console.log(`"${envio.nombre}" no tiene destinatarios activos.`); return; }

    const log = (ok, detalle) => soloA.length ? null : sb.from("informes_envios_log").insert({ envio_id: envio.id, manual, destinatarios: [...para, ...copias], ok, detalle });
    try {
      const r = envio.informe === "incidencias" ? await generarIncidencias(sb) : await generarSalasFoco(sb, envio.zona_id, envio.incluir_visitas);
      if (r.vacio) {
        // Semana sin incidencias: no hay nada que mandar, y no es un fallo.
        const detalle = `Sin incidencias del ${r.desde} al ${r.hasta}; no se envió.`;
        if (!process.env.SOLO_ARCHIVO) await log(true, detalle);
        console.log(`"${envio.nombre}": ${detalle}`);
        return;
      }
      await guardarOEnviar({ para: para.join(", "), cc: soloA.length ? "" : copias.join(", "), ...r });
      if (!process.env.SOLO_ARCHIVO) await log(true, r.asunto);
      console.log(`"${envio.nombre}" enviado a ${para.length} destinatario(s).`);
    } catch (e) {
      if (!process.env.SOLO_ARCHIVO) await log(false, String(e.message ?? e).slice(0, 500));
      throw e;
    }
  },
};

if (!modos[modo]) {
  console.error(`Modo desconocido: ${modo}`);
  process.exit(1);
}
await modos[modo]();
