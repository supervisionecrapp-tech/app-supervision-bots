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

// ---------------------------------------------------------------- brecha a meta

/** Componentes de cada categoría RED con su peso nominal en la nota. */
const COMPONENTES = {
  nartd: [
    ["nss_pct", "NSS · disponibilidad", 0.20], ["sovi_pct", "SOVI · espacio en góndola", 0.35],
    ["estrat_ice_pct", "Estrategia ICE", 0.20], ["exhib_pactadas_pct", "Exhibición pactada", 0.12],
    ["nsf_pct", "NSF · nivel de frío", 0.05], ["catalogos_pct", "Catálogos", 0.05], ["com_pop_pct", "Comunicación POP", 0.03],
  ],
  abi: [["nss_pct", "NSS · disponibilidad", 0.25], ["sovi_pct", "SOVI · espacio en góndola", 0.25],
    ["exhib_adicionales_pct", "Exhibición adicional", 0.25], ["catalogos_pct", "Catálogos", 0.25]],
  vsr: [["nss_pct", "NSS · disponibilidad", 0.5], ["catalogos_pct", "Catálogos", 0.5]],
};
const CORTO = { "NSS · disponibilidad": "NSS", "SOVI · espacio en góndola": "SOVI", "Estrategia ICE": "ICE", "Exhibición pactada": "Exhib.",
  "NSF · nivel de frío": "NSF", "Catálogos": "Catál.", "Comunicación POP": "POP", "Exhibición adicional": "Exhib." };

/**
 * Puntos de la nota RED que pierde una sala en cada componente. Se reparte
 * lo que le falta para 100% según el peso de cada componente y lo que le
 * falta en él; si un componente no aplica (vacío), su peso se reparte entre
 * los demás. El reparto se escala a la nota real, así la suma de lo perdido
 * es exactamente 100% − RED de la sala.
 */
function perdidasSala(fila, cat) {
  const red = fila?.red_pct == null ? null : Number(fila.red_pct);
  if (red == null) return null;
  const comps = COMPONENTES[cat].filter(([col]) => fila[col] != null)
    .map(([col, label, peso]) => ({ col, label, peso, nota: Number(fila[col]) }));
  const crudo = comps.map((c) => c.peso * Math.max(0, 1 - c.nota));
  const total = crudo.reduce((a, b) => a + b, 0);
  const escala = total > 0 ? Math.max(0, 1 - red) / total : 0;
  return { red, comps: comps.map((c, i) => ({ ...c, pierde: crudo[i] * escala })) };
}

/**
 * Brecha de un grupo de salas a la meta de una categoría, por componente, y
 * el plan mínimo: las acciones sala × componente ordenadas por cuánto suben
 * el promedio del grupo si ese componente llega a 100% en esa sala,
 * acumuladas hasta alcanzar la meta.
 */
function brecha(salas, compPorSala, cat, meta) {
  const filas = salas.map((s) => ({ s, p: perdidasSala(compPorSala.get(s.sala_id), cat) })).filter((x) => x.p);
  const n = filas.length;
  if (!n) return null;
  const promedio = filas.reduce((a, x) => a + x.p.red, 0) / n;
  const porComp = new Map();
  for (const { p } of filas) for (const c of p.comps) {
    const g = porComp.get(c.label) ?? { label: c.label, pierde: 0, notas: [] };
    g.pierde += c.pierde / n; g.notas.push(c.nota); porComp.set(c.label, g);
  }
  const componentes = [...porComp.values()]
    .map((g) => ({ ...g, nota: g.notas.reduce((a, b) => a + b, 0) / g.notas.length }))
    .sort((a, b) => b.pierde - a.pierde);
  const falta = Math.max(0, meta - promedio);
  const acciones = filas.flatMap(({ s, p }) => p.comps.filter((c) => c.pierde > 0.0005)
    .map((c) => ({ sala: s, comp: c.label, nota: c.nota, sube: c.pierde / n })))
    .sort((a, b) => b.sube - a.sube);
  const plan = [];
  let proyectado = promedio;
  for (const a of acciones) {
    if (proyectado >= meta) break;
    proyectado += a.sube;
    plan.push({ ...a, proyectado });
  }
  return { n, promedio, meta, falta, componentes, plan, alcanza: proyectado >= meta, maximo: promedio + acciones.reduce((t, a) => t + a.sube, 0) };
}

/** Horas de presentismo que faltan en la semana, por sala, con los días críticos. */
function horasFaltantes(salas, diasPorSala) {
  const DIA = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  return salas.map((s) => {
    const dias = diasPorSala.get(s.sala_id) ?? [];
    const obj = dias.reduce((a, d) => a + d.objetivo, 0);
    const real = dias.reduce((a, d) => a + d.real, 0);
    const criticos = dias.filter((d) => d.real < d.objetivo * 0.75)
      .sort((a, b) => a.fecha.localeCompare(b.fecha))
      .map((d) => `${DIA[new Date(d.fecha + "T12:00:00Z").getUTCDay()]} ${nf(d.real, 0)}/${nf(d.objetivo, 0)} h`);
    return { ...s, obj, real, falta: obj - real, criticos };
  }).filter((x) => x.obj > 0);
}

const ACCION_CAUSA = {
  "GONDOLA SIN REPOSICION": "Reponer góndola (hay stock en sala)",
  "SIN STOCK": "Generar pedido / revisar abastecimiento",
  "STOCK ESTATICO": "Ajustar inventario (stock que no se vende)",
  "STOCK NEGATIVO": "Ajustar inventario (stock negativo)",
  "SIN INFORMACION B2B": "Validar datos B2B con la cadena",
};
const accionDe = (causa) => ACCION_CAUSA[causa] ?? "Revisar";

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
  td.warn { color: #92400e; background: #fef3c7; font-weight: 600; } .okt { color: #15803d; font-weight: 600; }
  td .x, .x { color: #6b7280; font-size: 9px; font-weight: 400; }
  tr.tot td { font-weight: 700; border-top: 1.5px solid #d1d5db; }
  .linea { margin: 8px 0 5px; font-size: 11px; }
  table.matriz td, table.matriz th { padding: 3px 4px; }
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
/** Color de la nota de un componente: rojo bajo 70%, ámbar bajo 90%. */
const celdaComp = (v) => `<td class="${v == null ? "na" : v < 0.7 ? "bad" : v < 0.9 ? "warn" : "ok"}">${pct(v, 0)}</td>`;
const pts = (v, dec = 1) => (v == null ? "–" : nf(v * 100, dec));

/** Tabla de brecha a meta de un grupo: una fila por categoría. */
function tablaBrecha(brechas, metas) {
  const filas = RED.map((c) => {
    const b = brechas[c.key];
    if (!b) return `<tr><td class="l b">${c.label}</td><td colspan="5" class="na">Sin carga RED esta semana</td></tr>`;
    const top = b.componentes.slice(0, 3).map((k) => `${esc(CORTO[k.label] ?? k.label)} −${pts(k.pierde)} <span class="x">(nota ${pct(k.nota, 0)})</span>`).join(" · ");
    const acciones = b.falta <= 0 ? `<span class="okt">En meta</span>`
      : b.alcanza ? `<b>${b.plan.length}</b> acciones sala × componente`
      : `No alcanza: aun con todo a 100% queda en ${pct(b.maximo)}`;
    return `<tr><td class="l b">${c.label}</td>${celda(b.promedio, metas[c.meta])}<td>${pct(metas[c.meta], 0)}</td>
      <td class="b">${b.falta > 0 ? `${pts(b.falta)} pts` : "–"}</td><td class="l">${top}</td><td class="l">${acciones}</td></tr>`;
  }).join("");
  return `<table><tr><th class="l">Categoría</th><th>Nota</th><th>Meta</th><th>Falta</th><th class="l">Dónde se pierden puntos (de 100)</th><th class="l">Para llegar a la meta</th></tr>${filas}</table>`;
}

/** Plan mínimo para llegar a la meta en una categoría, acción por acción. */
function caminoMeta(b, cat, limite = 12) {
  if (!b) return "";
  if (b.falta <= 0) return `<p class="linea"><b>${cat}</b> ${pct(b.promedio)}: en meta (${pct(b.meta, 0)}).</p>`;
  const plan = b.plan.slice(0, limite);
  const fin = b.plan[b.plan.length - 1];
  const cabecera = b.alcanza
    ? `<b>${cat}</b> ${pct(b.promedio)} → meta ${pct(b.meta, 0)}: faltan <b>${pts(b.falta)} pts</b>. Con estas <b>${b.plan.length} acciones</b> llega a <b>${pct(fin.proyectado)}</b>.`
    : `<b>${cat}</b> ${pct(b.promedio)} → meta ${pct(b.meta, 0)}: faltan <b>${pts(b.falta)} pts</b>. Ni con todos los componentes a 100% se llega: el máximo es ${pct(b.maximo)} (hay salas sin carga o la meta exige más de lo que se mide).`;
  return `<p class="linea">${cabecera}</p>
    <table><tr><th>#</th><th class="l">Sala</th><th class="l">Llevar a 100%</th><th>Nota hoy</th><th>Sube</th><th>Queda en</th></tr>
    ${plan.map((a, i) => `<tr><td>${i + 1}</td><td class="l b">${esc(a.sala.nombre)}</td><td class="l">${esc(a.comp)}</td>
      ${celdaComp(a.nota)}<td>+${pts(a.sube, 2)}</td><td class="${a.proyectado >= b.meta ? "okt b" : ""}">${pct(a.proyectado)}</td></tr>`).join("")}
    </table>${b.plan.length > limite ? `<p class="nota">Y ${b.plan.length - limite} acciones más, de menor impacto, hasta completar las ${b.plan.length}.</p>` : ""}`;
}

/** Matriz de salas foco: nota RED y componentes NARTD, para ver dónde pierde cada una. */
function matrizFoco(salas, z, metas) {
  if (!salas.length) return `<p class="vacio">Ninguna sala cumple el criterio de sala foco esta semana.</p>`;
  const comps = COMPONENTES.nartd;
  return `<table class="matriz"><tr><th class="l" rowspan="2">Sala</th><th colspan="${comps.length + 1}">NARTD</th><th rowspan="2">ABI</th><th rowspan="2">VSR</th><th rowspan="2">Pres.<br>3 sem.</th></tr>
    <tr><th>Nota</th>${comps.map(([, label]) => `<th>${esc(CORTO[label])}</th>`).join("")}</tr>
    ${salas.map((s) => {
      const f = z.comp.nartd.get(s.sala_id);
      return `<tr><td class="l b">${esc(s.nombre)}</td>${celda(s.d.red.nartd, metas.red_nartd, 0)}
        ${comps.map(([col]) => celdaComp(f?.[col] == null ? null : Number(f[col]))).join("")}
        ${celda(s.d.red.abi, metas.red_abi, 0)}${celda(s.d.red.vsr, metas.red_vsr, 0)}${celda(s.d.pres3, metas.presentismo, 0)}</tr>`;
    }).join("")}</table>
    <p class="nota">Componentes: rojo bajo 70%, ámbar bajo 90%. "–" = no aplica o sin carga.</p>`;
}

/** Salas con horas de presentismo faltantes en la semana y sus días críticos. */
function tablaHoras(horas, limite = 10) {
  const con = horas.filter((h) => h.falta >= 0.5).sort((a, b) => b.falta - a.falta);
  if (!con.length) return `<p class="vacio">Todas las salas con objetivo de horas lo cumplieron esta semana.</p>`;
  const total = con.reduce((a, h) => a + h.falta, 0);
  return `<p class="linea">Faltan <b>${nf(total, 0)} h</b> en ${con.length} sala${con.length === 1 ? "" : "s"}, el equivalente a <b>${nf(total / 42, 1)}</b> jornadas completas de 42 h.</p>
    <table><tr><th class="l">Sala</th><th>Objetivo</th><th>Cumplidas</th><th>Faltan</th><th class="l">Días bajo 75% (cumplidas/objetivo)</th></tr>
    ${con.slice(0, limite).map((h) => `<tr><td class="l b">${esc(h.nombre)}</td><td>${nf(h.obj, 0)} h</td><td>${nf(h.real, 0)} h</td>
      <td class="bad">${nf(h.falta, 0)} h</td><td class="l">${esc(h.criticos.join(" · ") || "Déficit repartido en la semana")}</td></tr>`).join("")}
    </table>${con.length > limite ? `<p class="nota">Y ${con.length - limite} salas más con déficit menor.</p>` : ""}`;
}

/** Venta perdida agrupada por la acción que la recupera. */
function tablaAcciones(cadem) {
  if (!cadem.total) return `<p class="vacio">Sin datos de causas de quiebre esta semana.</p>`;
  const porAccion = new Map();
  for (const r of cadem.filas) {
    const g = porAccion.get(r.accion) ?? { accion: r.accion, vp: 0, skus: 0, salas: new Set() };
    g.vp += r.vp; g.skus++; g.salas.add(r.salaId); porAccion.set(r.accion, g);
  }
  return `<table><tr><th class="l">Acción</th><th class="r">Venta perdida</th><th>%</th><th>SKU × sala</th><th>Salas</th></tr>
    ${[...porAccion.values()].sort((a, b) => b.vp - a.vp).map((g) => `<tr><td class="l b">${esc(g.accion)}</td><td class="r">${clp(g.vp)}</td>
      <td>${Math.round((g.vp / cadem.total) * 100)}%</td><td>${g.skus}</td><td>${g.salas.size}</td></tr>`).join("")}
    <tr class="tot"><td class="l">Total recuperable</td><td class="r">${clp(cadem.total)}</td><td>100%</td><td>${cadem.filas.length}</td><td>${cadem.salas.length}</td></tr></table>`;
}

function seccionVisitas(visitas, fecha) {
  const titulo = `Visitas del día anterior · ${diaLargo(fecha)}`;
  if (!visitas.length) return `<h2>${titulo}</h2><p class="vacio">No se registraron visitas en la app ese día.</p>`;
  const salas = new Set(visitas.map((v) => v.sala)).size;
  const porQuien = [...visitas.reduce((m, v) => m.set(v.quien, (m.get(v.quien) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]).map(([q, n]) => `${esc(titulo_(q))} ${n}`);
  const criticas = visitas.filter((v) => v.nivel === "CRÍTICO" || v.nivel === "REGULAR").length;
  return `<h2>${titulo}</h2>
    <div class="caja" style="margin-bottom:8px"><b>${visitas.length} visita${visitas.length === 1 ? "" : "s"}</b> en ${salas} sala${salas === 1 ? "" : "s"}${criticas ? ` · ${criticas} con nivel regular o crítico` : ""}. Por persona: ${porQuien.join(", ")}.</div>
    <table>
      <tr><th class="l">Sala</th><th class="l">Visitó</th><th>Tipo</th><th>Duración</th><th>Nivel</th><th class="l">Foco urgente (IA)</th></tr>
      ${visitas.map((v) => `<tr><td class="l b">${esc(v.salaNombre)}</td><td class="l" style="white-space:nowrap">${esc(titulo_(v.quien))}</td><td>${esc(titulo_(v.tipo))}</td>
        <td style="white-space:nowrap">${duracion(v.minutos)}</td>
        <td>${v.nivel ? `<span class="pill ${esc(v.nivel)}">${esc(titulo_(v.nivel))}</span>` : "–"}</td>
        <td class="l">${esc(v.foco_urgente ?? "")}</td></tr>`).join("")}
    </table>`;
}
const titulo_ = titulo;
/** Duración de la encuesta: "13 min", "1 h 08 min". */
function duracion(min) {
  if (min == null) return "–";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

function paginaCadem(sup, cadem, sem, focoIds) {
  return `<section class="pag">
    <div class="cab"><div><h1>${esc(sup.nombre)}</h1><div class="s">Venta perdida Cadem (Datawalt) · Semana ${sem} · qué hacer en cada sala</div></div>
      <div class="d">${clp(cadem.total)} en ${cadem.salas.length} salas con datos<br>★ = sala foco</div></div>
    <h2>Qué recupera la venta perdida</h2>
    ${tablaAcciones(cadem)}
    <h2>Detalle por sala: los 3 SKU que más pierden</h2>
    <table>
      <tr><th class="l">Sala</th><th class="l">SKU</th><th class="l">Acción</th><th>Días sin venta</th><th class="r">Venta perdida</th></tr>
      ${cadem.salas.map((s) => s.top.map((r, i) => `<tr>
        ${i === 0 ? `<td class="l sala b" rowspan="${s.top.length}">${focoIds.has(s.salaId) ? "★ " : ""}${esc(s.nombre)}<br><span class="x">${clp(s.total)} · ${s.n} SKU con quiebre</span></td>` : ""}
        <td class="l b">${esc(r.sku)}</td><td class="l">${esc(r.accion)}</td><td class="${(r.dias ?? 0) >= 7 ? "bad" : ""}">${r.dias ?? "–"}</td><td class="r">${clp(r.vp)}</td></tr>`).join("")).join("")}
    </table>
    <p class="nota">Acción según la causa que informa Datawalt: góndola sin reposición = reponer (hay stock en la sala); sin stock = pedido o abastecimiento; stock estático o negativo = ajuste de inventario. En rojo, 7 o más días sin venta. Solo aparecen las salas que el reporte de la semana ${sem} trae con quiebre.</p>
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
/** Visitas sin foco urgente: se pide el análisis a analizar-visita una sola
 * vez por visita (la función lo guarda en encuesta_visitas, así que también
 * queda para la app y el portal). Si falla, la visita sale sin foco. */
async function completarFocoIA(sb, visitas) {
  const faltan = visitas.filter((v) => !v.foco_urgente);
  if (!faltan.length) return;
  let ok = 0;
  await Promise.all(faltan.map(async (v) => {
    try {
      const { data, error } = await sb.functions.invoke("analizar-visita", {
        body: { visita_id: v.id },
        headers: { "x-clave-servidor": process.env.SUPABASE_SERVICE_ROLE_KEY },
      });
      if (error) throw error;
      const a = data?.analisis;
      if (a?.foco_urgente) { v.foco_urgente = a.foco_urgente; v.nivel = a.nivel_cumplimiento ?? v.nivel; ok++; }
    } catch (e) {
      console.warn(`Sin foco IA para la visita ${v.id}: ${e.message ?? e}`);
    }
  }));
  console.log(`Foco IA: ${ok} de ${faltan.length} visitas sin análisis se completaron.`);
}

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
  // Componentes RED de la semana (la nota y lo que la compone), por categoría.
  const traerComponentes = async (tabla, cat) => {
    const w = semanas[2];
    const cols = ["sala_id", "red_pct", ...COMPONENTES[cat].map(([c]) => c)].join(", ");
    const { data, error } = await sb.from(tabla).select(cols).eq("anio", w.anio).eq("semana", w.semana);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    return new Map(data.map((r) => [r.sala_id, r]));
  };
  const [s0, s1, s2, causas, visitas, metasRes, zonasRes, compNartd, compAbi, compVsr, presDias] = await Promise.all([
    ...semanas.map((w) => rpc("informe_salas_semana", { p_anio: w.anio, p_semana: w.semana })),
    traerCausas(),
    incluirVisitas ? rpc("informe_visitas_dia", { p_fecha: isoFecha(ayer) }) : [],
    sb.from("metas_indicadores").select("clave, valor"),
    sb.from("zonas").select("id, nombre"),
    traerComponentes("red_nartd", "nartd"),
    traerComponentes("red_abi", "abi"),
    traerComponentes("red_vsr", "vsr"),
    rpc("informe_presentismo_dias", { p_anio: semanas[2].anio, p_semana: semanas[2].semana }),
  ]);
  if (metasRes.error) throw new Error(`metas_indicadores: ${metasRes.error.message}`);
  await completarFocoIA(sb, visitas);
  if (zonasRes.error) throw new Error(`zonas: ${zonasRes.error.message}`);
  const diasPorSala = new Map();
  for (const d of presDias) {
    if (!diasPorSala.has(d.sala_id)) diasPorSala.set(d.sala_id, []);
    diasPorSala.get(d.sala_id).push({ fecha: d.fecha, objetivo: Number(d.objetivo), real: Number(d.real_topado) });
  }
  return {
    comp: { nartd: compNartd, abi: compAbi, vsr: compVsr }, diasPorSala,
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
    sku: titulo(r.sku_nombre), causa: r.causa, causaLabel: causaLabel(r.causa), accion: accionDe(r.causa),
    dias: r.dias_sin_venta, vp: Number(r.venta_perdida),
  }));

  // Brecha a meta de cada categoría para un grupo de salas.
  const brechas = (salas) => Object.fromEntries(RED.map((c) => [c.key, brecha(salas, datos.comp[c.key], c.key, metas[c.meta])]));

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
      brechas: brechas(g.salas),
      horas: horasFaltantes(g.salas, datos.diasPorSala),
    };
  }).sort((a, b) => (a.id === "sin") - (b.id === "sin") || a.nombre.localeCompare(b.nombre, "es"));

  // Cuánto subiría el promedio de la zona si todas las salas de cada
  // supervisor llegaran a la meta: dónde está la brecha de la zona.
  const nZona = Object.fromEntries(RED.map((c) => [c.key, salasZona.filter((s) => datos.comp[c.key].get(s.sala_id)?.red_pct != null).length]));
  for (const sup of supervisores) {
    sup.aporte = Object.fromEntries(RED.map((c) => {
      const meta = metas[c.meta];
      const suma = sup.salas.reduce((a, s) => {
        const r = datos.comp[c.key].get(s.sala_id)?.red_pct;
        return a + (r == null ? 0 : Math.max(0, meta - Number(r)));
      }, 0);
      return [c.key, nZona[c.key] ? suma / nZona[c.key] : null];
    }));
  }

  const visitas = datos.visitas.filter((v) => v.zona_id === zonaId).map((v) => ({ ...v, salaNombre: nombreSala(v.sala) }));
  return {
    zona: titulo(zona?.nombre ?? ""), sem, metas, salasZona, foco, supervisores, visitas,
    ind: indicadores(ids, filasSem), cadem: resumirCadem(causas),
    brechas: brechas(salasZona), horas: horasFaltantes(salasZona, datos.diasPorSala),
    comp: datos.comp,
  };
}

export function htmlZona(datos, z) {
  const { metas, sem } = z;
  const emitido = ddmm(datos.emitido) + "-" + datos.emitido.getUTCFullYear();
  const rangoW = `${diaMes(datos.lunes)}–${diaMes(masDias(datos.lunes, 6))}`;
  const rango3 = `${diaMes(masDias(datos.lunes, -14))}–${diaMes(masDias(datos.lunes, 6))}`;
  const horasTot = (h) => h.reduce((a, x) => a + Math.max(0, x.falta), 0);

  // Dónde está la brecha de la zona: cuánto subiría el promedio si las salas
  // de cada supervisor llegaran a la meta, más sus horas y venta perdida.
  const filaSup = (s) => `<tr><td class="l b">${esc(s.nombre)}</td><td>${esc(s.subzona ?? "–")}</td><td>${s.salas.length}</td>
    ${RED.map((c) => {
      const v = s.ind[2][c.key], a = s.aporte[c.key];
      return `<td class="${v == null ? "na" : v >= metas[c.meta] ? "ok" : "bad"}">${pct(v)}${a > 0.0005 ? `<span class="x"> · ${pts(a)} pts</span>` : ""}</td>`;
    }).join("")}
    <td>${horasTot(s.horas) >= 0.5 ? `${nf(horasTot(s.horas), 0)} h` : "–"}</td>
    <td class="r">${s.cadem.total ? clp(s.cadem.total) : "–"}</td><td class="b">${s.foco.length}</td></tr>`;

  const paginaZona = `<section class="pag">
    <div class="cab"><div><h1>${esc(z.zona)} · Salas foco por supervisor</h1><div class="s">Informe de gestión semanal</div></div>
      <div class="d">Emitido ${emitido}<br>RED y venta perdida Cadem: S${sem[2]} (${rangoW})<br>Presentismo: S${sem[0]}–S${sem[2]} (${rango3})</div></div>
    <h2>Total ${esc(z.zona)}</h2>
    ${tarjetas(z.ind, metas, sem, z.cadem)}
    <h2>Brecha a la meta · S${sem[2]}</h2>
    ${tablaBrecha(z.brechas, metas)}
    <h2>Dónde está la brecha, por supervisor</h2>
    <table><tr><th class="l">Supervisor</th><th>Subzona</th><th>Salas</th><th>NARTD</th><th>ABI</th><th>VSR</th><th>Horas faltantes</th><th class="r">Vta. perdida</th><th>Salas foco</th></tr>
      ${z.supervisores.map(filaSup).join("")}</table>
    <p class="nota">Junto a cada nota: cuántos puntos sube el promedio de ${esc(z.zona)} si todas las salas de ese supervisor llegan a la meta.</p>
    <h2>Venta perdida Cadem · qué la recupera</h2>
    ${tablaAcciones(z.cadem)}
    <p class="nota">Metas: RED NARTD ${pct(metas.red_nartd, 0)}, ABI ${pct(metas.red_abi, 0)}, VSR ${pct(metas.red_vsr, 0)}; presentismo ${pct(metas.presentismo, 0)}. <b>Puntos por componente:</b> lo que le falta a cada sala para 100% se reparte entre sus componentes según el peso de cada uno (NARTD: NSS 20, SOVI 35, ICE 20, exhibición 12, NSF 5, catálogos 5, POP 3; ABI: 25 cada uno; VSR: NSS y catálogos 50) y se promedia en el grupo. <b>Acciones:</b> llevar un componente de una sala a 100%, ordenadas por cuánto suben el promedio. <b>Sala foco:</b> RED y presentismo fuera de meta a la vez, alguna categoría RED bajo 75% o presentismo de 3 semanas bajo 80%. Presentismo: WM sin Acuenta, SMU sin S10/Super 10, horas topadas al objetivo diario.</p>
  </section>`;

  const paginaVisitas = datos.incluirVisitas ? `<section class="pag">
    <div class="cab"><div><h1>${esc(z.zona)} · Visitas</h1><div class="s">Visitas registradas en la app con su análisis de IA</div></div>
      <div class="d">${diaLargo(datos.ayer)}</div></div>
    ${seccionVisitas(z.visitas, datos.ayer)}
  </section>` : "";

  const paginasSup = z.supervisores.filter((s) => s.id !== "sin").map((s) => {
    const focoIds = new Set(s.foco.map((f) => f.sala_id));
    const fuera = RED.filter((c) => s.brechas[c.key] && s.brechas[c.key].falta > 0);
    const enMeta = RED.filter((c) => s.brechas[c.key] && s.brechas[c.key].falta <= 0);
    return `<section class="pag">
      <div class="cab"><div><h1>${esc(s.nombre)}</h1><div class="s">Supervisor · Subzona ${esc(s.subzona ?? "–")} · ${s.salas.length} salas activas</div></div>
        <div class="d">${s.foco.length} salas foco<br>Semana ${sem[2]} · emitido ${emitido}</div></div>
      <h2>Indicadores</h2>
      ${tarjetas(s.ind, metas, sem, s.cadem)}
      <h2>Brecha a la meta</h2>
      ${tablaBrecha(s.brechas, metas)}
      <h2>Camino a la meta</h2>
      ${fuera.map((c) => caminoMeta(s.brechas[c.key], c.label)).join("")}
      ${enMeta.length ? `<p class="linea">${enMeta.map((c) => `<b>${c.label}</b> ${pct(s.brechas[c.key].promedio)}`).join(" · ")}: en meta.</p>` : ""}
    </section>
    <section class="pag">
      <div class="cab"><div><h1>${esc(s.nombre)}</h1><div class="s">Salas foco y presentismo · Semana ${sem[2]}</div></div>
        <div class="d">${s.foco.length} de ${s.salas.length} salas foco</div></div>
      <h2>Salas foco: dónde pierde puntos cada una</h2>
      ${matrizFoco(s.foco, z, metas)}
      <h2>Presentismo: horas que faltan · S${sem[2]}</h2>
      ${tablaHoras(s.horas)}
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
