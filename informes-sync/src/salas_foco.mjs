// Informe "Salas foco por supervisor" de una zona, con el formato de los
// informes de Talca y Viña: total de la zona, resumen por supervisor, venta
// perdida Cadem, visitas del día anterior y, por supervisor, sus indicadores,
// salas foco y detalle de venta perdida. Los indicadores por sala vienen de
// informe_salas_semana (mismas reglas que el portal).
import { chromium } from "playwright";

const TZ = "America/Santiago";

// ---------------------------------------------------------------- fechas

export function hoySantiago() {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function isoWeek(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const inicio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { anio: d.getUTCFullYear(), semana: Math.ceil(((d - inicio) / 86400000 + 1) / 7) };
}
function lunesDe(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
  return d;
}
const masDias = (d, n) => new Date(d.getTime() + n * 86400000);
const isoFecha = (d) => d.toISOString().slice(0, 10);
const ddmm = (d) => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const diaMes = (d) => d.toLocaleDateString("es-CL", { timeZone: "UTC", day: "numeric", month: "short" }).replace(".", "");
const diaLargo = (d) => d.toLocaleDateString("es-CL", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });

// ---------------------------------------------------------------- formato

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const nf = (v, dec) => v.toLocaleString("es-CL", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const pct = (v, dec = 1) => (v == null ? "–" : `${nf(v * 100, dec)}%`);
const clp = (v) => (v == null ? "–" : `$${Math.round(v).toLocaleString("es-CL")}`);
const milCLP = (v) => (v >= 1e6 ? `$${nf(v / 1e6, 1)} millones` : v >= 1000 ? `$${Math.round(v / 1000)} mil` : clp(v));

const MINUSCULAS = new Set(["de", "del", "y", "e", "en", "con", "a", "al", "s/a", "c/gas", "s/gas"]);
const ACENTOS = { lider: "Líder", curico: "Curicó", vina: "Viña", valparaiso: "Valparaíso", concepcion: "Concepción", maipu: "Maipú",
  rio: "Río", colin: "Colín", peñalolen: "Peñalolén", quilpue: "Quilpué", belloto: "Belloto", nectar: "Néctar", azucar: "Azúcar",
  limon: "Limón", pina: "Piña", unico: "Único", pasaje: "Pasaje", gonzalez: "González", perez: "Pérez", lopez: "López",
  hernandez: "Hernández", henriquez: "Henríquez", espana: "España", martinez: "Martínez", rodriguez: "Rodríguez", fernandez: "Fernández", sanchez: "Sánchez",
  ramirez: "Ramírez", nuñez: "Núñez", jimenez: "Jiménez", diaz: "Díaz", garcia: "García", munoz: "Muñoz" };
export function titulo(s) {
  return String(s ?? "")
    .replace(/\s+\d{8,14}\s*$/, "") // EAN pegado al final del nombre del SKU
    .replace(/\.(?=\p{L})/gu, ". ") // "AV.COLIN" → "AV. COLIN"
    .toLowerCase().split(/\s+/).filter(Boolean).map((w, i) => {
    if (ACENTOS[w]) return ACENTOS[w];
    if (i > 0 && MINUSCULAS.has(w)) return w;
    if (/^(s10|ii|iii|iv|sa|abi|vsr|nartd|wm|smu)$/.test(w)) return w.toUpperCase();
    if (/^\d/.test(w)) return w; // 2x3, 1.5, 200cc
    if (/^(lt|cc|ml|gr|kg)$/.test(w)) return w === "lt" ? "Lt" : w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}
/** "SANTA ISABEL-CONDELL (1836400)" → "Santa Isabel Condell". Si el nombre ya
 * repite la cadena ("LIDER HIPER-HIPER LIDER SAN FELIPE") queda solo el nombre. */
export function nombreSala(s) {
  const sinCodigo = String(s ?? "").replace(/\s*\(\d+\)\s*$/, "").trim();
  const m = sinCodigo.match(/^(.+?)\s*-\s*(.+)$/);
  if (!m) return titulo(sinCodigo);
  const [, cadena, resto] = m;
  const palabrasCadena = new Set(cadena.toLowerCase().split(/\s+/));
  const primera = resto.toLowerCase().split(/\s+/)[0];
  return titulo(palabrasCadena.has(primera) ? resto : `${cadena} ${resto}`);
}

const CAUSAS = {
  "GONDOLA SIN REPOSICION": "Góndola sin reposición", "SIN STOCK": "Sin stock", "STOCK ESTATICO": "Stock estático",
  "STOCK NEGATIVO": "Stock negativo", "SIN INFORMACION B2B": "Sin información B2B",
};
const causaLabel = (c) => CAUSAS[c] ?? titulo(c);

// ---------------------------------------------------------------- cálculos

const RED = [
  { key: "nartd", col: "red_nartd", label: "NARTD", meta: "red_nartd" },
  { key: "abi", col: "red_abi", label: "ABI", meta: "red_abi" },
  { key: "vsr", col: "red_vsr", label: "VSR", meta: "red_vsr" },
];
const PRES = [
  { key: "SMU", label: "Presentismo SMU", corto: "Pres. SMU" },
  { key: "WM", label: "Presentismo WM", corto: "Pres. WM" },
];

function promedio(vals) {
  const v = vals.filter((x) => x != null).map(Number);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function presDe(filas, tipo) {
  const f = filas.filter((r) => r.pres_tipo === tipo && r.pres_objetivo != null && Number(r.pres_objetivo) > 0);
  const obj = f.reduce((a, r) => a + Number(r.pres_objetivo), 0);
  return obj > 0 ? f.reduce((a, r) => a + Number(r.pres_real_topado), 0) / obj : null;
}
/** Indicadores de un grupo de salas en cada una de las 3 semanas (0 = la más vieja). */
function indicadores(salaIds, semanas) {
  return semanas.map((filas) => {
    const f = filas.filter((r) => salaIds.has(r.sala_id));
    return {
      nartd: promedio(f.map((r) => r.red_nartd)),
      abi: promedio(f.map((r) => r.red_abi)),
      vsr: promedio(f.map((r) => r.red_vsr)),
      SMU: presDe(f, "SMU"),
      WM: presDe(f, "WM"),
    };
  });
}
const moda = (vals) => {
  const c = new Map();
  for (const v of vals) if (v) c.set(v, (c.get(v) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** Salas foco: RED y presentismo fuera de meta a la vez, o alguna categoría RED
 * bajo 75%, o presentismo de las 3 semanas bajo 80%. Orden: suma de puntos que
 * faltan para la meta (RED de la semana + presentismo de las 3 semanas). */
function salasFoco(salas, porSala, metas) {
  const metaPres = metas.presentismo ?? 0.95;
  const out = [];
  for (const s of salas) {
    const d = porSala.get(s.sala_id);
    const red = RED.map((c) => ({ ...c, v: d.red[c.key] }));
    const p3 = d.pres3;
    const redFuera = red.some((c) => c.v != null && c.v < (metas[c.meta] ?? 0));
    const presFuera = p3 != null && p3 < metaPres;
    const foco = (redFuera && presFuera) || red.some((c) => c.v != null && c.v < 0.75) || (p3 != null && p3 < 0.8);
    if (!foco) continue;
    const gap = red.reduce((a, c) => a + (c.v != null ? Math.max(0, (metas[c.meta] ?? 0) - c.v) : 0), 0)
      + (p3 != null ? Math.max(0, metaPres - p3) : 0);
    out.push({ ...s, d, gap });
  }
  return out.sort((a, b) => b.gap - a.gap);
}

// ---------------------------------------------------------------- textos

function tendencia(serie) {
  const v = serie.filter((x) => x != null);
  if (v.length < 3) return null;
  if (v[0] < v[1] && v[1] < v[2]) return "sube";
  if (v[0] > v[1] && v[1] > v[2]) return "baja";
  return null;
}
const serieTxt = (serie) => serie.map((x) => pct(x)).join(" a ");
const listaY = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`);

function lineamientosZona({ zona, ind, metas, supervisores, foco, totalSalas, cadem }) {
  const w = ind[2];
  const out = [];
  const enMeta = [], fuera = [];
  for (const c of RED) if (w[c.key] != null) (w[c.key] >= metas[c.meta] ? enMeta : fuera).push(`${c.label} ${pct(w[c.key])}`);
  for (const p of PRES) if (w[p.key] != null) (w[p.key] >= metas.presentismo ? enMeta : fuera).push(`${p.corto.replace("Pres. ", "presentismo ")} ${pct(w[p.key])}`);
  if (enMeta.length) out.push(`<b>En meta:</b> ${listaY(enMeta)}.`);
  if (fuera.length) out.push(`<b>Fuera de meta:</b> ${listaY(fuera)}.`);

  for (const p of PRES) {
    const t = tendencia(ind.map((x) => x[p.key]));
    if (t) out.push(`${p.label} ${t === "sube" ? "sube" : "baja"} tres semanas seguidas (${serieTxt(ind.map((x) => x[p.key]))}).`);
  }
  // Supervisor más débil en cada indicador fuera de meta.
  const debiles = [];
  for (const c of [...RED, ...PRES.map((p) => ({ key: p.key, label: p.corto, meta: "presentismo" }))]) {
    if (w[c.key] == null || w[c.key] >= metas[c.meta]) continue;
    const peor = supervisores.filter((s) => s.ind[2][c.key] != null).sort((a, b) => a.ind[2][c.key] - b.ind[2][c.key])[0];
    if (peor && supervisores.length > 1) debiles.push(`${c.label} más bajo: ${esc(peor.nombre)}${peor.subzona ? ` (${esc(peor.subzona)})` : ""} con ${pct(peor.ind[2][c.key])}`);
  }
  if (debiles.length) out.push(`${debiles.join("; ")}.`);
  if (cadem.total > 0) {
    const [c1, c2] = cadem.causas;
    out.push(`<b>Venta perdida Cadem:</b> ${milCLP(cadem.total)}; ${Math.round(c1.pct * 100)}% es ${c1.label.toLowerCase()}${c2 ? ` y ${Math.round(c2.pct * 100)}% ${c2.label.toLowerCase()}` : ""}. La sala que más pierde es ${esc(cadem.salas[0].nombre)} (${milCLP(cadem.salas[0].total)}).`);
  }
  out.push(`<b>Salas foco:</b> son ${foco} de ${totalSalas}. Cada supervisor debe cerrar un plan semanal para las suyas, cargado como tarea en la app.`);
  out.push(`Una sala sin RED cargado en la semana (–) no está en 0%: pedir la carga antes de evaluarla.`);
  return out;
}

function lineamientosSupervisor({ ind, metas, foco, cadem }) {
  const w = ind[2];
  const out = [];
  for (const p of PRES) {
    if (w[p.key] == null) continue;
    const serie = ind.map((x) => x[p.key]);
    if (w[p.key] >= metas.presentismo) { out.push(`<b>${p.label} en meta</b> (${pct(w[p.key])}). Mantener.`); continue; }
    const peores = foco.filter((s) => s.d.presTipo === p.key && s.d.pres3 != null && s.d.pres3 < metas.presentismo)
      .sort((a, b) => a.d.pres3 - b.d.pres3).slice(0, 3);
    const t = tendencia(serie);
    out.push(`<b>${p.label} ${pct(w[p.key])}</b>${t ? ` y ${t === "sube" ? "mejorando" : "bajando"} (${serieTxt(serie)})` : ""}.`
      + (peores.length ? ` Las más bajas en tres semanas: ${listaY(peores.map((s) => `${esc(s.nombre)} (${pct(s.d.pres3, 0)})`))}.` : ""));
  }
  const redFuera = RED.filter((c) => w[c.key] != null && w[c.key] < metas[c.meta]);
  const redOk = RED.filter((c) => w[c.key] != null && w[c.key] >= metas[c.meta]);
  if (redFuera.length) {
    const partes = redFuera.map((c) => {
      const peores = foco.filter((s) => s.d.red[c.key] != null && s.d.red[c.key] < metas[c.meta])
        .sort((a, b) => a.d.red[c.key] - b.d.red[c.key]).slice(0, 3);
      return `${c.label} en ${pct(w[c.key])}${peores.length ? ` (${listaY(peores.map((s) => `${esc(s.nombre)} ${pct(s.d.red[c.key], 0)}`))})` : ""}`;
    });
    out.push(`<b>RED:</b> ${partes.join("; ")}.${redOk.length ? ` ${listaY(redOk.map((c) => c.label))} en meta.` : ""}`);
  } else if (redOk.length) {
    out.push(`<b>RED en meta</b> en ${listaY(redOk.map((c) => c.label))}.`);
  }
  if (cadem.total > 0) {
    const c1 = cadem.causas[0];
    let t = `<b>Cadem:</b> ${milCLP(cadem.total)}; el ${Math.round(c1.pct * 100)}% es ${c1.label.toLowerCase()}.`;
    const larga = cadem.filas.filter((r) => r.dias >= 7).sort((a, b) => b.vp - a.vp)[0];
    if (larga) t += ` ${esc(larga.sala)} tiene ${esc(larga.sku)} con ${larga.dias} días sin venta (${milCLP(larga.vp)}): revisar ${/stock/i.test(larga.causa) ? "inventario y abastecimiento" : "la reposición"}.`;
    const s0 = cadem.salas[0];
    if (s0 && s0.total / cadem.total >= 0.4) t += ` ${esc(s0.nombre)} concentra ${milCLP(s0.total)}.`;
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- HTML

const CSS = `
  @page { size: A4; margin: 14mm 13mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10.5px/1.45 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; }
  .pag { break-after: page; }
  .pag:last-child { break-after: auto; }
  .cab { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; border-bottom: 2.5px solid #b91c1c; padding-bottom: 6px; margin-bottom: 12px; }
  .cab h1 { font-size: 24px; margin: 0; letter-spacing: -0.01em; line-height: 1.15; }
  .cab .s { color: #6b7280; font-size: 11.5px; }
  .cab .d { text-align: right; color: #6b7280; font-size: 11px; white-space: nowrap; }
  h2 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: #4b5563; margin: 14px 0 6px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .card { border: 1px solid #e5e7eb; border-left: 4px solid #9ca3af; border-radius: 5px; padding: 7px 10px; background: #f9fafb; }
  .card.ok { border-left-color: #16a34a; background: #f0fdf4; } .card.bad { border-left-color: #dc2626; background: #fef2f2; }
  .card .l { color: #4b5563; font-size: 10px; font-weight: 600; }
  .card .v { font-size: 25px; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
  .card .m { color: #6b7280; font-size: 9.5px; }
  .card .t { font-size: 9.5px; font-weight: 600; } .t.up { color: #15803d; } .t.down { color: #b91c1c; } .t.eq { color: #4b5563; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th { font-size: 9.5px; color: #6b7280; font-weight: 600; text-align: center; padding: 4px 6px; border-bottom: 1.5px solid #d1d5db; }
  td { text-align: center; padding: 4px 6px; border-bottom: 1px solid #eef0f2; }
  th.l, td.l { text-align: left; } td.r, th.r { text-align: right; } td.b { font-weight: 600; }
  td.bad { color: #b91c1c; background: #fde8e8; font-weight: 700; } td.ok { color: #15803d; } td.na { color: #9ca3af; }
  tr { break-inside: avoid; }
  .caja { border: 1px solid #e5e7eb; background: #f9fafb; border-radius: 5px; padding: 8px 12px; font-size: 11px; }
  .caja ul { margin: 0; padding-left: 16px; } .caja li { margin: 3px 0; }
  .nota { color: #6b7280; font-size: 9px; margin-top: 8px; }
  .dos { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .barra { display: inline-block; height: 8px; background: #b91c1c; vertical-align: middle; }
  td.sala { width: 32%; } td.sala .x { color: #6b7280; font-size: 9px; font-weight: 400; }
  .pill { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 9px; font-weight: 700; }
  .pill.EXCELENTE { background: #dcfce7; color: #166534; } .pill.BUENO { background: #e0f2fe; color: #075985; }
  .pill.REGULAR { background: #fef3c7; color: #92400e; } .pill.CRÍTICO, .pill.CRITICO { background: #fee2e2; color: #991b1b; }
  .vacio { color: #6b7280; padding: 6px 0; }
`;

function tarjeta(label, v, meta, prev, extra = "") {
  const cls = v == null ? "" : v >= meta ? "ok" : "bad";
  let t = "";
  if (v != null && prev != null) {
    const d = (v - prev) * 100;
    t = Math.abs(d) < 0.05 ? `<div class="t eq">= sin cambio</div>`
      : `<div class="t ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${nf(Math.abs(d), 1)} pt vs semana anterior</div>`;
  }
  return `<div class="card ${cls}"><div class="l">${label}</div><div class="v">${pct(v)}</div><div class="m">Meta ${pct(meta, 0)}</div>${t}${extra}</div>`;
}
function tarjetas(ind, metas, sem, cadem) {
  const [a, b, w] = ind;
  const serie = (k) => `<div class="m">S${sem[0]} ${pct(a[k])} · S${sem[1]} ${pct(b[k])} · S${sem[2]} ${pct(w[k])}</div>`;
  return `<div class="cards">
    ${RED.map((c) => tarjeta(`RED · ${c.label}`, w[c.key], metas[c.meta], b[c.key])).join("")}
    ${PRES.map((p) => (w[p.key] == null && b[p.key] == null
      ? `<div class="card"><div class="l">${p.label}</div><div class="v">–</div><div class="m">Sin salas con este presentismo</div></div>`
      : tarjeta(p.label, w[p.key], metas.presentismo, b[p.key], serie(p.key)))).join("")}
    <div class="card"><div class="l">Venta perdida Cadem</div><div class="v">${clp(cadem.total)}</div><div class="m">Datawalt · S${sem[2]}</div><div class="m">${cadem.salas.length} salas con datos</div></div>
  </div>`;
}
const celda = (v, meta, dec = 1) => `<td class="${v == null ? "na" : v >= meta ? "ok" : "bad"}">${pct(v, dec)}</td>`;

function tablaFoco(foco, metas, sem) {
  if (!foco.length) return `<p class="vacio">Ninguna sala cumple el criterio de sala foco esta semana.</p>`;
  return `<table>
    <tr><th class="l" rowspan="2">Sala</th><th colspan="3">RED S${sem[2]}</th><th colspan="4">Presentismo</th></tr>
    <tr><th>NARTD</th><th>ABI</th><th>VSR</th><th>S${sem[0]}</th><th>S${sem[1]}</th><th>S${sem[2]}</th><th>3 sem.</th></tr>
    ${foco.map((s, i) => `<tr><td class="l b">${i + 1}. ${esc(s.nombre)}</td>
      ${RED.map((c) => celda(s.d.red[c.key], metas[c.meta], 0)).join("")}
      ${s.d.presSem.map((v) => celda(v, metas.presentismo, 0)).join("")}${celda(s.d.pres3, metas.presentismo, 0)}</tr>`).join("")}
  </table>
  <p class="nota">Rojo = fuera de meta. "–" = sin dato en la semana. Orden: mayor distancia total a la meta.</p>`;
}

function seccionVisitas(visitas, fecha) {
  const titulo = `Visitas del día anterior · ${diaLargo(fecha)}`;
  if (!visitas.length) return `<h2>${titulo}</h2><p class="vacio">No se registraron visitas en la app ese día.</p>`;
  const salas = new Set(visitas.map((v) => v.sala)).size;
  const puntajes = visitas.map((v) => v.puntaje).filter((x) => x != null);
  const prom = puntajes.length ? Math.round(puntajes.reduce((a, b) => a + b, 0) / puntajes.length) : null;
  const porQuien = [...visitas.reduce((m, v) => m.set(v.quien, (m.get(v.quien) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]).map(([q, n]) => `${esc(titulo_(q))} ${n}`);
  const criticas = visitas.filter((v) => v.nivel === "CRÍTICO" || v.nivel === "REGULAR").length;
  return `<h2>${titulo}</h2>
    <div class="caja" style="margin-bottom:8px"><b>${visitas.length} visita${visitas.length === 1 ? "" : "s"}</b> en ${salas} sala${salas === 1 ? "" : "s"}${prom != null ? ` · puntaje promedio <b>${prom}</b>` : ""}${criticas ? ` · ${criticas} con nivel regular o crítico` : ""}. Por persona: ${porQuien.join(", ")}.</div>
    <table>
      <tr><th class="l">Sala</th><th class="l">Visitó</th><th>Tipo</th><th>Min.</th><th>Puntaje</th><th>Nivel</th><th class="l">Foco urgente (IA)</th></tr>
      ${visitas.map((v) => `<tr><td class="l b">${esc(v.salaNombre)}</td><td class="l" style="white-space:nowrap">${esc(titulo_(v.quien))}</td><td>${esc(titulo_(v.tipo))}</td>
        <td>${v.minutos ?? "–"}</td><td class="${v.puntaje != null && v.puntaje < 80 ? "bad" : ""}">${v.puntaje ?? "–"}</td>
        <td>${v.nivel ? `<span class="pill ${esc(v.nivel)}">${esc(titulo_(v.nivel))}</span>` : "–"}</td>
        <td class="l">${esc(v.foco_urgente ?? "")}</td></tr>`).join("")}
    </table>`;
}
const titulo_ = titulo;

function paginaCadem(sup, cadem, sem, focoIds) {
  const max = Math.max(...cadem.causas.map((c) => c.vp));
  return `<section class="pag">
    <div class="cab"><div><h1>${esc(sup.nombre)}</h1><div class="s">Venta perdida Cadem (Datawalt) · Semana ${sem} · los 3 SKU más conflictivos por sala</div></div>
      <div class="d">${clp(cadem.total)} en ${cadem.salas.length} salas con datos<br>★ = sala foco</div></div>
    <div class="dos">
      <div><h2>Causas del quiebre</h2><table>
        ${cadem.causas.map((c) => `<tr><td class="l b">${esc(c.label)}</td><td class="r">${clp(c.vp)}</td><td class="r">${Math.round(c.pct * 100)}%</td>
          <td class="l" style="width:45%"><span class="barra" style="width:${Math.max(2, (c.vp / max) * 100)}%"></span></td></tr>`).join("")}
      </table></div>
      <div><h2>Top 3 SKU del supervisor</h2><table>
        ${cadem.skus.slice(0, 3).map((s, i) => `<tr><td class="l b">${i + 1}. ${esc(s.sku)}</td><td class="r">${clp(s.vp)}</td></tr>`).join("")}
      </table></div>
    </div>
    <h2>Detalle por sala (mayor a menor venta perdida)</h2>
    <table>
      <tr><th class="l">Sala</th><th class="l">SKU</th><th class="l">Causa</th><th>Días sin venta</th><th class="r">Venta perdida</th></tr>
      ${cadem.salas.map((s) => s.top.map((r, i) => `<tr>
        ${i === 0 ? `<td class="l sala b" rowspan="${s.top.length}">${focoIds.has(s.salaId) ? "★ " : ""}${esc(s.nombre)}<br><span class="x">${clp(s.total)} · ${s.n} SKU con quiebre</span></td>` : ""}
        <td class="l b">${esc(r.sku)}</td><td class="l">${esc(r.causaLabel)}</td><td>${r.dias ?? "–"}</td><td class="r">${clp(r.vp)}</td></tr>`).join("")).join("")}
    </table>
    <p class="nota">Fuente: Datawalt, reporte Embonor Agencia &gt; Causas del quiebre. Solo aparecen las salas que el reporte de la semana ${sem} trae con quiebre; las que no figuran no tienen datos, no necesariamente cero.</p>
  </section>`;
}

/** Venta perdida Cadem de un grupo de filas de causas_quiebre. */
function resumirCadem(filas) {
  const total = filas.reduce((a, r) => a + r.vp, 0);
  const porCausa = new Map(), porSku = new Map(), porSala = new Map();
  for (const r of filas) {
    porCausa.set(r.causaLabel, (porCausa.get(r.causaLabel) ?? 0) + r.vp);
    const k = porSku.get(r.sku) ?? { sku: r.sku, vp: 0, salas: new Set() };
    k.vp += r.vp; k.salas.add(r.salaId); porSku.set(r.sku, k);
    const s = porSala.get(r.salaId) ?? { salaId: r.salaId, nombre: r.sala, total: 0, filas: [] };
    s.total += r.vp; s.filas.push(r); porSala.set(r.salaId, s);
  }
  return {
    total, filas,
    causas: [...porCausa].map(([label, vp]) => ({ label, vp, pct: total ? vp / total : 0 })).sort((a, b) => b.vp - a.vp),
    skus: [...porSku.values()].map((k) => ({ ...k, nSalas: k.salas.size })).sort((a, b) => b.vp - a.vp),
    salas: [...porSala.values()].map((s) => ({ ...s, n: s.filas.length, top: s.filas.sort((a, b) => b.vp - a.vp).slice(0, 3) }))
      .sort((a, b) => b.total - a.total),
  };
}

// ---------------------------------------------------------------- armado

/**
 * Datos de todas las zonas de una vez (las funciones devuelven todas las
 * salas); `htmlZona` arma el informe de cada una.
 */
export async function cargarDatos(sb, { incluirVisitas = true } = {}) {
  const hoy = hoySantiago();
  const lunes = masDias(lunesDe(hoy), -7); // última semana cerrada
  const semanas = [masDias(lunes, -14), masDias(lunes, -7), lunes].map(isoWeek);
  const ayer = masDias(hoy, -1);

  const rpc = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const traerCausas = async () => {
    const w = semanas[2], out = [];
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await sb.from("causas_quiebre")
        .select("sala_id, sku_nombre, causa, dias_sin_venta, venta_perdida")
        .eq("anio", w.anio).eq("semana", w.semana).gt("venta_perdida", 0).range(desde, desde + 999);
      if (error) throw new Error(`causas_quiebre: ${error.message}`);
      out.push(...data);
      if (data.length < 1000) return out;
    }
  };
  const [s0, s1, s2, causas, visitas, metasRes, zonasRes] = await Promise.all([
    ...semanas.map((w) => rpc("informe_salas_semana", { p_anio: w.anio, p_semana: w.semana })),
    traerCausas(),
    incluirVisitas ? rpc("informe_visitas_dia", { p_fecha: isoFecha(ayer) }) : [],
    sb.from("metas_indicadores").select("clave, valor"),
    sb.from("zonas").select("id, nombre"),
  ]);
  if (metasRes.error) throw new Error(`metas_indicadores: ${metasRes.error.message}`);
  if (zonasRes.error) throw new Error(`zonas: ${zonasRes.error.message}`);
  return {
    lunes, ayer, emitido: hoy, semanas, filasSem: [s0, s1, s2], causas, visitas, incluirVisitas,
    metas: Object.fromEntries(metasRes.data.map((m) => [m.clave, Number(m.valor)])),
    zonas: zonasRes.data,
  };
}

export function armarZona(datos, zonaId) {
  const { semanas, filasSem, metas } = datos;
  const sem = semanas.map((w) => w.semana);
  const zona = datos.zonas.find((z) => z.id === zonaId);
  const salasZona = filasSem[2].filter((r) => r.zona_id === zonaId)
    .map((r) => ({ sala_id: r.sala_id, nombre: nombreSala(r.sala), supervisorId: r.supervisor_id, supervisor: r.supervisor, subzona: r.subzona }));
  const ids = new Set(salasZona.map((s) => s.sala_id));

  // Por sala: RED de la semana, presentismo por semana y de las 3 juntas.
  const porSala = new Map();
  const idx = filasSem.map((filas) => new Map(filas.map((r) => [r.sala_id, r])));
  for (const s of salasZona) {
    const rs = idx.map((m) => m.get(s.sala_id));
    const w = rs[2];
    const presSem = rs.map((r) => (r && Number(r.pres_objetivo) > 0 ? Number(r.pres_real_topado) / Number(r.pres_objetivo) : null));
    const obj = rs.reduce((a, r) => a + (r && r.pres_objetivo != null ? Number(r.pres_objetivo) : 0), 0);
    const real = rs.reduce((a, r) => a + (r && r.pres_real_topado != null ? Number(r.pres_real_topado) : 0), 0);
    porSala.set(s.sala_id, {
      red: { nartd: w.red_nartd == null ? null : Number(w.red_nartd), abi: w.red_abi == null ? null : Number(w.red_abi), vsr: w.red_vsr == null ? null : Number(w.red_vsr) },
      presTipo: w.pres_tipo, presSem, pres3: obj > 0 ? real / obj : null,
    });
  }

  const causas = datos.causas.filter((r) => ids.has(r.sala_id)).map((r) => ({
    salaId: r.sala_id, sala: salasZona.find((s) => s.sala_id === r.sala_id)?.nombre ?? "",
    sku: titulo(r.sku_nombre), causa: r.causa, causaLabel: causaLabel(r.causa), dias: r.dias_sin_venta, vp: Number(r.venta_perdida),
  }));

  const foco = salasFoco(salasZona, porSala, metas);
  const porSup = new Map();
  for (const s of salasZona) {
    const k = s.supervisorId ?? "sin";
    if (!porSup.has(k)) porSup.set(k, { id: k, nombre: s.supervisor ? titulo(s.supervisor) : "Sin supervisor", salas: [] });
    porSup.get(k).salas.push(s);
  }
  const supervisores = [...porSup.values()].map((g) => {
    const sIds = new Set(g.salas.map((s) => s.sala_id));
    return {
      ...g, subzona: titulo(moda(g.salas.map((s) => s.subzona))), ind: indicadores(sIds, filasSem),
      foco: foco.filter((s) => sIds.has(s.sala_id)),
      cadem: resumirCadem(causas.filter((r) => sIds.has(r.salaId))),
    };
  }).sort((a, b) => (a.id === "sin") - (b.id === "sin") || a.nombre.localeCompare(b.nombre, "es"));

  const visitas = datos.visitas.filter((v) => v.zona_id === zonaId).map((v) => ({ ...v, salaNombre: nombreSala(v.sala) }));
  return {
    zona: titulo(zona?.nombre ?? ""), sem, metas, salasZona, foco, supervisores, visitas,
    ind: indicadores(ids, filasSem), cadem: resumirCadem(causas),
  };
}

export function htmlZona(datos, z) {
  const { metas, sem } = z;
  const emitido = ddmm(datos.emitido) + "-" + datos.emitido.getUTCFullYear();
  const rangoW = `${diaMes(datos.lunes)}–${diaMes(masDias(datos.lunes, 6))}`;
  const rango3 = `${diaMes(masDias(datos.lunes, -14))}–${diaMes(masDias(datos.lunes, 6))}`;

  const filaSup = (s) => `<tr><td class="l b">${esc(s.nombre)}</td><td>${esc(s.subzona ?? "–")}</td><td>${s.salas.length}</td>
    ${RED.map((c) => celda(s.ind[2][c.key], metas[c.meta])).join("")}
    ${PRES.map((p) => celda(s.ind[2][p.key], metas.presentismo)).join("")}
    <td class="r">${s.cadem.total ? clp(s.cadem.total) : "–"}</td><td class="b">${s.foco.length}</td></tr>`;

  const top3 = z.cadem.skus.slice(0, 3).map((s) => `${esc(s.sku)} (${clp(s.vp)}, ${s.nSalas} sala${s.nSalas === 1 ? "" : "s"})`);
  const cajaCadem = z.cadem.total
    ? `<b>${clp(z.cadem.total)}</b> en ${z.cadem.salas.length} salas con datos. Causa principal: ${z.cadem.causas[0].label.toLowerCase()} (${Math.round(z.cadem.causas[0].pct * 100)}%)${z.cadem.causas[1] ? `, luego ${z.cadem.causas[1].label.toLowerCase()} (${Math.round(z.cadem.causas[1].pct * 100)}%)` : ""}. SKU más conflictivos de ${esc(z.zona)}: ${top3.join("; ")}.`
    : `Sin datos de causas de quiebre cargados para la semana ${sem[2]}.`;

  const paginaZona = `<section class="pag">
    <div class="cab"><div><h1>${esc(z.zona)} · Salas foco por supervisor</h1><div class="s">Informe de gestión semanal</div></div>
      <div class="d">Emitido ${emitido}<br>RED y venta perdida Cadem: S${sem[2]} (${rangoW})<br>Presentismo: S${sem[0]}–S${sem[2]} (${rango3})</div></div>
    <h2>Total ${esc(z.zona)}</h2>
    ${tarjetas(z.ind, metas, sem, z.cadem)}
    <h2>Resumen por supervisor (S${sem[2]})</h2>
    <table><tr><th class="l">Supervisor</th><th>Subzona</th><th>Salas</th><th>NARTD</th><th>ABI</th><th>VSR</th><th>Pres. SMU</th><th>Pres. WM</th><th class="r">Vta. perdida Cadem</th><th>Salas foco</th></tr>
      ${z.supervisores.map(filaSup).join("")}</table>
    <h2>Venta perdida Cadem (Datawalt) · S${sem[2]}</h2>
    <div class="caja">${cajaCadem}</div>
    <h2>Lineamientos generales</h2>
    <div class="caja"><ul>${lineamientosZona({ zona: z.zona, ind: z.ind, metas, supervisores: z.supervisores, foco: z.foco.length, totalSalas: z.salasZona.length, cadem: z.cadem }).map((l) => `<li>${l}</li>`).join("")}</ul></div>
    <p class="nota">Metas del portal: RED NARTD ${pct(metas.red_nartd, 0)}, ABI ${pct(metas.red_abi, 0)}, VSR ${pct(metas.red_vsr, 0)}; presentismo ${pct(metas.presentismo, 0)}. <b>Sala foco:</b> RED y presentismo fuera de meta a la vez, o alguna categoría RED bajo 75%, o presentismo de las 3 semanas bajo 80%; se ordenan por la suma de puntos faltantes a la meta. Presentismo WM = horas realizadas sobre objetivo (sin Acuenta); SMU = horas cumplidas sobre objetivo (sin S10/Super 10), topado al objetivo diario. RED por supervisor = promedio simple. Cadem solo cubre las salas que Datawalt reporta con quiebre esa semana.</p>
  </section>`;

  const paginaVisitas = datos.incluirVisitas ? `<section class="pag">
    <div class="cab"><div><h1>${esc(z.zona)} · Visitas</h1><div class="s">Visitas registradas en la app con su análisis de IA</div></div>
      <div class="d">${diaLargo(datos.ayer)}</div></div>
    ${seccionVisitas(z.visitas, datos.ayer)}
  </section>` : "";

  const paginasSup = z.supervisores.filter((s) => s.id !== "sin").map((s) => {
    const focoIds = new Set(s.foco.map((f) => f.sala_id));
    return `<section class="pag">
      <div class="cab"><div><h1>${esc(s.nombre)}</h1><div class="s">Supervisor · Subzona ${esc(s.subzona ?? "–")} · ${s.salas.length} salas activas</div></div>
        <div class="d">${s.foco.length} salas foco<br>Semana ${sem[2]} · emitido ${emitido}</div></div>
      <h2>Indicadores del supervisor</h2>
      ${tarjetas(s.ind, metas, sem, s.cadem)}
      <h2>Salas foco (${s.foco.length} de ${s.salas.length})</h2>
      ${tablaFoco(s.foco, metas, sem)}
      <h2>Lineamientos para la semana</h2>
      <div class="caja"><ul>${lineamientosSupervisor({ ind: s.ind, metas, foco: s.foco, cadem: s.cadem }).map((l) => `<li>${l}</li>`).join("")}</ul></div>
    </section>${s.cadem.total ? paginaCadem(s, s.cadem, sem[2], focoIds) : ""}`;
  }).join("");

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(z.zona)} · Salas foco</title><style>${CSS}</style></head>
    <body>${paginaZona}${paginaVisitas}${paginasSup}</body></html>`;
}

export async function aPdf(htmls) {
  // PW_CHANNEL=msedge permite generarlo en una PC con Windows sin bajar Chromium.
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  try {
    const out = [];
    for (const html of htmls) {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });
      out.push(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

export { pct, clp, esc, diaLargo, ddmm };
