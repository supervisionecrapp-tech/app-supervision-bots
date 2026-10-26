// Informe semanal de incidencias de marca: las registradas en el portal
// (Administración → Incidencias) durante la última semana cerrada (lunes a
// domingo, hora de Chile). Sale un correo con el detalle por zona y un zip
// con las fotos (carpetas por zona) y la planilla.
import JSZip from "jszip";
import XLSX from "xlsx";

const TZ = "America/Santiago";
const BUCKET = "incidencias-evidencias";
const DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const DIAS_CORTO = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** "UNIMARC-O'HIGGINS (1840622)" → "Unimarc-O'Higgins". */
const sala = (n) => n.replace(/\s*\(\d+\)\s*$/, "").toLowerCase().replace(/(^|[\s\-,'.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const persona = (n) => (n ? n.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : "—");
const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w()-]+/g, "_").replace(/^_|_$/g, "");

/** La última semana lunes–domingo ya terminada, en fechas de Chile. */
export function semanaCerrada(ahora = new Date()) {
  const hoy = new Date(ahora.toLocaleDateString("sv-SE", { timeZone: TZ }) + "T00:00:00Z");
  const isodow = (hoy.getUTCDay() + 6) % 7; // 0 = lunes
  const desde = new Date(hoy); desde.setUTCDate(hoy.getUTCDate() - isodow - 7);
  const hasta = new Date(desde); hasta.setUTCDate(desde.getUTCDate() + 6);
  const f = (d) => d.toISOString().slice(0, 10);
  return { desde: f(desde), hasta: f(hasta) };
}

const diaDe = (fecha) => (new Date(fecha + "T00:00:00Z").getUTCDay() + 6) % 7;
const fmt = (fecha) => fecha.split("-").reverse().join("-");

/** Arma correo + zip; devuelve null si la semana no tuvo incidencias. */
export async function generarIncidencias(sb) {
  const { desde, hasta } = semanaCerrada();
  const { data, error } = await sb
    .from("incidencias")
    .select("fecha, tipo, supervisor_nombre, motivo, observacion, evidencia_path, salas!inner(nombre_geo, zonas!inner(nombre))")
    .gte("fecha", desde).lte("fecha", hasta);
  if (error) throw new Error(`incidencias: ${error.message}`);
  if (!data.length) return { vacio: true, desde, hasta };

  const filas = data.map((r) => ({ ...r, zona: r.salas.zonas.nombre, nombreSala: r.salas.nombre_geo }));
  filas.sort((a, b) => a.zona.localeCompare(b.zona, "es") || a.fecha.localeCompare(b.fecha) || a.nombreSala.localeCompare(b.nombreSala, "es"));
  const zonas = [...new Set(filas.map((f) => f.zona))];

  const zip = new JSZip();
  const hoja = [["Zona", "Fecha", "Día", "Sala", "Supervisor", "Tipo", "Observación", "Foto"]];
  for (const f of filas) {
    // Las subidas rápido desde Difusión no traen foto.
    let ruta = "(sin foto)";
    if (f.evidencia_path) {
      const dl = await sb.storage.from(BUCKET).download(f.evidencia_path);
      if (dl.error) throw new Error(`Foto ${f.evidencia_path}: ${dl.error.message}`);
      const ext = f.evidencia_path.split(".").pop();
      ruta = `fotos/${slug(f.zona)}/${slug(sala(f.nombreSala))}_${f.fecha}.${ext}`;
      zip.file(ruta, Buffer.from(await dl.data.arrayBuffer()));
    }
    hoja.push([persona(f.zona), fmt(f.fecha), DIAS[diaDe(f.fecha)], sala(f.nombreSala), persona(f.supervisor_nombre), f.tipo,
      [f.motivo, f.observacion].filter(Boolean).join(" — "), ruta]);
  }
  const ws = XLSX.utils.aoa_to_sheet(hoja);
  ws["!cols"] = [10, 12, 11, 44, 22, 20, 36, 70].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Incidencias");
  zip.file("incidencias.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  const contenido = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  const bloques = zonas.map((z) => {
    const lista = filas.filter((f) => f.zona === z);
    return `<p style="margin:14px 0 4px"><b>${esc(persona(z))}</b> (${lista.length})</p><ul style="margin:0;padding-left:20px">${
      lista.map((f) => `<li>${DIAS_CORTO[diaDe(f.fecha)]} ${f.fecha.slice(8)}: ${esc(sala(f.nombreSala))} <span style="color:#6b7280">(${esc(persona(f.supervisor_nombre))})</span></li>`).join("")}</ul>`;
  }).join("");
  const html = `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1f2937">
    <p>Chicas les mando las incidencias de la semana pasada, favor enviar a Mauricio para que sea compartida con Martín y Bastián.</p>
    <p>Detalle de la semana del ${fmt(desde)} al ${fmt(hasta)} (${filas.length} en total):</p>${bloques}
    <p style="margin-top:16px">Adjunto el comprimido con la evidencia fotográfica, en carpetas por zona, y la planilla con el detalle.</p></div>`;

  return {
    asunto: `Incidencias de marca · semana del ${fmt(desde)} al ${fmt(hasta)}`,
    html,
    adjuntos: [{ filename: `incidencias_${desde}_al_${hasta}.zip`, content: contenido, contentType: "application/zip" }],
  };
}
