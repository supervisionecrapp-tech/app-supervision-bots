// Alarmas B2B de Dichter & Neira → catálogo de promociones de la app.
//
// Las alarmas llegan (reenviadas) a supervisionecrapp@gmail.com: un correo por
// sala y categoría, con asunto "[RED 56%] ALARMA B2B EMBONOR | 635 | WALMART |
// LIDER MALL ARICA" y un PDF ALARMA_MEDICION_<visita>.pdf. De ese PDF se toma
// la sección "DETALLE CATALOGOS" (las promociones del catálogo vigente) y se
// carga con catalogo_cargar_alarma(), que la suma al catálogo de la zona y el
// holding de la sala. Solo lee el correo: no lo marca ni lo mueve; lo ya
// procesado se reconoce por su Message-ID en alarmas_b2b.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { REMITENTE } from "./correo.mjs";

const PROVEEDOR_CATEGORIA = { EMBONOR: "NARTD", "AB INBEV": "ABI", "VIÑA SANTA RITA": "VSR", "VINA SANTA RITA": "VSR" };

/** "RV: [RED 56%] ALARMA B2B EMBONOR | 635 | WALMART | LIDER MALL ARICA" */
export function leerAsunto(asunto) {
  const m = String(asunto ?? "").match(/\[RED\s*([\d.,]+)\s*%\]\s*ALARMA B2B\s+(.+)$/i);
  if (!m) return null;
  const partes = m[2].split("|").map((s) => s.trim());
  const proveedor = partes[0].toUpperCase();
  // Con código: proveedor | local | holding | sala. Sin código (salas que no
  // son nuestras) viene solo proveedor | sala.
  const conCodigo = partes.length >= 4;
  return {
    notaRed: Number(m[1].replace(",", ".")) / 100,
    categoria: PROVEEDOR_CATEGORIA[proveedor] ?? null,
    local: conCodigo ? partes[1] : null,
    holding: conCodigo ? partes[2] : null,
    sala: partes[partes.length - 1],
  };
}

/** Líneas de texto del PDF en orden de lectura: { pagina, x, y, texto }. */
async function lineasPdf(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    for (const it of tc.items) {
      const texto = it.str.replace(/\s+/g, " ").trim();
      if (texto) out.push({ pagina: p, x: it.transform[4], y: it.transform[5], texto });
    }
  }
  return out;
}

/**
 * Promociones de "DETALLE CATALOGOS". Cada fila de la tabla está a ~40 pt de
 * la siguiente; cuando un nombre largo se parte, la segunda línea queda a
 * ~17 pt, así que una distancia corta es continuación de la fila anterior. En
 * VSR los nombres terminan siempre en "O VARIEDADES", lo que además permite
 * unir un nombre que se parte entre dos páginas.
 */
export function leerCatalogo(lineas, categoria) {
  const ini = lineas.findIndex((l) => /DETALLE CATALOGOS/i.test(l.texto));
  if (ini < 0) return [];
  const items = [];
  let prev = null;
  for (const l of lineas.slice(ini + 1)) {
    if (/^\*?\s*Indicadores usados|^Si el local|^PRIMERA POSICI|No se han encontrado promociones|^reasignarla/i.test(l.texto)) break;
    if (/^\*?\s*PRESENCIA$|^PROMOCION$|^CARTEL$/i.test(l.texto)) continue;
    if (l.x > 300) continue; // columna de presencia
    const continua = prev && (
      (prev.pagina === l.pagina && prev.y - l.y < 25) ||
      (categoria === "VSR" && !/VARIEDADES$/i.test(items[items.length - 1]))
    );
    if (continua) items[items.length - 1] += ` ${l.texto}`;
    else items.push(l.texto);
    prev = l;
  }
  return [...new Set(items.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function leerDatosPdf(lineas) {
  const todo = lineas.map((l) => l.texto).join("\n");
  const med = todo.match(/Hora medici\S*n\s*:\s*\n?(\d{4}-\d{2}-\d{2})\s*\((\d{2}:\d{2})\)/i);
  const fv = todo.match(/Folio\s*:\s*(\d+),?\s*Visita\s*:\s*(\d+)/i);
  return {
    // La hora de medición está en hora de Chile (UTC-4 continental).
    medidoAt: med ? `${med[1]}T${med[2]}:00-04:00` : null,
    folio: fv ? Number(fv[1]) : null,
    visita: fv ? Number(fv[2]) : null,
  };
}

/** Lee las alarmas de los últimos `dias` días y carga las que falten. */
export async function cargarAlarmas(sb, { dias = 14 } = {}) {
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!pass) throw new Error("Falta GMAIL_APP_PASSWORD");
  const imap = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: REMITENTE, pass }, logger: false });
  await imap.connect();
  const resumen = { revisadas: 0, nuevas: 0, estados: {} };
  const lock = await imap.getMailboxLock("INBOX", { readOnly: true });
  try {
    const desde = new Date(Date.now() - dias * 86400000);
    const uids = await imap.search({ subject: "ALARMA B2B", since: desde }, { uid: true });
    if (!uids.length) return resumen;

    // Message-ID de cada correo, para saltar los ya cargados sin bajar el PDF.
    const ids = new Map();
    for await (const m of imap.fetch(uids, { envelope: true }, { uid: true })) ids.set(m.uid, m.envelope.messageId);
    const hechos = new Set();
    const lista = [...ids.values()].filter(Boolean);
    for (let i = 0; i < lista.length; i += 200) {
      const { data, error } = await sb.from("alarmas_b2b").select("message_id").in("message_id", lista.slice(i, i + 200));
      if (error) throw new Error(`alarmas_b2b: ${error.message}`);
      for (const r of data) hechos.add(r.message_id);
    }
    const pendientes = uids.filter((u) => ids.get(u) && !hechos.has(ids.get(u)));
    resumen.revisadas = uids.length;
    if (!pendientes.length) return resumen;

    for await (const msg of imap.fetch(pendientes, { source: true }, { uid: true })) {
      const correo = await simpleParser(msg.source);
      const asunto = leerAsunto(correo.subject);
      const pdf = correo.attachments.find((a) => a.contentType === "application/pdf" && /ALARMA/i.test(a.filename ?? ""));
      let promociones = [], datos = { medidoAt: null, folio: null, visita: null };
      if (asunto && pdf) {
        try {
          const lineas = await lineasPdf(pdf.content);
          promociones = leerCatalogo(lineas, asunto.categoria);
          datos = leerDatosPdf(lineas);
        } catch (e) {
          console.warn(`PDF ilegible en "${correo.subject}": ${e.message}`);
        }
      }
      const { data: estado, error } = await sb.rpc("catalogo_cargar_alarma", {
        p_message_id: ids.get(msg.uid), p_asunto: correo.subject ?? "",
        p_visita: datos.visita, p_folio: datos.folio,
        p_categoria: asunto?.categoria ?? null, p_holding: asunto?.holding ?? null, p_local: asunto?.local ?? null,
        p_nota_red: asunto?.notaRed ?? null,
        p_medido_at: datos.medidoAt ?? correo.date?.toISOString() ?? new Date().toISOString(),
        p_promociones: promociones,
      });
      if (error) throw new Error(`catalogo_cargar_alarma: ${error.message}`);
      resumen.nuevas++;
      resumen.estados[estado] = (resumen.estados[estado] ?? 0) + 1;
      console.log(`${estado.padEnd(13)} ${promociones.length.toString().padStart(3)} promos · ${correo.subject}`);
    }
    return resumen;
  } finally {
    lock.release();
    await imap.logout();
  }
}
