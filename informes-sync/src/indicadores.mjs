// Informe general de indicadores de la última semana ISO cerrada: total, por
// zona y por supervisor, contra la semana anterior. Los datos por sala vienen
// de la función informe_indicadores_semana (mismas reglas que el portal); acá
// sólo se agregan y se arma el PDF.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const TZ = "America/Santiago";

// Referencia de venta perdida: no hay meta cargada en metas_indicadores, se
// usa el mismo 2% que en los informes de salas foco.
const VP_REFERENCIA = 0.02;

const INDICADORES = [
  { key: "nartd", label: "RED NARTD", meta: "red_nartd" },
  { key: "abi", label: "RED ABI", meta: "red_abi" },
  { key: "vsr", label: "RED VSR", meta: "red_vsr" },
  { key: "pres", label: "Presentismo WM", meta: "presentismo" },
  { key: "tc", label: "Teamcore", meta: "teamcore" },
  { key: "vp", label: "Venta perdida", inverso: true },
];

// ---------- fechas ----------

function hoySantiago() {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function isoWeek(date) {
  const d = new Date(date);
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia);
  const inicio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { anio: d.getUTCFullYear(), semana: Math.ceil(((d - inicio) / 86400000 + 1) / 7) };
}
function lunesDe(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
  return d;
}
const masDias = (d, n) => new Date(d.getTime() + n * 86400000);
const fechaCorta = (d) => d.toLocaleDateString("es-CL", { timeZone: "UTC", day: "numeric", month: "short" });

// ---------- agregación ----------

function promedio(vals) {
  const v = vals.filter((x) => x != null).map(Number);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function sumar(filas, col) { return filas.reduce((a, r) => a + Number(r[col] ?? 0), 0); }

function agregar(filas) {
  const pres = filas.filter((r) => r.pres_objetivo != null);
  const tc = filas.filter((r) => r.tc_dias != null);
  // Semanas con venta perdida mayor a la venta del día son cargas anómalas:
  // el portal las saca del KPI, acá también.
  const vp = filas.filter((r) => Number(r.vp_venta) > 0 && Number(r.vp_perdida) / Number(r.vp_venta) <= 1);
  const presObj = sumar(pres, "pres_objetivo"), tcDias = sumar(tc, "tc_dias"), vpVenta = sumar(vp, "vp_venta");
  return {
    salas: filas.length,
    nartd: promedio(filas.map((r) => r.red_nartd)),
    abi: promedio(filas.map((r) => r.red_abi)),
    vsr: promedio(filas.map((r) => r.red_vsr)),
    pres: presObj > 0 ? sumar(pres, "pres_real_topado") / presObj : null,
    tc: tcDias > 0 ? 1 - sumar(tc, "tc_incumplidos") / tcDias : null,
    vp: vpVenta > 0 ? sumar(vp, "vp_perdida") / vpVenta : null,
    vpClp: vp.length ? sumar(vp, "vp_perdida") : null,
  };
}

function agruparPor(filas, claveFn) {
  const m = new Map();
  for (const r of filas) {
    const k = claveFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// ---------- HTML ----------

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (v, dec = 1) => (v == null ? "–" : `${(v * 100).toLocaleString("es-CL", { minimumFractionDigits: dec, maximumFractionDigits: dec })}%`);
const clp = (v) => (v == null ? "–" : `$${Math.round(v).toLocaleString("es-CL")}`);

function estado(ind, v, metas) {
  if (v == null) return "na";
  if (ind.inverso) return v > VP_REFERENCIA ? "bad" : "ok";
  const meta = metas[ind.meta];
  return meta == null ? "" : v < meta ? "bad" : "ok";
}
function delta(ind, v, prev) {
  if (v == null || prev == null) return "";
  const d = (v - prev) * 100;
  if (Math.abs(d) < (ind.inverso ? 0.005 : 0.05)) return `<span class="d">=</span>`;
  const mejora = ind.inverso ? d < 0 : d > 0;
  const txt = `${d > 0 ? "+" : "−"}${Math.abs(d).toLocaleString("es-CL", { minimumFractionDigits: ind.inverso ? 2 : 1, maximumFractionDigits: ind.inverso ? 2 : 1 })} pts`;
  return `<span class="d ${mejora ? "up" : "down"}">${txt}</span>`;
}
function celdas(a, p, metas) {
  return INDICADORES.map((ind) => {
    const v = a[ind.key];
    return `<td class="${estado(ind, v, metas)}">${pct(v, ind.inverso ? 2 : 1)}${delta(ind, v, p?.[ind.key])}</td>`;
  }).join("");
}
const encabezado = `<tr><th class="l">&nbsp;</th><th>Salas</th>${INDICADORES.map((i) => `<th>${i.label}</th>`).join("")}</tr>`;

function html({ semana, anio, lunes, metas, total, totalPrev, zonas, supervisores }) {
  const domingo = masDias(lunes, 6);
  const emitido = new Date().toLocaleString("es-CL", { timeZone: TZ, dateStyle: "long", timeStyle: "short" });

  const tarjetas = INDICADORES.map((ind) => {
    const v = total[ind.key];
    const meta = ind.inverso ? `Referencia ≤ ${pct(VP_REFERENCIA, 0)}` : metas[ind.meta] != null ? `Meta ${pct(metas[ind.meta], 0)}` : "Sin meta";
    return `<div class="kpi ${estado(ind, v, metas)}">
      <div class="kl">${ind.label}</div>
      <div class="kv">${pct(v, ind.inverso ? 2 : 1)}</div>
      <div class="km">${meta} ${delta(ind, v, totalPrev[ind.key])}</div>
    </div>`;
  }).join("");

  const filasZona = zonas.map(({ nombre, a, p }) =>
    `<tr><td class="l n">${esc(nombre)}</td><td>${a.salas}</td>${celdas(a, p, metas)}</tr>`).join("");

  const bloquesSup = supervisores.map(({ zona, filas }) => `
    <tr class="grupo"><td colspan="${INDICADORES.length + 2}">${esc(zona)}</td></tr>
    ${filas.map(({ nombre, a, p }) => `<tr><td class="l">${esc(nombre)}</td><td>${a.salas}</td>${celdas(a, p, metas)}</tr>`).join("")}`).join("");

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Indicadores semana ${semana}</title>
<style>
  @page { size: A4 landscape; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10.5px/1.4 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 13px; margin: 18px 0 6px; }
  .sub { color: #6b7280; margin: 2px 0 14px; }
  .kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
  .kpi { border: 1px solid #e5e7eb; border-left: 4px solid #9ca3af; border-radius: 6px; padding: 8px 10px; }
  .kpi.ok { border-left-color: #16a34a; } .kpi.bad { border-left-color: #dc2626; }
  .kl { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  .kv { font-size: 22px; font-weight: 650; margin: 2px 0; font-variant-numeric: tabular-nums; }
  .km { color: #6b7280; font-size: 9.5px; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th { font-size: 9.5px; color: #6b7280; font-weight: 600; text-align: right; padding: 4px 8px; border-bottom: 1.5px solid #d1d5db; }
  td { text-align: right; padding: 4px 8px; border-bottom: 1px solid #f0f1f3; white-space: nowrap; }
  .l { text-align: left; } td.n { font-weight: 600; }
  td.bad { color: #b91c1c; background: #fef2f2; font-weight: 600; } td.na { color: #9ca3af; }
  tr.total td { font-weight: 700; border-top: 1.5px solid #d1d5db; }
  tr.grupo td { text-align: left; font-weight: 700; background: #f9fafb; padding-top: 6px; }
  tr { break-inside: avoid; }
  .d { display: block; font-size: 8.5px; font-weight: 400; color: #9ca3af; }
  .d.up { color: #15803d; } .d.down { color: #b91c1c; }
  .notas { color: #6b7280; font-size: 9px; margin-top: 16px; }
  .notas li { margin: 1px 0; }
  .salto { break-before: page; }
</style></head><body>
  <h1>Indicadores generales · Semana ${semana}</h1>
  <p class="sub">${fechaCorta(lunes)} – ${fechaCorta(domingo)} ${anio} · ${total.salas} salas activas · Emitido el ${emitido} · Variación contra la semana ${semana - 1}</p>
  <div class="kpis">${tarjetas}</div>

  <h2>Por zona</h2>
  <table>${encabezado}${filasZona}
    <tr class="total"><td class="l">Total</td><td>${total.salas}</td>${celdas(total, totalPrev, metas)}</tr>
  </table>
  ${total.vpClp != null ? `<p class="sub" style="margin-top:6px">Venta perdida operacional de la semana: ${clp(total.vpClp)}</p>` : ""}

  <h2 class="salto">Por supervisor</h2>
  <table>${encabezado}${bloquesSup}</table>

  <ul class="notas">
    <li>Rojo = fuera de meta. Metas desde Configuraciones del portal: ${INDICADORES.filter((i) => !i.inverso).map((i) => `${i.label} ${pct(metas[i.meta], 0)}`).join(", ")}. Venta perdida: referencia ${pct(VP_REFERENCIA, 0)} (no hay meta cargada).</li>
    <li>RED: promedio simple de las salas con dato en la semana. Presentismo: sólo Walmart sin ACUENTA, horas reales topadas al objetivo de cada día. Teamcore: lunes a sábado, salas que usan Teamcore. Los días eximidos en Excepciones no cuentan.</li>
    <li>Venta perdida: suma de pérdida operacional sobre suma de venta; se excluyen cargas anómalas (pérdida mayor a la venta), igual que en el portal.</li>
  </ul>
</body></html>`;
}

// ---------- generación ----------

export async function generarInformeIndicadores() {
  const url = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Última semana cerrada = la anterior a la que contiene hoy.
  const lunes = masDias(lunesDe(hoySantiago()), -7);
  const { anio, semana } = isoWeek(lunes);
  const prev = isoWeek(masDias(lunes, -7));

  const traer = async (a, s) => {
    const { data, error } = await sb.rpc("informe_indicadores_semana", { p_anio: a, p_semana: s });
    if (error) throw new Error(`informe_indicadores_semana(${a}, ${s}): ${error.message}`);
    return data;
  };
  const [filas, filasPrev, metasRes] = await Promise.all([
    traer(anio, semana), traer(prev.anio, prev.semana), sb.from("metas_indicadores").select("clave, valor"),
  ]);
  if (metasRes.error) throw new Error(`metas_indicadores: ${metasRes.error.message}`);
  const metas = Object.fromEntries(metasRes.data.map((m) => [m.clave, Number(m.valor)]));

  const prevPorZona = agruparPor(filasPrev, (r) => r.zona ?? "Sin zona");
  const prevPorSup = agruparPor(filasPrev, (r) => `${r.zona}|${r.supervisor}`);
  const porZona = agruparPor(filas, (r) => r.zona ?? "Sin zona");
  const nombresZona = [...porZona.keys()].sort((a, b) => a.localeCompare(b, "es"));

  const zonas = nombresZona.map((z) => ({ nombre: z, a: agregar(porZona.get(z)), p: prevPorZona.has(z) ? agregar(prevPorZona.get(z)) : null }));
  const supervisores = nombresZona.map((z) => {
    const porSup = agruparPor(porZona.get(z), (r) => r.supervisor ?? "Sin supervisor");
    return {
      zona: z,
      filas: [...porSup.keys()].sort((a, b) => a.localeCompare(b, "es")).map((sup) => {
        const p = prevPorSup.get(`${z}|${sup === "Sin supervisor" ? null : sup}`);
        return { nombre: sup, a: agregar(porSup.get(sup)), p: p ? agregar(p) : null };
      }).filter(({ a }) => INDICADORES.some((i) => a[i.key] != null)),
    };
  });

  const total = agregar(filas);
  const doc = html({ semana, anio, lunes, metas, total, totalPrev: agregar(filasPrev), zonas, supervisores });

  // PW_CHANNEL=msedge permite generarlo en una PC con Windows sin bajar Chromium.
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  try {
    const page = await browser.newPage();
    await page.setContent(doc, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", landscape: true, printBackground: true, preferCSSPageSize: true });
    return { pdf, html: doc, semana, anio, lunes, total, metas };
  } finally {
    await browser.close();
  }
}

export { INDICADORES, VP_REFERENCIA, pct, estado, fechaCorta, masDias };
