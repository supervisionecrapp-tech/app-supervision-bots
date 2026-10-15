// Punto de entrada.
//   npm run start -- envio <envio_id> [si|no]   un envío configurado en el portal
//                                                (si = disparado a mano)
//   npm run start -- salas_foco <zona|todas> <destinatarios>   prueba suelta
//   npm run start -- prueba <destinatarios>
//   npm run start -- alarmas [dias]   alarmas B2B del correo → catálogo de promociones
// Con SOLO_ARCHIVO=<carpeta> los PDF se guardan ahí y no se envía nada.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { enviarCorreo, REMITENTE } from "./correo.mjs";
import { cargarAlarmas } from "./alarmas.mjs";
import { cargarDatos, armarZona, aPdf, pct, clp, esc, diaLargo } from "./salas_foco.mjs";
import { cargarExtrasGestion, registrarCompromisos } from "./gestion.mjs";
import { htmlGestion } from "./gestion_html.mjs";

const [modo = "prueba", arg1, arg2] = process.argv.slice(2);

function supabase() {
  const url = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
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
    htmls.push(htmlGestion(datos, z, extras));
  }
  const pdfs = await aPdf(htmls);
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
    return `<div style="margin:14px 0"><b style="font-size:15px">${esc(z.zona)}</b> · ${z.salasZona.length} salas · ${z.foco.length} salas foco
      <table style="border-collapse:collapse;margin-top:4px;font-size:13px">
        <tr>${fila("NARTD", w.nartd, z.metas.red_nartd)}${fila("ABI", w.abi, z.metas.red_abi)}${fila("VSR", w.vsr, z.metas.red_vsr)}</tr>
        <tr>${fila("Pres. SMU", w.SMU, z.metas.presentismo)}${fila("Pres. WM", w.WM, z.metas.presentismo)}<td style="padding:2px 10px 2px 0">Vta. perdida Cadem</td><td style="font-weight:600">${clp(z.cadem.total)}</td></tr>
      </table>${visTxt}</div>`;
  };
  const html = `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1f2937">
    <p>Adjunto el informe semanal de gestión${armadas.length > 1 ? ", uno por zona" : ""}: resumen ejecutivo, ranking de intervención por sala, plan de acción por supervisor, venta perdida y seguimiento de compromisos. Semana ${sem}.</p>
    ${armadas.map(resumenZona).join("")}
    <p style="color:#6b7280;font-size:12px">Rojo = fuera de meta. El detalle por supervisor, las salas foco y la venta perdida por SKU están en el PDF.</p></div>`;
  const asunto = `${armadas.length === 1 ? armadas[0].zona : "Zonas"} · Informe semanal de gestión · Semana ${sem}`;
  return { adjuntos, html, asunto };
}

async function guardarOEnviar({ para, asunto, html, adjuntos }) {
  if (process.env.SOLO_ARCHIVO) {
    await mkdir(process.env.SOLO_ARCHIVO, { recursive: true });
    for (const a of adjuntos) await writeFile(path.join(process.env.SOLO_ARCHIVO, a.filename), a.content);
    await writeFile(path.join(process.env.SOLO_ARCHIVO, "correo.html"), html);
    console.log(`Guardado en ${process.env.SOLO_ARCHIVO}: ${adjuntos.map((a) => a.filename).join(", ")}`);
    return;
  }
  await enviarCorreo({ para, asunto, html, adjuntos });
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

  async alarmas() {
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
    const { data: dest, error: e2 } = await sb.from("informes_destinatarios").select("email").eq("envio_id", envio.id).eq("activo", true);
    if (e2) throw new Error(`informes_destinatarios: ${e2.message}`);
    const para = dest.map((d) => d.email);
    if (!para.length) { console.log(`"${envio.nombre}" no tiene destinatarios activos.`); return; }

    const log = (ok, detalle) => sb.from("informes_envios_log").insert({ envio_id: envio.id, manual, destinatarios: para, ok, detalle });
    try {
      const r = await generarSalasFoco(sb, envio.zona_id, envio.incluir_visitas);
      await guardarOEnviar({ para: para.join(", "), ...r });
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
