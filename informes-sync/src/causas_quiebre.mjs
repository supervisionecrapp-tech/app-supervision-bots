// Informe de causas de quiebre / venta perdida de una zona (Cadem, vía Datawalt).
// Por cada sala se toma la semana más reciente cargada en causas_quiebre, que
// es lo que Cadem encontró en su última visita, y se listan los SKU con su
// causa, días sin venta, stock y venta perdida. Va en el cuerpo del correo y
// en una planilla adjunta.
import XLSX from "xlsx";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clp = (n) => (n == null ? "–" : "$" + Math.round(n).toLocaleString("es-CL"));
const fmtFecha = (f) => (f ? f.split("-").reverse().join("-") : "–");
const sala = (n) => n.replace(/\s*\(\d+\)\s*$/, "").toLowerCase().replace(/(^|[\s\-,'.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const capital = (s) => s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

export async function generarCausasQuiebre(sb, zonaId) {
  const { data: zona, error: ez } = await sb.from("zonas").select("nombre").eq("id", zonaId).maybeSingle();
  if (ez || !zona) throw new Error(`zona: ${ez?.message ?? "no existe"}`);
  const { data: salas, error: es } = await sb.from("salas").select("id, nombre_geo").eq("zona_id", zonaId).eq("is_active", true);
  if (es) throw new Error(`salas: ${es.message}`);
  if (!salas.length) throw new Error(`La zona ${zona.nombre} no tiene salas activas`);
  const porId = new Map(salas.map((s) => [s.id, s]));

  const { data: filas, error } = await sb.from("causas_quiebre")
    .select("sala_id, anio, semana, sku_ean, sku_nombre, dias_sin_venta, ultima_fecha_venta, stock, prom_vta_sem, causa, venta_perdida")
    .in("sala_id", [...porId.keys()])
    .order("anio", { ascending: false }).order("semana", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`causas_quiebre: ${error.message}`);

  // Última semana con datos de cada sala = su última visita.
  const ultima = new Map();
  for (const f of filas) if (!ultima.has(f.sala_id)) ultima.set(f.sala_id, `${f.anio}-${f.semana}`);
  const vigentes = filas.filter((f) => `${f.anio}-${f.semana}` === ultima.get(f.sala_id));
  if (!vigentes.length) return { vacio: true, detalle: `Sin causas de quiebre cargadas para ${zona.nombre}; no se envió.` };

  const grupos = [...ultima.keys()].map((id) => {
    const skus = vigentes.filter((f) => f.sala_id === id).sort((a, b) => (b.venta_perdida ?? 0) - (a.venta_perdida ?? 0));
    const [anio, semana] = ultima.get(id).split("-").map(Number);
    return { id, nombre: sala(porId.get(id).nombre_geo), anio, semana, skus, total: skus.reduce((s, r) => s + (r.venta_perdida ?? 0), 0) };
  }).sort((a, b) => b.total - a.total);
  const sinDatos = salas.filter((s) => !ultima.has(s.id)).map((s) => sala(s.nombre_geo)).sort((a, b) => a.localeCompare(b, "es"));

  const todos = vigentes;
  const totalVp = todos.reduce((s, r) => s + (r.venta_perdida ?? 0), 0);
  const porCausa = new Map();
  for (const r of todos) {
    const k = r.causa || "Sin causa";
    const a = porCausa.get(k) ?? { skus: 0, vp: 0 };
    a.skus++; a.vp += r.venta_perdida ?? 0;
    porCausa.set(k, a);
  }
  const causas = [...porCausa].sort((a, b) => b[1].vp - a[1].vp);

  // Planilla.
  const hoja = [["Sala", "Semana", "SKU (EAN)", "Producto", "Causa del quiebre", "Días sin venta", "Última venta", "Stock", "Prom. venta semanal", "Venta perdida $"]];
  for (const g of grupos) for (const r of g.skus) {
    hoja.push([g.nombre, g.semana, r.sku_ean, r.sku_nombre ?? "", r.causa ?? "", r.dias_sin_venta, fmtFecha(r.ultima_fecha_venta), r.stock, r.prom_vta_sem, Math.round(r.venta_perdida ?? 0)]);
  }
  const ws = XLSX.utils.aoa_to_sheet(hoja);
  ws["!cols"] = [34, 8, 16, 46, 26, 12, 13, 8, 12, 14].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Causas de quiebre");

  const th = `style="padding:4px 8px;border-bottom:2px solid #d1d5db;text-align:left;font-size:12px;color:#4b5563"`;
  const td = (extra = "") => `style="padding:3px 8px;border-bottom:1px solid #eef0f2;font-size:12.5px;${extra}"`;
  const resumen = `<table style="border-collapse:collapse;margin:6px 0 12px"><tr><th ${th}>Causa</th><th ${th}>SKU</th><th ${th}>Venta perdida</th></tr>${
    causas.map(([c, a]) => `<tr><td ${td()}>${esc(c)}</td><td ${td("text-align:right")}>${a.skus}</td><td ${td("text-align:right")}>${clp(a.vp)}</td></tr>`).join("")}</table>`;
  const bloques = grupos.map((g) => `<p style="margin:16px 0 4px"><b>${esc(g.nombre)}</b> · semana ${g.semana} · ${g.skus.length} SKU · ${clp(g.total)}</p>
    <table style="border-collapse:collapse;width:100%"><tr><th ${th}>SKU</th><th ${th}>Causa</th><th ${th}>Días s/venta</th><th ${th}>Stock</th><th ${th}>Venta perdida</th></tr>${
    g.skus.map((r) => `<tr><td ${td()}>${esc(r.sku_nombre || r.sku_ean)}</td><td ${td()}>${esc(r.causa || "Sin causa")}</td><td ${td("text-align:right")}>${r.dias_sin_venta ?? "–"}</td><td ${td("text-align:right")}>${r.stock ?? "–"}</td><td ${td("text-align:right")}>${clp(r.venta_perdida)}</td></tr>`).join("")}</table>`).join("");

  const semanas = [...new Set(grupos.map((g) => g.semana))].sort((a, b) => b - a);
  const html = `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1f2937">
    <p>Causas de quiebre y venta perdida de <b>${esc(capital(zona.nombre))}</b> según Cadem, con los SKU encontrados en la última visita a cada sala (semana${semanas.length > 1 ? "s" : ""} ${semanas.join(", ")}). Total: <b>${todos.length} SKU</b>, <b>${clp(totalVp)}</b> de venta perdida.</p>
    ${resumen}${bloques}
    ${sinDatos.length ? `<p style="color:#6b7280;font-size:12px">Sin datos de Cadem: ${esc(sinDatos.join(", "))}.</p>` : ""}
    <p style="color:#6b7280;font-size:12px">El detalle completo (EAN, días sin venta, stock y promedio semanal) va en la planilla adjunta.</p></div>`;

  const fecha = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Santiago" });
  const slug = zona.nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_");
  return {
    asunto: `${capital(zona.nombre)} · Causas de quiebre y venta perdida Cadem · Semana ${semanas[0]}`,
    html,
    adjuntos: [{ filename: `causas_quiebre_${slug}_${fecha}.xlsx`, content: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  };
}
