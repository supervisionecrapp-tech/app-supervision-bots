// Alarmas B2B de Dichter & Neira → catálogo de promociones de la app.
//
// Las alarmas llegan (reenviadas) a supervisionecrapp@gmail.com: un correo por
// sala y categoría, con asunto "[RED 56%] ALARMA B2B EMBONOR | 635 | WALMART |
// LIDER MALL ARICA" y un PDF ALARMA_MEDICION_<visita>.pdf. De ese PDF se toma
// la sección "DETALLE CATALOGOS" (las promociones del catálogo vigente y si
// cada una se encontró en la sala) y se carga con catalogo_cargar_alarma(),
// que la suma al catálogo de la zona y deja la presencia de esa sala. Lo ya
// procesado se reconoce por su Message-ID en alarmas_b2b y se manda a la
// papelera de Gmail (se borra sola a los 30 días).
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
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

/** Color de una imagen ya decodificada: "verde" (✔), "rojo" (✘) o null. */
function colorImagen(img) {
  const d = img?.data;
  if (!d) return null;
  const ch = img.kind === 3 ? 4 : img.kind === 2 ? 3 : 1;
  if (ch === 1) return null;
  let r = 0, g = 0, n = 0;
  for (let k = 0; k + 2 < d.length; k += ch) {
    if (ch === 4 && d[k + 3] < 128) continue;
    if (d[k] > 230 && d[k + 1] > 230 && d[k + 2] > 230) continue; // fondo blanco
    r += d[k]; g += d[k + 1]; n++;
  }
  if (!n) return null;
  r /= n; g /= n;
  return g > r * 2 ? "verde" : r > g * 2 ? "rojo" : null;
}

/**
 * Texto e imágenes del PDF: líneas { pagina, x, y, texto } en orden de
 * lectura, y marcas { pagina, x, yCentro, color } (el ✔ verde y el ✘ rojo
 * son imágenes, no texto).
 */
export async function leerPdf(buffer) {
  // Sin OffscreenCanvas, pdfjs entrega los píxeles de cada imagen en Node.
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  const lineas = [], marcas = [];
  const mult = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    for (const it of (await page.getTextContent()).items) {
      const texto = it.str.replace(/\s+/g, " ").trim();
      if (texto) lineas.push({ pagina: p, x: it.transform[4], y: it.transform[5], texto });
    }
    const ops = await page.getOperatorList();
    const pila = [[1, 0, 0, 1, 0, 0]];
    const colores = new Map();
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.save) pila.push(pila[pila.length - 1]);
      else if (fn === OPS.restore) pila.pop();
      else if (fn === OPS.transform) pila[pila.length - 1] = mult(pila[pila.length - 1], args);
      else if (fn === OPS.paintImageXObject) {
        const m = pila[pila.length - 1];
        if (!colores.has(args[0])) {
          // Las imágenes que se repiten en varias páginas ("g_…") van en commonObjs.
          const almacen = args[0].startsWith("g_") ? page.commonObjs : page.objs;
          const img = await Promise.race([
            new Promise((r) => almacen.get(args[0], r)),
            new Promise((r) => setTimeout(() => r(null), 5000)),
          ]);
          colores.set(args[0], colorImagen(img));
        }
        const color = colores.get(args[0]);
        if (color) marcas.push({ pagina: p, x: m[4], yCentro: m[5] + m[3] / 2, color });
      }
    }
  }
  return { lineas, marcas };
}

/**
 * Promociones de "DETALLE CATALOGOS". Cada fila de la tabla está a ~40 pt de
 * la siguiente; cuando un nombre largo se parte, la segunda línea queda a
 * ~17 pt, así que una distancia corta es continuación de la fila anterior. En
 * VSR los nombres terminan siempre en "O VARIEDADES", lo que además permite
 * unir un nombre que se parte entre dos páginas.
 *
 * Presencia: en la columna derecha va un ✔ verde o un ✘ rojo (imágenes)
 * centrado en la fila; sin marca, `encontrado` queda null.
 * Devuelve [{ promocion, encontrado }].
 */
export function leerCatalogo({ lineas, marcas }, categoria) {
  const ini = lineas.findIndex((l) => /DETALLE CATALOGOS/i.test(l.texto));
  if (ini < 0) return [];
  const items = []; // { promocion, pagina, y, yFin }
  let prev = null;
  let fin = null; // dónde termina la sección, para no tomar marcas de la siguiente
  for (const l of lineas.slice(ini + 1)) {
    if (/^\*?\s*Indicadores usados|^Si el local|^PRIMERA POSICI|No se han encontrado promociones|^reasignarla/i.test(l.texto)) {
      fin = l;
      break;
    }
    if (/^\*?\s*PRESENCIA$|^PROMOCION$|^CARTEL$/i.test(l.texto)) continue;
    if (l.x > 300) continue; // columna de presencia
    const ultimo = items[items.length - 1];
    const continua = prev && (
      (prev.pagina === l.pagina && prev.y - l.y < 25) ||
      (categoria === "VSR" && !/VARIEDADES$/i.test(ultimo.promocion))
    );
    if (continua) {
      ultimo.promocion += ` ${l.texto}`;
      if (ultimo.pagina === l.pagina) ultimo.yFin = l.y;
      else ultimo.siguiente = { pagina: l.pagina, y: l.y }; // la fila sigue en la otra página
    } else items.push({ promocion: l.texto, pagina: l.pagina, y: l.y, yFin: l.y });
    prev = l;
  }
  // Marcas de la columna de presencia dentro de la sección, en orden de lectura.
  const cab = lineas[ini];
  const antes = (a, b) => a.pagina < b.pagina || (a.pagina === b.pagina && a.y > b.y);
  const seccion = marcas
    .filter((m) => m.x > 400)
    .map((m) => ({ ...m, y: m.yCentro }))
    .filter((m) => antes(cab, m) && (!fin || antes(m, fin)))
    .sort((a, b) => a.pagina - b.pagina || b.y - a.y);
  const cerca = (pagina, centro) => seccion
    .filter((m) => m.pagina === pagina && Math.abs(m.y - centro) < 18)
    .sort((a, b) => Math.abs(a.y - centro) - Math.abs(b.y - centro))[0];

  // 1) La marca centrada en la fila (o en su continuación si se parte entre páginas).
  const asignadas = items.map((it) =>
    cerca(it.pagina, (it.y + it.yFin) / 2 + 4) ?? (it.siguiente ? cerca(it.siguiente.pagina, it.siguiente.y + 4) : undefined));
  // 2) Una fila que cae justo en un salto de página puede tener su marca al pie
  //    de la página anterior: si entre la marca de la fila previa y la de la
  //    siguiente queda exactamente una marca libre, es la suya.
  const usadas = new Set(asignadas.filter(Boolean));
  asignadas.forEach((m, i) => {
    if (m) return;
    const desde = i > 0 && asignadas[i - 1] ? seccion.indexOf(asignadas[i - 1]) : -1;
    const sig = asignadas.slice(i + 1).find(Boolean);
    const hasta = sig ? seccion.indexOf(sig) : seccion.length;
    const libres = seccion.slice(desde + 1, hasta).filter((x) => !usadas.has(x));
    if (libres.length === 1) { asignadas[i] = libres[0]; usadas.add(libres[0]); }
  });

  const vistos = new Set();
  return items
    .map((it, i) => ({
      promocion: it.promocion.replace(/\s+/g, " ").trim(),
      encontrado: asignadas[i] ? asignadas[i].color === "verde" : null,
    }))
    .filter((x) => x.promocion && !vistos.has(x.promocion) && vistos.add(x.promocion));
}

/**
 * "DETALLE PORTAFOLIO IMPERDONABLE" (solo NARTD): por fila, la columna QC
 * (x≈36) lleva un número centrado en la fila, la submétrica va al lado
 * (x≈73, a veces en dos líneas) y CUMPLE (x≈552) es un ✔ verde o ✘ rojo a la
 * altura del QC. La submétrica es la misma "métrica" de los 24 roles de la
 * encuesta (mobile/src/lib/imperdonables.ts). Devuelve
 * [{ metrica, encontrado, qc }]; si falta la marca, se usa QC = 0 → cumple.
 */
export function leerImperdonables({ lineas, marcas }) {
  const ini = lineas.findIndex((l) => /DETALLE PORTAFOLIO IMPERDONABLE/i.test(l.texto));
  if (ini < 0) return [];
  let fin = lineas.findIndex((l, i) => i > ini && /^GLOSARIO|^RESUMEN CATEGORIAS|^DETALLE (DE )?QUIEBRES/i.test(l.texto));
  if (fin < 0) fin = lineas.length;
  const seccion = lineas.slice(ini + 1, fin);
  const filas = seccion.filter((l) => l.x < 60 && /^\d+$/.test(l.texto));
  return filas.map((qc) => {
    const metrica = seccion
      .filter((l) => l.pagina === qc.pagina && l.x >= 60 && l.x < 130 && Math.abs(l.y - qc.y) <= 15)
      .sort((a, b) => b.y - a.y)
      .map((l) => l.texto)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const marca = marcas
      .filter((m) => m.pagina === qc.pagina && m.x > 450 && Math.abs(m.yCentro - (qc.y + 4)) < 14)
      .sort((a, b) => Math.abs(a.yCentro - qc.y) - Math.abs(b.yCentro - qc.y))[0];
    const n = Number(qc.texto);
    return { metrica, encontrado: marca ? marca.color === "verde" : n === 0, qc: n };
  }).filter((x) => x.metrica && !/^SUBMETRICA$/i.test(x.metrica));
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

/**
 * Alarmas NARTD ya registradas que todavía no tienen sus imperdonables (las
 * de antes de que se leyera esa sección): se buscan por Message-ID en la
 * bandeja y en la papelera (Gmail las guarda 30 días) y se completan. Usa la
 * conexión IMAP ya abierta; la bandeja queda bloqueada por el llamador, así
 * que la papelera se abre aparte y al final se vuelve a INBOX.
 */
async function completarImperdonables(sb, imap) {
  const { data, error } = await sb.from("alarmas_b2b").select("message_id")
    .eq("categoria", "NARTD").eq("imperdonables", "[]")
    .gte("medido_at", new Date(Date.now() - 30 * 86400000).toISOString());
  if (error) throw new Error(`alarmas_b2b: ${error.message}`);
  if (!data.length) return 0;
  const faltan = new Set(data.map((r) => r.message_id));
  let n = 0;
  const papelera = (await imap.list()).find((b) => b.specialUse === "\\Trash")?.path;
  for (const carpeta of ["INBOX", papelera].filter(Boolean)) {
    if (!faltan.size) break;
    await imap.mailboxOpen(carpeta, { readOnly: true });
    for (const mid of [...faltan]) {
      const uids = await imap.search({ header: { "message-id": mid } }, { uid: true });
      if (!uids.length) continue;
      const msg = await imap.fetchOne(String(uids[0]), { source: true }, { uid: true });
      const correo = await simpleParser(msg.source);
      const pdf = correo.attachments.find((a) => a.contentType === "application/pdf" && /ALARMA/i.test(a.filename ?? ""));
      if (!pdf) continue;
      const imperdonables = leerImperdonables(await leerPdf(pdf.content));
      const { error: e2 } = await sb.rpc("alarma_registrar_imperdonables", { p_message_id: mid, p_imperdonables: imperdonables });
      if (e2) throw new Error(`alarma_registrar_imperdonables: ${e2.message}`);
      faltan.delete(mid);
      n++;
      console.log(`imperdonables ${imperdonables.filter((x) => x.encontrado).length}/${imperdonables.length} completados · ${correo.subject}`);
    }
  }
  await imap.mailboxOpen("INBOX");
  return n;
}

/** Lee las alarmas de los últimos `dias` días y carga las que falten. */
export async function cargarAlarmas(sb, { dias = 14 } = {}) {
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!pass) throw new Error("Falta GMAIL_APP_PASSWORD");
  const imap = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: REMITENTE, pass }, logger: false });
  await imap.connect();
  const resumen = { revisadas: 0, nuevas: 0, estados: {} };
  const lock = await imap.getMailboxLock("INBOX");
  try {
    const desde = new Date(Date.now() - dias * 86400000);
    const uids = await imap.search({ subject: "ALARMA B2B", since: desde }, { uid: true });

    // Message-ID de cada correo, para saltar los ya cargados sin bajar el PDF.
    const ids = new Map();
    for await (const m of uids.length ? imap.fetch(uids, { envelope: true }, { uid: true }) : []) ids.set(m.uid, m.envelope.messageId);
    const hechos = new Set();
    const lista = [...ids.values()].filter(Boolean);
    for (let i = 0; i < lista.length; i += 200) {
      const { data, error } = await sb.from("alarmas_b2b").select("message_id").in("message_id", lista.slice(i, i + 200));
      if (error) throw new Error(`alarmas_b2b: ${error.message}`);
      for (const r of data) hechos.add(r.message_id);
    }
    const pendientes = uids.filter((u) => ids.get(u) && !hechos.has(ids.get(u)));
    resumen.revisadas = uids.length;
    // Lo que ya está registrado se va a la papelera (Gmail lo borra a los 30
    // días): el detalle quedó en alarmas_b2b y no hace falta el correo ni
    // para asignar sala a mano. Un PDF que no se pudo leer se deja en la
    // bandeja para revisarlo.
    const aPapelera = uids.filter((u) => hechos.has(ids.get(u)));

    for await (const msg of pendientes.length ? imap.fetch(pendientes, { source: true }, { uid: true }) : []) {
      const correo = await simpleParser(msg.source);
      const asunto = leerAsunto(correo.subject);
      const pdf = correo.attachments.find((a) => a.contentType === "application/pdf" && /ALARMA/i.test(a.filename ?? ""));
      let promociones = [], imperdonables = [], datos = { medidoAt: null, folio: null, visita: null };
      let legible = !!(asunto && pdf);
      if (asunto && pdf) {
        try {
          const leido = await leerPdf(pdf.content);
          promociones = leerCatalogo(leido, asunto.categoria);
          imperdonables = leerImperdonables(leido);
          datos = leerDatosPdf(leido.lineas);
        } catch (e) {
          legible = false;
          console.warn(`PDF ilegible en "${correo.subject}": ${e.message}`);
        }
      }
      const { data: estado, error } = await sb.rpc("catalogo_cargar_alarma", {
        p_message_id: ids.get(msg.uid), p_asunto: correo.subject ?? "",
        p_visita: datos.visita, p_folio: datos.folio,
        p_categoria: asunto?.categoria ?? null, p_holding: asunto?.holding ?? null, p_local: asunto?.local ?? null,
        p_sala_asunto: asunto?.sala ?? null, p_nota_red: asunto?.notaRed ?? null,
        p_medido_at: datos.medidoAt ?? correo.date?.toISOString() ?? new Date().toISOString(),
        p_detalle: promociones,
        p_imperdonables: imperdonables,
      });
      if (error) throw new Error(`catalogo_cargar_alarma: ${error.message}`);
      if (legible) aPapelera.push(msg.uid);
      resumen.nuevas++;
      resumen.estados[estado] = (resumen.estados[estado] ?? 0) + 1;
      const si = promociones.filter((x) => x.encontrado === true).length;
      const no = promociones.filter((x) => x.encontrado === false).length;
      const impNo = imperdonables.filter((x) => !x.encontrado).length;
      console.log(`${estado.padEnd(13)} ${String(promociones.length).padStart(3)} promos (encontradas ${si}, no ${no})${imperdonables.length ? ` · imperdonables ${imperdonables.length - impNo}/${imperdonables.length}` : ""} · ${correo.subject}`);
    }

    if (aPapelera.length) {
      const papelera = (await imap.list()).find((b) => b.specialUse === "\\Trash");
      if (!papelera) throw new Error("No se encontró la papelera de Gmail");
      await imap.messageMove(aPapelera, papelera.path, { uid: true });
      resumen.aPapelera = aPapelera.length;
    }
    resumen.imperdonablesCompletados = await completarImperdonables(sb, imap);
    return resumen;
  } finally {
    lock.release();
    await imap.logout();
  }
}
