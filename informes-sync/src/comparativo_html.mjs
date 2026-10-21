// Informe de una zona con hojas de comparación contra las demás zonas.
// Las primeras 3 páginas son el informe ejecutivo de la zona (ejecutivo_html.mjs);
// luego una hoja con las 2 salas de peor resultado arrastrado en RED NARTD y
// 3 hojas de comparación:
//   Indicadores  RED y presentismo de todas las zonas, lugar de la zona y su evolución.
//   Componentes  nota promedio de cada componente RED por zona.
//   Venta perdida NARTD  monto, monto por sala y causas, por zona.
// "Otras zonas" es el promedio simple de los valores de las demás zonas (cada
// zona pesa igual, sin importar cuántas salas tenga).
import { pct, clp, esc, nf, pts, perdidasSala, diaMes, masDias, CSS, RED, PRES, CORTO } from "./salas_foco.mjs";
import { pp, fechaCorta } from "./gestion.mjs";
import { paginasEjecutivo, CSS_EJEC } from "./ejecutivo_html.mjs";

const CSS_COMP = `
  .zc { background: #fef2f2; font-weight: 700; }
  th.zc { background: #fee2e2; color: #991b1b; }
  table.cmp td, table.cmp th { padding: 4px 7px; font-size: 9.8px; }
  .dos-g { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; }
  .dos-g h3 { margin: 6px 0 2px; font-size: 10px; color: #4b5563; }
  table.mini td, table.mini th { padding: 2px 6px; font-size: 9px; }
`;

const cab = (t, s, d) => `<div class="cab"><div><h1>${t}</h1><div class="s">${s}</div></div><div class="d">${d}</div></div>`;
const prom = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const cls = (v, meta) => (v == null ? "na" : v >= meta ? "ok" : "bad");

/** zonas: [zona de enfoque, ...otras], todas armadas con armarZona. */
function hojaIndicadores(datos, zonas) {
  const [foco, ...otras] = zonas;
  const sm = foco.sem;
  const metaDe = (k) => (RED.find((c) => c.key === k) ? foco.metas[RED.find((c) => c.key === k).meta] : foco.metas.presentismo);
  const inds = [
    ...RED.map((c) => ({ k: c.key, label: `RED ${c.label}` })),
    ...PRES.map((p) => ({ k: p.key, label: p.label })),
  ];
  const filas = inds.map(({ k, label }) => {
    const meta = metaDe(k);
    const vals = zonas.map((z) => z.ind[2][k]);
    const pOtras = prom(otras.map((z) => z.ind[2][k]));
    const v = foco.ind[2][k];
    const lugar = v == null ? "–" : 1 + vals.filter((x, i) => i > 0 && x != null && x > v).length;
    const n = vals.filter((x) => x != null).length;
    return `<tr><td class="l b">${label}</td><td>${pct(meta, 0)}</td>
      ${zonas.map((z, i) => `<td class="${i === 0 ? "zc " : ""}${cls(vals[i], meta)}">${pct(vals[i])}</td>`).join("")}
      <td>${pct(pOtras)}</td><td class="${v != null && pOtras != null && v < pOtras ? "bad" : "ok"}">${v != null && pOtras != null ? pp(v - pOtras) : "–"}</td><td class="b">${lugar === "–" ? "–" : `${lugar} de ${n}`}</td></tr>`;
  }).join("");

  const serie = (k) => `<table class="mini"><tr><th class="l">${inds.find((i) => i.k === k).label}</th>${sm.map((w) => `<th>S${w}</th>`).join("")}</tr>
    ${zonas.map((z, i) => `<tr class="${i === 0 ? "zc" : ""}"><td class="l">${esc(z.zona)}</td>${z.ind.map((x) => `<td class="${cls(x[k], metaDe(k))}">${pct(x[k])}</td>`).join("")}</tr>`).join("")}</table>`;

  return `<section class="pag">
    ${cab(`${esc(foco.zona)} vs otras zonas · Indicadores`, "Resultado de la semana de todas las zonas y su evolución", `Semana ${sm[2]}`)}
    <h2>Resultado de la semana</h2>
    <table class="cmp"><tr><th class="l">Indicador</th><th>Meta</th>${zonas.map((z, i) => `<th class="${i === 0 ? "zc" : ""}">${esc(z.zona)}</th>`).join("")}<th>Otras zonas</th><th>${esc(foco.zona)} vs otras</th><th>Lugar</th></tr>${filas}</table>
    <p class="nota">Verde: en meta · rojo: con oportunidad. «Otras zonas» es el promedio simple de las demás zonas. «Lugar» ordena las zonas de mayor a menor resultado.</p>
    <h2>Evolución, últimas 3 semanas</h2>
    <div class="dos-g">${inds.map((i) => `<div>${serie(i.k)}</div>`).join("")}</div>
  </section>`;
}

function hojaComponentes(datos, zonas) {
  const [foco, ...otras] = zonas;
  const tabla = (c) => {
    const bz = zonas.map((z) => z.brechas[c.key]);
    if (!bz[0]) return "";
    const labels = [...new Set(bz.flatMap((b) => (b ? b.componentes.map((k) => k.label) : [])))];
    const nota = (b, l) => b?.componentes.find((k) => k.label === l)?.nota ?? null;
    const filas = labels.map((l) => ({ l, vals: bz.map((b) => nota(b, l)), pierde: bz[0].componentes.find((k) => k.label === l)?.pierde ?? 0 }))
      .sort((a, b) => b.pierde - a.pierde);
    return `<h2>RED ${c.label}</h2><table class="cmp"><tr><th class="l">Componente</th>${zonas.map((z, i) => `<th class="${i === 0 ? "zc" : ""}">${esc(z.zona)}</th>`).join("")}<th>Otras zonas</th><th>${esc(foco.zona)} vs otras</th><th>Suma a ${esc(foco.zona)}</th></tr>
      <tr class="tot"><td class="l b">Nota RED</td>${bz.map((b, i) => `<td class="${i === 0 ? "zc " : ""}${cls(b?.promedio ?? null, foco.metas[c.meta])}">${pct(b?.promedio ?? null)}</td>`).join("")}<td>${pct(prom(bz.slice(1).map((b) => b?.promedio ?? null)))}</td><td>${bz[0].promedio != null ? pp(bz[0].promedio - prom(bz.slice(1).map((b) => b?.promedio ?? null))) : "–"}</td><td>meta ${pct(foco.metas[c.meta], 0)}</td></tr>
      ${filas.map((f) => {
        const po = prom(f.vals.slice(1));
        const d = f.vals[0] != null && po != null ? f.vals[0] - po : null;
        return `<tr><td class="l">${esc(CORTO[f.l] ?? f.l)}</td>${f.vals.map((v, i) => `<td class="${i === 0 ? "zc" : ""}">${pct(v, 0)}</td>`).join("")}<td>${pct(po, 0)}</td>
          <td class="${d != null && d <= -0.05 ? "bad" : ""}">${d == null ? "–" : pp(d, 0)}</td><td>${f.pierde > 0.0005 ? `+${pts(f.pierde)} pts` : "–"}</td></tr>`;
      }).join("")}</table>`;
  };
  return `<section class="pag">
    ${cab(`${esc(foco.zona)} vs otras zonas · Componentes RED`, "Nota promedio de cada componente por zona", `Semana ${foco.sem[2]}`)}
    ${RED.map(tabla).join("")}
    <p class="nota">Nota de cada componente promediada entre las salas medidas de la zona. En rojo, ${esc(foco.zona)} 5 pp o más bajo el promedio de las otras zonas. «Suma a ${esc(foco.zona)}» son los puntos de RED que sube la zona si ese componente llega a 100%.</p>
  </section>`;
}

function hojaVentaPerdida(datos, zonas) {
  const [foco, ...otras] = zonas;
  const causas = [...new Set(zonas.flatMap((z) => z.cadem.causas.map((c) => c.label)))];
  const dato = (z) => {
    const nSala = z.salasZona.length;
    const sinStock = z.vpFilas.filter((r) => r.causa === "SIN STOCK" && (r.dias ?? 0) >= 7);
    return { z, total: z.cadem.total, conQuiebre: z.cadem.salas.length, nSala, porSala: nSala ? z.cadem.total / nSala : null,
      porSalaQ: z.cadem.salas.length ? z.cadem.total / z.cadem.salas.length : null, skuSinStock: sinStock.length };
  };
  const d = zonas.map(dato);
  const fila = (label, f, fmt) => `<tr><td class="l b">${label}</td>${d.map((x, i) => `<td class="${i === 0 ? "zc" : ""}">${fmt(x)}</td>`).join("")}</tr>`;
  const pOtras = prom(d.slice(1).map((x) => x.porSala));
  const mix = (z, c) => z.cadem.causas.find((k) => k.label === c)?.pct ?? 0;
  return `<section class="pag">
    ${cab(`${esc(foco.zona)} vs otras zonas · Venta perdida NARTD`, "Monto, monto por sala y causas, por zona", `Semana ${foco.sem[2]}`)}
    <h2>Monto reportado</h2>
    <table class="cmp"><tr><th class="l"></th>${zonas.map((z, i) => `<th class="${i === 0 ? "zc" : ""}">${esc(z.zona)}</th>`).join("")}</tr>
      ${fila("Venta perdida total", null, (x) => clp(x.total))}
      ${fila("Por sala de la zona", null, (x) => clp(x.porSala))}
      ${fila("Por sala con quiebre medido", null, (x) => clp(x.porSalaQ))}
      ${fila("SKU con 7 días o más sin stock", null, (x) => nf(x.skuSinStock, 0))}</table>
    <p class="nota">${esc(foco.zona)} por sala de la zona: ${clp(d[0].porSala)}; promedio de las otras zonas: ${clp(pOtras)}${d[0].porSala != null && pOtras ? ` (${d[0].porSala > pOtras ? "+" : "−"}${nf(Math.abs(d[0].porSala / pOtras - 1) * 100, 0)}%)` : ""}.
      El monto total depende del tamaño de la zona; por eso se compara también por sala. El monto es venta perdida reportada por Datawalt, lo máximo recuperable, no una meta.</p>
    <h2>De qué viene la venta perdida (% del monto)</h2>
    <table class="cmp"><tr><th class="l">Causa registrada</th>${zonas.map((z, i) => `<th class="${i === 0 ? "zc" : ""}">${esc(z.zona)}</th>`).join("")}<th>Otras zonas</th></tr>
      ${causas.map((c) => `<tr><td class="l">${esc(c)}</td>${zonas.map((z, i) => `<td class="${i === 0 ? "zc" : ""}">${pct(mix(z, c), 0)}</td>`).join("")}<td>${pct(prom(otras.map((z) => mix(z, c))), 0)}</td></tr>`).join("")}</table>
    <h2>Salas de ${esc(foco.zona)} con más venta perdida</h2>
    <table class="cmp"><tr><th class="l">Sala</th><th class="r">Venta perdida</th><th>SKU</th><th class="l">Causa principal</th></tr>
      ${foco.cadem.salas.slice(0, 8).map((s) => {
        const pc = new Map(); for (const r of s.filas) pc.set(r.causaLabel, (pc.get(r.causaLabel) ?? 0) + r.vp);
        return `<tr><td class="l b">${esc(s.nombre)}</td><td class="r">${clp(s.total)}</td><td>${s.n}</td><td class="l">${esc([...pc].sort((a, b) => b[1] - a[1])[0][0])}</td></tr>`;
      }).join("")}</table>
  </section>`;
}

/** Las 2 salas con peor resultado arrastrado (promedio de las 3 semanas) en RED NARTD. */
function hojaArrastrado(datos, z) {
  const sm = z.sem;
  const meta = z.metas.red_nartd;
  const supDe = (id) => z.supervisores.find((g) => g.salas.some((x) => x.sala_id === id))?.nombre ?? "–";
  const filas = z.salasZona.map((sa) => {
    const v = datos.filasSem.map((f) => { const r = f.find((x) => x.sala_id === sa.sala_id); return r?.red_nartd == null ? null : Number(r.red_nartd); });
    const con = v.filter((x) => x != null);
    return { sa, v, n: con.length, prom: con.length ? con.reduce((a, b) => a + b, 0) / con.length : null };
  }).filter((x) => x.prom != null);
  const orden = filas.filter((x) => x.n >= 2).sort((a, b) => a.prom - b.prom);
  const top = orden.slice(0, 2);
  const unaSemana = filas.filter((x) => x.n === 1 && x.prom < top[top.length - 1]?.prom).sort((a, b) => a.prom - b.prom);
  const tarjeta = (x, i) => {
    const comps = (perdidasSala(z.comp.nartd.get(x.sa.sala_id), "nartd")?.comps ?? []).filter((k) => k.pierde > 0.002).sort((a, b) => b.pierde - a.pierde).slice(0, 4);
    const ult = x.v.filter((q) => q != null);
    const tend = ult.length >= 2 ? ult[ult.length - 1] - ult[0] : null;
    return `<div class="blq"><h3>${i + 1}. ${esc(x.sa.nombre)} <span class="x">· ${esc(supDe(x.sa.sala_id))}</span></h3>
      <table class="cmp"><tr><th class="l"></th>${sm.map((w) => `<th>S${w}</th>`).join("")}<th>Promedio 3 semanas</th><th>Oportunidad vs meta</th><th>Tendencia</th></tr>
        <tr><td class="l b">RED NARTD</td>${x.v.map((q) => `<td class="${q == null ? "na" : q >= meta ? "ok" : "bad"}">${pct(q)}</td>`).join("")}<td class="bad b">${pct(x.prom)}</td><td>+${nf((meta - x.prom) * 100, 1)} pp</td><td>${tend == null ? "–" : `${tend < 0 ? "▼" : "▲"} ${pp(tend)}`}</td></tr></table>
      <table class="cmp" style="margin-top:4px"><tr><th class="l">Dónde pierde puntos en S${sm[2]}</th><th>Nota</th><th>Puntos que suma si llega a 100%</th></tr>
        ${comps.length ? comps.map((k) => `<tr><td class="l">${esc(CORTO[k.label] ?? k.label)}</td><td class="${k.nota < 0.7 ? "bad" : ""}">${pct(k.nota, 0)}</td><td>+${pts(k.pierde)} pts</td></tr>`).join("") : `<tr><td class="l" colspan="3">Sin componentes cargados en S${sm[2]}.</td></tr>`}</table></div>`;
  };
  return `<section class="pag">
    ${cab(`${esc(z.zona)} · RED NARTD: resultado arrastrado`, "Las 2 salas con peor promedio de las últimas 3 semanas", `Semana ${sm[2]}<br>Meta ${pct(meta, 0)}`)}
    ${top.length ? top.map(tarjeta).join("") : `<p class="x">No hay salas con 2 o más semanas de RED NARTD.</p>`}
    ${unaSemana.length ? `<p class="nota"><b>Con una sola semana de dato</b> (no entran al ranking de arrastre): ${unaSemana.map((x) => `${esc(x.sa.nombre)} ${pct(x.prom)}`).join(" · ")}.</p>` : ""}
    <p class="nota">Arrastrado: promedio simple de las semanas S${sm[0]} a S${sm[2]} con dato; se exigen al menos 2 semanas. El puntaje por componente reparte lo que le falta a la sala para 100% según el peso de cada componente (SOVI 35, NSS 20, ICE 20, exhibición 12, NSF 5, catálogos 5, POP 3).</p>
  </section>`;
}

/** foco: zona armada del informe; otras: las demás zonas armadas (con salas). */
export function htmlComparativo(datos, foco, extrasFoco, otras) {
  const zonas = [foco, ...[...otras].sort((a, b) => a.zona.localeCompare(b.zona, "es"))];
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(foco.zona)} · Informe y comparativo con otras zonas</title>
    <style>${CSS}${CSS_EJEC}${CSS_COMP}</style></head><body>
    ${paginasEjecutivo(datos, foco, extrasFoco)}
    ${hojaArrastrado(datos, foco)}
    ${hojaIndicadores(datos, zonas)}${hojaComponentes(datos, zonas)}${hojaVentaPerdida(datos, zonas)}
  </body></html>`;
}
