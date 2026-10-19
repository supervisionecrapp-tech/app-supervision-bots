// Informe semanal EJECUTIVO por zona: 3 páginas para gerentes y subgerentes.
// Lo que no está en meta se presenta como oportunidad y se trabaja con un plan
// de trabajo; el informe no le pide nada a gerencia.
//   Pág. 1  Indicadores contra meta, comparativa general por supervisor,
//           lectura de la semana y plan de trabajo.
//   Pág. 2  Salas con oportunidad, por indicador.
//   Pág. 3  Ranking de intervención por sala, seguimiento y datos pendientes.
// Mismos datos y reglas que el informe detallado (gestion.mjs). Los topes de
// filas mantienen el largo; index.mjs verifica que el PDF no pase de 3 páginas.
import { pct, clp, esc, nf, pts, perdidasSala, diaMes, masDias, CSS, RED, PRES, CORTO, celda } from "./salas_foco.mjs";
import { GUIA_COMPONENTE, plazo, brechaTxt, fechaCorta, lista, pp, causaLabelCorta, guiaCausa } from "./gestion.mjs";

const CSS_EJEC = `
  body { font-size: 10px; line-height: 1.4; }
  .pag { height: 267mm; overflow: hidden; }
  .cab h1 { font-size: 21px; } .cab { margin-bottom: 8px; }
  h2 { margin: 11px 0 5px; }
  .kpi td, .kpi th { padding: 4px 8px; font-size: 10.5px; }
  .lectura { margin: 0; padding-left: 16px; font-size: 10.8px; } .lectura li { margin: 4px 0; }
  table.c td, table.c th { padding: 3px 5px; font-size: 9.3px; vertical-align: top; }
  tr.tot td { background: #f3f4f6; font-weight: 700; }
  .semaforo { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
  .semaforo.ok { background: #16a34a; } .semaforo.bad { background: #dc2626; } .semaforo.na { background: #9ca3af; }
  .blq h3 { margin: 8px 0 3px; font-size: 10.5px; } .blq .x { font-weight: 400; }
`;

const cab = (t, s, d) => `<div class="cab"><div><h1>${t}</h1><div class="s">${s}</div></div><div class="d">${d}</div></div>`;
const sem = (v, meta) => `<span class="semaforo ${v == null ? "na" : v >= meta ? "ok" : "bad"}"></span>`;
const flecha = (v, ant) => (v == null || ant == null ? "–" : Math.abs(v - ant) < 0.0005 ? "=" : `${v > ant ? "▲" : "▼"} ${pp(v - ant)}`);
const supDe = (z, id) => z.supervisores.find((g) => g.salas.some((x) => x.sala_id === id))?.nombre ?? "Sin supervisor";
const ap = (n) => (n ? esc(n.split(" ").slice(-2).join(" ")) : "–");
const horasDe = (hs) => hs.reduce((x, h) => x + Math.max(0, h.falta), 0);

function sinCargaRed(datos, z) {
  const tiene = (filas, id) => { const r = filas.find((x) => x.sala_id === id); return !!r && RED.some((c) => r[`red_${c.key}`] != null); };
  const sinAhora = z.salasZona.filter((s) => RED.every((c) => z.porSala.get(s.sala_id).red[c.key] == null));
  return sinAhora.filter((s) => tiene(datos.filasSem[1], s.sala_id) || tiene(datos.filasSem[0], s.sala_id));
}

/** Salas bajo meta en una categoría RED, de mayor a menor oportunidad, con el componente que más suma. */
function oportunidadesRed(z, c) {
  const meta = z.metas[c.meta];
  const filas = z.salasZona.map((s) => ({ s, v: z.porSala.get(s.sala_id).red[c.key] })).filter((x) => x.v != null && x.v < meta).sort((a, b) => a.v - b.v);
  return {
    meta,
    filas: filas.map((x) => {
      const comps = (perdidasSala(z.comp[c.key].get(x.s.sala_id), c.key)?.comps ?? []).filter((k) => k.pierde > 0.002).sort((a, b) => b.pierde - a.pierde);
      return { ...x, top: comps[0] ?? null };
    }),
  };
}

// ---------------------------------------------------------------- página 1

function pagina1(datos, z, extras) {
  const { metas, sem: sm } = z;
  const [a, b, w] = z.ind;
  const rango = `${diaMes(datos.lunes)}–${diaMes(masDias(datos.lunes, 6))}`;
  const ps = extras.problemas;

  const filaPct = (label, k, meta, serie) => {
    if (w[k] == null && b[k] == null) return "";
    const op = w[k] != null && w[k] < meta;
    return `<tr><td class="l b">${sem(w[k], meta)}${label}</td>${celda(w[k], meta)}<td>${pct(meta, 0)}</td><td class="${op ? "b" : ""}">${op ? `+${nf((meta - w[k]) * 100, 1)} pp` : "En meta"}</td>
      <td>${flecha(w[k], b[k])}</td><td class="l x">${serie ? `S${sm[0]} ${pct(a[k], 0)} · S${sm[1]} ${pct(b[k], 0)} · S${sm[2]} ${pct(w[k], 0)}` : ""}</td></tr>`;
  };
  const tabla = `<table class="kpi"><tr><th class="l">Indicador</th><th>S${sm[2]}</th><th>Meta</th><th>Oportunidad</th><th>vs S${sm[1]}</th><th class="l">Últimas 3 semanas</th></tr>
    ${RED.map((c) => filaPct(`RED ${c.label}`, c.key, metas[c.meta], false)).join("")}
    ${PRES.map((p) => filaPct(p.label, p.key, metas.presentismo, true)).join("")}
    <tr><td class="l b"><span class="semaforo na"></span>Venta perdida Cadem</td><td class="b">${clp(z.cadem.total)}</td><td>—</td><td>—</td><td>—</td><td class="l x">${z.cadem.salas.length} de ${z.salasZona.length} salas con quiebre medido</td></tr></table>`;

  // Comparativa general: la zona y cada supervisor con los mismos indicadores.
  const filaComp = (nombre, ind, nSalas, horas, vp, focos, cls = "") => {
    const celdaRed = (c) => `<td class="${ind[c.key] == null ? "na" : ind[c.key] >= metas[c.meta] ? "ok" : "bad"}">${pct(ind[c.key])}</td>`;
    const pr = (k) => `<td class="${ind[k] == null ? "na" : ind[k] >= metas.presentismo ? "ok" : "bad"}">${pct(ind[k])}</td>`;
    return `<tr class="${cls}"><td class="l b">${esc(nombre)}</td><td>${nSalas}</td>${RED.map(celdaRed).join("")}${PRES.map((p) => pr(p.key)).join("")}<td>${horas >= 0.5 ? `${nf(horas, 0)} h` : "–"}</td><td class="r">${vp ? clp(vp) : "–"}</td><td>${focos}</td></tr>`;
  };
  const comparativa = `<table class="c"><tr><th class="l"></th><th>Salas</th>${RED.map((c) => `<th>${c.label}</th>`).join("")}${PRES.map((p) => `<th>${p.label.replace("Presentismo ", "Pres. ")}</th>`).join("")}<th>Horas por cubrir</th><th class="r">Venta perdida</th><th>Salas foco</th></tr>
    ${filaComp(`Total ${z.zona}`, w, z.salasZona.length, horasDe(z.horas), z.cadem.total, z.foco.length, "tot")}
    ${z.supervisores.map((s) => filaComp(s.nombre, s.ind[2], s.salas.length, horasDe(s.horas), s.cadem.total, s.foco.length)).join("")}</table>`;

  // Lectura de la semana: oportunidades medidas.
  const lectura = [];
  const mayor = RED.map((c) => ({ c, b: z.brechas[c.key] })).filter((x) => x.b && x.b.falta > 0).sort((p, q) => q.b.falta - p.b.falta)[0];
  if (mayor) {
    const k = mayor.b.componentes[0];
    lectura.push(`<b>RED ${mayor.c.label} concentra la mayor oportunidad de RED:</b> ${pct(mayor.b.promedio)} contra meta ${pct(mayor.b.meta, 0)}. ${CORTO[k.label] ?? k.label} es el componente que más suma al subir (${pts(k.pierde)} pts).`
      + (mayor.b.alcanza ? ` Con ${mayor.b.plan.length} acciones sala×componente la zona llega a ${pct(mayor.b.plan[mayor.b.plan.length - 1].proyectado)}.` : ""));
  } else lectura.push("<b>RED en meta</b> en todas las categorías medidas.");
  for (const p of PRES) {
    const v = w[p.key];
    if (v == null || v >= metas.presentismo) continue;
    const salasP = z.salasZona.filter((s) => z.porSala.get(s.sala_id).presTipo === p.key);
    const hs = salasP.map((s) => extras.horas.get(s.sala_id)).filter(Boolean);
    lectura.push(`<b>${p.label} ${pct(v)}:</b> hay ${nf(horasDe(hs), 0)} h por cubrir en ${hs.filter((h) => h.falta >= 0.5).length} salas.`);
  }
  if (z.cadem.total) {
    const c1 = z.cadem.causas[0];
    lectura.push(`<b>Venta perdida ${clp(z.cadem.total)}:</b> ${Math.round(c1.pct * 100)}% registrada como "${c1.label.toLowerCase()}", que se recupera con reposición. Mayor monto en ${esc(z.cadem.salas[0].nombre)} (${clp(z.cadem.salas[0].total)}).`);
  }

  // Plan de trabajo: una fila por indicador con oportunidad.
  const fecha = fechaCorta(plazo(datos, "Alta"));
  const resp = (salas) => [...new Set(salas.map((s) => supDe(z, s.sala_id)))].map(ap).join(", ");
  const plan = [];
  for (const c of RED) {
    const { filas } = oportunidadesRed(z, c);
    const foco = filas.filter((x) => z.metas[c.meta] - x.v >= 0.1).slice(0, 4);
    if (!foco.length) continue;
    const top = z.brechas[c.key]?.componentes?.[0];
    const guia = top ? GUIA_COMPONENTE[top.label] : null;
    plan.push({ ind: `RED ${c.label}`, trabajo: `${guia?.corto ?? "Revisar medición"} en ${lista(foco.map((x) => esc(x.s.nombre)), 3)}.`, resp: resp(foco.map((x) => x.s)), verif: "Componente sobre 90% en la medición RED siguiente." });
  }
  for (const p of PRES) {
    if (w[p.key] == null || w[p.key] >= metas.presentismo) continue;
    const l = ps.filter((x) => x.tipo === "presentismo" && x.cat === p.key).sort((x, y) => y.orden - x.orden).slice(0, 4);
    if (!l.length) continue;
    plan.push({ ind: p.label, trabajo: `Revisar marcas y cubrir turnos en ${lista(l.map((x) => `${esc(x.sala.nombre)} (${nf(x.orden, 0)} h)`), 3)}.`, resp: `${resp(l.map((x) => x.sala))} + coordinación de dotación`, verif: "Horas cumplidas ≥ objetivo la semana siguiente." });
  }
  if (z.cadem.total) {
    const sinStock = ps.flatMap((x) => x.sinStockLargo ?? []);
    const topVp = ps.filter((x) => x.tipo === "venta_perdida").sort((x, y) => y.orden - x.orden).slice(0, 3);
    plan.push({ ind: "Venta perdida", trabajo: `Reponer o ajustar inventario según la causa en ${lista(topVp.map((x) => esc(x.sala.nombre)), 3)}.${sinStock.length ? ` Coordinar abastecimiento de ${sinStock.length} SKU con 7 días o más sin stock.` : ""}`,
      resp: `${resp(topVp.map((x) => x.sala))}${sinStock.length ? " + Embonor" : ""}`, verif: "SKU fuera del reporte de quiebres siguiente." });
  }

  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Informe semanal de gestión`, "Resumen ejecutivo y plan de trabajo", `Semana ${sm[2]} (${rango})<br>Emitido ${fechaCorta(datos.emitido)}`)}
    <h2>Indicadores contra meta</h2>${tabla}
    <h2>Comparativa general por supervisor</h2>${comparativa}
    <p class="nota">Verde: en meta · rojo: con oportunidad. Presentismo WM sin Acuenta y SMU sin S10/Super 10, horas topadas al objetivo diario.</p>
    <h2>Lectura de la semana</h2>
    <ul class="lectura">${lectura.slice(0, 4).map((l) => `<li>${l}</li>`).join("")}</ul>
    <h2>Plan de trabajo</h2>
    <table class="c"><tr><th class="l">Indicador</th><th class="l">Qué se trabaja</th><th class="l">Responsable</th><th>Plazo</th><th class="l">Se verifica con</th></tr>
      ${plan.map((p) => `<tr><td class="l b">${esc(p.ind)}</td><td class="l">${p.trabajo}</td><td class="l">${p.resp}</td><td>${fecha}</td><td class="l">${esc(p.verif)}</td></tr>`).join("")}</table>
    <p class="nota">Responsables y plazos son propuestos por el informe. El detalle por sala está en las páginas siguientes.</p>
  </section>`;
}

// ---------------------------------------------------------------- página 2

function pagina2(datos, z, extras) {
  const { sem: sm } = z;
  const N = 6;
  const tablaRed = (c) => {
    const { meta, filas } = oportunidadesRed(z, c);
    if (!filas.length) return `<div class="blq"><h3>RED ${c.label}</h3><p class="x">Todas las salas medidas están en meta.</p></div>`;
    return `<div class="blq"><h3>RED ${c.label} <span class="x">· meta ${pct(meta, 0)} · ${filas.length} salas con oportunidad</span></h3>
      <table class="c"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th>Nota</th><th>Oportunidad</th><th class="l">Dónde sumar</th></tr>
      ${filas.slice(0, N).map((x) => `<tr><td class="l b">${esc(x.s.nombre)}</td><td class="l">${ap(supDe(z, x.s.sala_id))}</td><td class="bad">${pct(x.v)}</td><td>+${nf((meta - x.v) * 100, 1)} pp</td>
        <td class="l">${x.top ? `${esc(CORTO[x.top.label] ?? x.top.label)} <span class="x">(+${pts(x.top.pierde)} pts)</span>` : "–"}</td></tr>`).join("")}</table></div>`;
  };
  const tablaPres = (p) => {
    const salas = z.salasZona.filter((s) => z.porSala.get(s.sala_id).presTipo === p.key).map((s) => ({ s, h: extras.horas.get(s.sala_id), d: z.porSala.get(s.sala_id) }))
      .filter((x) => x.h && x.h.falta >= 0.5).sort((a, b) => b.h.falta - a.h.falta);
    if (!salas.length) return "";
    return `<div class="blq"><h3>${p.label} <span class="x">· meta ${pct(z.metas.presentismo, 0)} · ${salas.length} salas con horas por cubrir</span></h3>
      <table class="c"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th>Semana</th><th>3 semanas</th><th>Horas por cubrir</th><th class="l">Días críticos</th></tr>
      ${salas.slice(0, N).map((x) => `<tr><td class="l b">${esc(x.s.nombre)}</td><td class="l">${ap(supDe(z, x.s.sala_id))}</td><td class="${x.d.presSem[2] != null && x.d.presSem[2] < z.metas.presentismo ? "bad" : ""}">${pct(x.d.presSem[2], 0)}</td><td>${pct(x.d.pres3, 0)}</td><td>${nf(x.h.falta, 0)} h</td>
        <td class="l">${esc(x.h.criticos.slice(0, 3).map((c) => c.split(" ")[0]).join(", ") || "repartido")}</td></tr>`).join("")}</table></div>`;
  };
  const vp = z.cadem.total ? `<div class="blq"><h3>Venta perdida Cadem <span class="x">· ${clp(z.cadem.total)} · ${z.cadem.salas.length} salas con quiebre medido</span></h3>
      <table class="c"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th class="r">Venta perdida</th><th>SKU</th><th class="l">Causa principal</th><th class="l">Cómo se recupera</th></tr>
      ${z.cadem.salas.slice(0, N).map((s) => {
        const pc = new Map(); for (const r of s.filas) pc.set(r.causa, (pc.get(r.causa) ?? 0) + r.vp);
        const [causa] = [...pc].sort((x, y) => y[1] - x[1])[0];
        return `<tr><td class="l b">${esc(s.nombre)}</td><td class="l">${ap(supDe(z, s.salaId))}</td><td class="r">${clp(s.total)}</td><td>${s.n}</td><td class="l">${causaLabelCorta(causa)}</td><td class="l">${guiaCausa(causa).corto}</td></tr>`;
      }).join("")}</table></div>` : "";

  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Salas con oportunidad por indicador`, "Dónde está el mayor espacio de mejora en cada indicador", `Semana ${sm[2]}`)}
    ${RED.map(tablaRed).join("")}${PRES.map(tablaPres).join("")}${vp}
    <p class="nota">Cada tabla muestra las ${N} salas con mayor oportunidad del indicador, de mayor a menor. "Dónde sumar" es el componente RED que más puntos suma si la sala lo lleva a 100%.</p>
  </section>`;
}

// ---------------------------------------------------------------- página 3

function pagina3(datos, z, extras) {
  const { sem: sm } = z;
  const ps = extras.problemas;

  // Ranking: sala por sala con su situación en cada indicador. Orden: más
  // oportunidades prioritarias primero; luego más oportunidades en total.
  const porSala = new Map();
  for (const p of ps) {
    const x = porSala.get(p.sala.sala_id) ?? { sala: p.sala, ps: [] };
    x.ps.push(p); porSala.set(p.sala.sala_id, x);
  }
  const altas = (x) => x.ps.filter((p) => p.prioridad === "Alta").length;
  const ranking = [...porSala.values()].sort((a, b) => altas(b) - altas(a) || b.ps.length - a.ps.length || a.sala.nombre.localeCompare(b.sala.nombre, "es"));
  const N = 18;
  const porPrio = (l) => [...l].sort((p, q) => (p.prioridad === "Alta" ? 0 : 1) - (q.prioridad === "Alta" ? 0 : 1) || q.orden - p.orden);
  const celdaInd = (x, tipo, fmt) => {
    const l = porPrio(x.ps.filter((p) => p.tipo === tipo));
    if (!l.length) return `<td class="na">–</td>`;
    return `<td class="${l[0].prioridad === "Alta" ? "bad" : "warn"}">${l.map(fmt).join("<br>")}</td>`;
  };
  const nPrio = ranking.filter((x) => altas(x)).length;
  const filas = ranking.slice(0, N).map((x, i) => `<tr><td class="b">${i + 1}</td><td class="l b">${esc(x.sala.nombre)}</td><td class="l">${ap(supDe(z, x.sala.sala_id))}</td>
    ${celdaInd(x, "red", (p) => `${p.cat} ${pct(p.valor, 0)}`)}${celdaInd(x, "presentismo", (p) => pct(p.valor, 0))}${celdaInd(x, "venta_perdida", (p) => clp(p.valor))}
    <td class="l">${esc([...new Set(porPrio(x.ps).map((p) => p.corto))].slice(0, 2).join("; "))}</td></tr>`).join("");

  // Seguimiento y datos pendientes.
  const prev = extras.previos;
  const mejoro = prev.filter((c) => /^Mejoró/.test(c.resultado)).length, empeoro = prev.filter((c) => /^Empeoró/.test(c.resultado)).length;
  const seg = prev.length
    ? `De los ${prev.length} compromisos de la semana ${sm[1]}, <b>${mejoro}</b> mejoraron su indicador, <b>${empeoro}</b> empeoraron y ${prev.length - mejoro - empeoro} se mantienen o no tienen dato esta semana.`
    : `Este es el primer informe con compromisos registrados: su resultado se medirá en el informe de la semana ${sm[2] + 1}.`;
  const sinRed = sinCargaRed(datos, z);
  const pend = [];
  if (sinRed.length) pend.push(`${sinRed.length} salas sin carga RED esta semana (${lista(sinRed.map((s) => esc(s.nombre)), 3)}): se miden cuando llegue la carga.`);
  pend.push(`Venta perdida: ${z.cadem.salas.length} de ${z.salasZona.length} salas con quiebre medido; la causa raíz se confirma en sala.`);

  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Ranking de intervención`, "Salas ordenadas por cantidad de oportunidades prioritarias", `Semana ${sm[2]}<br>${nPrio} salas con oportunidad prioritaria`)}
    <table class="c"><tr><th>#</th><th class="l">Sala</th><th class="l">Supervisor</th><th>RED</th><th>Presentismo</th><th>Venta perdida</th><th class="l">Primer foco de trabajo</th></tr>${filas}</table>
    <p class="nota">Rojo: oportunidad prioritaria · amarillo: oportunidad media · "–": sin oportunidad en ese indicador. Se muestran las ${Math.min(N, ranking.length)} primeras de ${ranking.length} salas.
      <b>Prioridad (propuesta):</b> RED prioritaria si la categoría está bajo 75% o a 20 pp o más de la meta, media desde 10 pp. Presentismo prioritario si lleva 3 semanas bajo 80% y esta semana bajo meta, media si faltan 8 h o más. Venta perdida prioritaria desde $50.000 o con un SKU 7 días o más sin stock, media desde $15.000. Cada indicador se clasifica por separado.</p>
    <h2>Seguimiento de compromisos</h2>
    <p style="margin:2px 0;font-size:10.5px">${seg}</p>
    <h2>Datos pendientes</h2>
    <ul class="lectura" style="font-size:9.8px">${pend.map((v) => `<li>${v}</li>`).join("")}</ul>
  </section>`;
}

// ---------------------------------------------------------------- documento

export function htmlEjecutivo(datos, z, extras) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(z.zona)} · Informe semanal de gestión</title>
    <style>${CSS}${CSS_EJEC}</style></head><body>
    ${pagina1(datos, z, extras)}${pagina2(datos, z, extras)}${pagina3(datos, z, extras)}
  </body></html>`;
}

/** Páginas de un PDF (cuenta los objetos /Type /Page, sin /Pages). */
export const paginasPdf = (buf) => (buf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
