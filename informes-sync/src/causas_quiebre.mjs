// Informe de causas de quiebre / venta perdida de una zona (Cadem, vía Datawalt).
// Por cada sala se toma la semana más reciente cargada en causas_quiebre, que
// es lo que Cadem encontró en su última visita, y se listan los SKU con su
// causa, días sin venta, stock y venta perdida. Sale como PDF en forma de
// lista (casilla por SKU) y un resumen por causa en el cuerpo del correo.
import { createHash } from "node:crypto";
import { aPdf } from "./salas_foco.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clp = (n) => (n == null ? "–" : "$" + Math.round(n).toLocaleString("es-CL"));
const fmtFecha = (f) => (f ? f.split("-").reverse().join("-") : "–");
const sala = (n) => n.replace(/\s*\(\d+\)\s*$/, "").toLowerCase().replace(/(^|[\s\-,'.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const capital = (s) => s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

/** Huella del conjunto de SKU y causas de una sala: cambia cuando aparece o sale un SKU o cambia su causa, no por los montos. */
const huella = (anio, semana, skus) =>
  createHash("sha1").update(`${anio}-${semana}|${skus.map((r) => `${r.sku_ean}:${r.causa ?? ""}`).sort().join(",")}`).digest("hex");

/**
 * Sale solo lo nuevo: las salas cuya última visita de Cadem trae SKU/causas distintos
 * de lo ya enviado en este envío (informes_causas_enviadas). Con `todas` manda todas las
 * salas con datos. `confirmar()` registra lo enviado; se llama después de enviar el correo.
 */
export async function generarCausasQuiebre(sb, envio, { todas = false } = {}) {
  const zonaId = envio.zona_id;
  const { data: zona, error: ez } = await sb.from("zonas").select("nombre").eq("id", zonaId).maybeSingle();
  if (ez || !zona) throw new Error(`zona: ${ez?.message ?? "no existe"}`);
  const { data: salas, error: es } = await sb.from("salas").select("id, nombre_geo").eq("zona_id", zonaId).eq("is_active", true);
  if (es) throw new Error(`salas: ${es.message}`);
  if (!salas.length) throw new Error(`La zona ${zona.nombre} no tiene salas activas`);
  const porId = new Map(salas.map((s) => [s.id, s]));

  let { data: filas, error } = await sb.from("causas_quiebre")
    .select("sala_id, anio, semana, sku_ean, sku_nombre, dias_sin_venta, ultima_fecha_venta, stock, prom_vta_sem, causa, venta_perdida")
    .in("sala_id", [...porId.keys()])
    .order("anio", { ascending: false }).order("semana", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`causas_quiebre: ${error.message}`);

  // Solo lo fresco: la semana ISO en curso (hora de Chile). Las visitas de semanas
  // anteriores no se mandan aunque la sala no tenga medición nueva.
  const hoy = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "America/Santiago" }) + "T00:00:00Z");
  const jueves = new Date(hoy); jueves.setUTCDate(hoy.getUTCDate() + 3 - ((hoy.getUTCDay() + 6) % 7));
  const anioIso = jueves.getUTCFullYear();
  const semanaIso = Math.ceil(((jueves - new Date(Date.UTC(anioIso, 0, 1))) / 86400000 + 1) / 7);
  filas = filas.filter((f) => f.anio === anioIso && f.semana === semanaIso);

  // Última semana con datos de cada sala = su última visita.
  const ultima = new Map();
  for (const f of filas) if (!ultima.has(f.sala_id)) ultima.set(f.sala_id, `${f.anio}-${f.semana}`);
  const vigentes = filas.filter((f) => `${f.anio}-${f.semana}` === ultima.get(f.sala_id));
  if (!vigentes.length) return { vacio: true, detalle: `Sin causas de quiebre de la semana ${semanaIso} para ${zona.nombre}; no se envió.` };

  const grupos = [...ultima.keys()].map((id) => {
    const skus = vigentes.filter((f) => f.sala_id === id).sort((a, b) => (b.venta_perdida ?? 0) - (a.venta_perdida ?? 0));
    const [anio, semana] = ultima.get(id).split("-").map(Number);
    return { id, nombre: sala(porId.get(id).nombre_geo), anio, semana, skus, total: skus.reduce((s, r) => s + (r.venta_perdida ?? 0), 0) };
  }).sort((a, b) => b.total - a.total);

  const { data: previas, error: ep } = await sb.from("informes_causas_enviadas").select("sala_id, huella").eq("envio_id", envio.id);
  if (ep) throw new Error(`informes_causas_enviadas: ${ep.message}`);
  const enviada = new Map(previas.map((p) => [p.sala_id, p.huella]));
  for (const g of grupos) g.huella = huella(g.anio, g.semana, g.skus);
  const nuevos = todas ? grupos : grupos.filter((g) => enviada.get(g.id) !== g.huella);
  if (!nuevos.length) return { vacio: true, detalle: `Sin salas nuevas de Cadem en ${zona.nombre}; no se envió.` };
  grupos.splice(0, grupos.length, ...nuevos);
  const varias = grupos.length > 1;
  const todos = grupos.flatMap((g) => g.skus);
  const totalVp = todos.reduce((s, r) => s + (r.venta_perdida ?? 0), 0);
  const porCausa = new Map();
  for (const r of todos) {
    const k = r.causa || "Sin causa";
    const a = porCausa.get(k) ?? { skus: 0, vp: 0 };
    a.skus++; a.vp += r.venta_perdida ?? 0;
    porCausa.set(k, a);
  }
  const causas = [...porCausa].sort((a, b) => b[1].vp - a[1].vp);

  const th = `style="padding:4px 8px;border-bottom:2px solid #d1d5db;text-align:left;font-size:12px;color:#4b5563"`;
  const td = (extra = "") => `style="padding:3px 8px;border-bottom:1px solid #eef0f2;font-size:12.5px;${extra}"`;
  const resumen = `<table style="border-collapse:collapse;margin:6px 0 12px"><tr><th ${th}>Causa</th><th ${th}>SKU</th><th ${th}>Venta perdida</th></tr>${
    causas.map(([c, a]) => `<tr><td ${td()}>${esc(c)}</td><td ${td("text-align:right")}>${a.skus}</td><td ${td("text-align:right")}>${clp(a.vp)}</td></tr>`).join("")}</table>`;
  const porSala = `<table style="border-collapse:collapse;margin:0 0 12px"><tr><th ${th}>Sala</th><th ${th}>Semana</th><th ${th}>SKU</th><th ${th}>Venta perdida</th></tr>${
    grupos.map((g) => `<tr><td ${td()}>${esc(g.nombre)}</td><td ${td("text-align:right")}>${g.semana}</td><td ${td("text-align:right")}>${g.skus.length}</td><td ${td("text-align:right")}>${clp(g.total)}</td></tr>`).join("")}</table>`;
  const bloques = grupos.map((g, i) => `${varias || i ? `<div style="break-before:page"></div>` : ""}<p style="margin:0 0 4px"><b>${esc(g.nombre)}</b> · semana ${g.semana} · ${g.skus.length} SKU · ${clp(g.total)}</p>
    <table style="border-collapse:collapse;width:100%"><tr><th ${th}></th><th ${th}>SKU</th><th ${th}>Causa</th><th ${th}>Días s/venta</th><th ${th}>Stock</th><th ${th}>Venta perdida</th></tr>${
    g.skus.map((r) => `<tr><td ${td("font-size:15px;line-height:1")}>☐</td><td ${td()}>${esc(r.sku_nombre || r.sku_ean)}</td><td ${td()}>${esc(r.causa || "Sin causa")}</td><td ${td("text-align:right")}>${r.dias_sin_venta ?? "–"}</td><td ${td("text-align:right")}>${r.stock ?? "–"}</td><td ${td("text-align:right")}>${clp(r.venta_perdida)}</td></tr>`).join("")}</table>`).join("");

  const semanas = [...new Set(grupos.map((g) => g.semana))].sort((a, b) => b - a);
  const fecha = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Santiago" });
  const slug = zona.nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_");
  const titulo = `${capital(zona.nombre)} · Causas de quiebre y venta perdida Cadem`;
  const pdfHtml = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm 12mm}body{font:12px/1.4 Segoe UI,Arial,sans-serif;color:#1f2937;margin:0}tr{break-inside:avoid}h1{font-size:19px;margin:0 0 2px}</style></head><body>
    <h1>${esc(titulo)}</h1>
    <div style="color:#6b7280;margin-bottom:8px">SKU encontrados en la última visita · semana${semanas.length > 1 ? "s" : ""} ${semanas.join(", ")} · emitido ${fmtFecha(fecha)} · <b>${todos.length} SKU</b> · <b>${clp(totalVp)}</b></div>
    ${varias ? resumen + porSala : ""}${bloques}</body></html>`;
  const [pdf] = await aPdf([pdfHtml]);
  const ultimaMed = grupos.length === 1 ? `la última medición de <b>${esc(grupos[0].nombre)}</b>` : `la última medición de <b>${esc(grupos.map((g) => g.nombre).join(", "))}</b>`;
  const html = `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1f2937">
    <p>Howard,</p>
    <p>Te dejo el listado de causas de quiebre en ${ultimaMed} (semana ${semanas.join(", ")}), con ${todos.length} SKU y ${clp(totalVp)} de venta perdida. El desglose por causal es el siguiente:</p>
    ${resumen}
    <p>El detalle por SKU va en el PDF adjunto${varias ? ", una hoja por sala" : ""}.</p>
    <p>Saludos.</p></div>`;
  return {
    asunto: `${capital(zona.nombre)} · Causas de quiebre Cadem · ${grupos.map((g) => g.nombre).join(", ")} · Semana ${semanas[0]}`,
    confirmar: async () => {
      if (todas) return;
      const { error } = await sb.from("informes_causas_enviadas").upsert(
        grupos.map((g) => ({ envio_id: envio.id, sala_id: g.id, anio: g.anio, semana: g.semana, huella: g.huella, enviado_at: new Date().toISOString() })),
        { onConflict: "envio_id,sala_id" });
      if (error) throw new Error(`informes_causas_enviadas: ${error.message}`);
    },
    html,
    adjuntos: [{ filename: `causas_quiebre_${slug}_${fecha}${varias ? "" : "_" + grupos[0].nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_")}.pdf`, content: pdf, contentType: "application/pdf" }],
  };
}
