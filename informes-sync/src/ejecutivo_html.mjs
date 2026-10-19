// Informe semanal EJECUTIVO por zona: 3 páginas para gerentes y subgerentes.
// Lo que no está en meta se presenta como oportunidad y se trabaja con un plan
// de trabajo; el informe no le pide nada a gerencia.
//   Pág. 1  Indicadores contra meta, comparativa general por supervisor,
//           lectura de la semana y plan de trabajo.
//   Pág. 2  Salas con oportunidad, por indicador.
//   Pág. 3  Ranking de intervención por sala.
// Mismos datos y reglas que el informe detallado (gestion.mjs). Los topes de
// filas mantienen el largo; index.mjs verifica que el PDF no pase de 3 páginas.
import { pct, clp, esc, nf, pts, perdidasSala, diaMes, masDias, CSS, RED, PRES, CORTO, celda } from "./salas_foco.mjs";
import { GUIA_COMPONENTE, brechaTxt, fechaCorta, lista, pp, causaLabelCorta, guiaCausa } from "./gestion.mjs";

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
  .po { border: 1px solid #e5e7eb; border-left: 4px solid #b91c1c; border-radius: 5px; margin: 5px 0; padding: 5px 9px; break-inside: avoid; }
  .po .ph { font-weight: 700; font-size: 11px; margin-bottom: 3px; } .po .ph .n { display: inline-block; background: #b91c1c; color: #fff; border-radius: 50%; width: 16px; height: 16px; text-align: center; line-height: 16px; font-size: 9.5px; margin-right: 6px; }
  .po .pg { display: grid; grid-template-columns: 104px 1fr; gap: 1px 8px; font-size: 9.3px; line-height: 1.35; } .po .k { color: #6b7280; font-weight: 600; }
  .po ol { margin: 0; padding-left: 14px; } .po li { margin: 0; }
  .blq h3 { margin: 8px 0 3px; font-size: 10.5px; } .blq .x { font-weight: 400; }
`;

const cab = (t, s, d) => `<div class="cab"><div><h1>${t}</h1><div class="s">${s}</div></div><div class="d">${d}</div></div>`;
const sem = (v, meta) => `<span class="semaforo ${v == null ? "na" : v >= meta ? "ok" : "bad"}"></span>`;
const flecha = (v, ant) => (v == null || ant == null ? "–" : Math.abs(v - ant) < 0.0005 ? "=" : `${v > ant ? "▲" : "▼"} ${pp(v - ant)}`);
const supDe = (z, id) => z.supervisores.find((g) => g.salas.some((x) => x.sala_id === id))?.nombre ?? "Sin supervisor";
const ap = (n) => (n ? esc(n.split(" ").slice(-2).join(" ")) : "–");
const nombres = (xs, n = 3) => xs.slice(0, n).join(", ");

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
    <tr><td class="l b"><span class="semaforo na"></span>Venta perdida Cadem</td><td class="b">${clp(z.cadem.total)}</td><td>—</td><td>—</td><td>—</td><td class="l x">Reporte Datawalt de quiebres</td></tr></table>`;

  // Comparativa general: la zona y cada supervisor con los mismos indicadores.
  const filaComp = (nombre, ind, vp, cls = "") => {
    const celdaRed = (c) => `<td class="${ind[c.key] == null ? "na" : ind[c.key] >= metas[c.meta] ? "ok" : "bad"}">${pct(ind[c.key])}</td>`;
    const pr = (k) => `<td class="${ind[k] == null ? "na" : ind[k] >= metas.presentismo ? "ok" : "bad"}">${pct(ind[k])}</td>`;
    return `<tr class="${cls}"><td class="l b">${esc(nombre)}</td>${RED.map(celdaRed).join("")}${PRES.map((p) => pr(p.key)).join("")}<td class="r">${vp ? clp(vp) : "–"}</td></tr>`;
  };
  const comparativa = `<table class="c"><tr><th class="l"></th>${RED.map((c) => `<th>${c.label}</th>`).join("")}${PRES.map((p) => `<th>${p.label.replace("Presentismo ", "Pres. ")}</th>`).join("")}<th class="r">Venta perdida</th></tr>
    ${filaComp(`Total ${z.zona}`, w, z.cadem.total, "tot")}
    ${z.supervisores.map((s) => filaComp(s.nombre, s.ind[2], s.cadem.total)).join("")}</table>`;

  // Prioridades operativas: las dos mayores oportunidades contra meta (por puntos
  // porcentuales) y la venta perdida. Cada una dice la situación, qué se hace y en
  // qué orden, dónde, quién, qué resultado se espera y con qué se verifica.
  const resp = (salas) => [...new Set(salas.map((s) => supDe(z, s.sala_id)))].map(ap).join(", ");
  const supMayor = (key) => [...z.supervisores].filter((g) => g.id !== "sin" && (g.aporte[key] ?? 0) > 0.02).sort((x, y) => y.aporte[key] - x.aporte[key])[0];
  const cand = [];
  for (const c of RED) {
    const bz = z.brechas[c.key];
    if (!bz || bz.falta <= 0 || w[c.key] == null) continue;
    const { filas } = oportunidadesRed(z, c);
    const foco = filas.slice(0, 4);
    const [k1, k2] = bz.componentes;
    const g1 = GUIA_COMPONENTE[k1.label], g2 = k2 ? GUIA_COMPONENTE[k2.label] : null;
    const sup = supMayor(c.key);
    cand.push({
      orden: metas[c.meta] - w[c.key],
      titulo: `RED ${c.label}: ${pct(w[c.key])} contra meta ${pct(metas[c.meta], 0)}`,
      situacion: `${CORTO[k1.label] ?? k1.label} es el componente que más suma (+${pts(k1.pierde)} pts, nota ${pct(k1.nota, 0)})${k2 ? `, seguido de ${CORTO[k2.label] ?? k2.label} (+${pts(k2.pierde)} pts)` : ""}.${sup ? ` Las salas de ${esc(sup.nombre)} aportan ${pts(sup.aporte[c.key])} pts de la oportunidad.` : ""}`,
      hacer: [
        g1 ? g1.acc(c.label) : "Revisar la medición RED de las salas.",
        g2 && k2.pierde > 0.5 ? `Con el mismo recorrido, ${g2.corto.toLowerCase()} (${CORTO[k2.label] ?? k2.label}).` : null,
        g1 ? `Apoyo si hace falta: ${g1.apoyo}` : null,
      ],
      donde: foco.map((x) => `${esc(x.s.nombre)} (${pct(x.v, 0)})`).join(", "),
      resp: resp(foco.map((x) => x.s)),
      esperado: bz.alcanza ? `Las ${bz.plan.length} acciones sala×componente llevan a ${esc(z.zona)} a ${pct(bz.plan[bz.plan.length - 1].proyectado)}, sobre la meta.` : `Con todo en 100% se llega a ${pct(bz.maximo)}: la meta exige además cargar las salas sin medición.`,
      verif: "Componente sobre 90% en la medición RED siguiente de cada sala.",
    });
  }
  for (const p of PRES) {
    const v = w[p.key];
    if (v == null || v >= metas.presentismo) continue;
    const l = ps.filter((x) => x.tipo === "presentismo" && x.cat === p.key).sort((x, y) => x.valor - y.valor).slice(0, 4);
    if (!l.length) continue;
    const peor = [...z.supervisores].filter((g) => g.ind[2][p.key] != null && g.ind[2][p.key] < metas.presentismo).sort((x, y) => x.ind[2][p.key] - y.ind[2][p.key])[0];
    cand.push({
      orden: metas.presentismo - v,
      titulo: `${p.label}: ${pct(v)} contra meta ${pct(metas.presentismo, 0)}`,
      situacion: `${nf((metas.presentismo - v) * 100, 1)} pp bajo la meta${b[p.key] != null && v < b[p.key] ? `, ${nf((b[p.key] - v) * 100, 1)} pp menos que la semana anterior` : ""}.${peor ? ` La mayor oportunidad está en ${esc(peor.nombre)} (${pct(peor.ind[2][p.key])}).` : ""}`,
      hacer: [
        "Revisar las marcas de los días críticos de cada sala: confirmar si la persona asistió sin marcar o no asistió.",
        "Donde falta dotación, coordinar la cobertura (volante o reemplazo) con coordinación de dotación.",
        "Seguir el presentismo de estas salas durante la semana, para corregir a tiempo y no al cierre.",
      ],
      donde: l.map((x) => `${esc(x.sala.nombre)} (${pct(x.valor, 0)})`).join(", "),
      resp: `${resp(l.map((x) => x.sala))} + coordinación de dotación`,
      esperado: `${p.label} de la semana ${sm[2] + 1} en meta (${pct(metas.presentismo, 0)}).`,
      verif: "Presentismo de la semana siguiente.",
    });
  }
  const prioridades = cand.sort((x, y) => y.orden - x.orden).slice(0, 2);
  if (z.cadem.total) {
    const c1 = z.cadem.causas[0];
    const sumaCausa = new Map(); for (const r of z.cadem.filas) sumaCausa.set(r.causa, (sumaCausa.get(r.causa) ?? 0) + r.vp);
    const g = guiaCausa([...sumaCausa].sort((x, y) => y[1] - x[1])[0][0]);
    const sinStock = ps.flatMap((x) => x.sinStockLargo ?? []);
    const topVp = ps.filter((x) => x.tipo === "venta_perdida").sort((x, y) => y.orden - x.orden).slice(0, 3);
    prioridades.push({
      titulo: `Venta perdida Cadem: ${clp(z.cadem.total)}`,
      situacion: `${Math.round(c1.pct * 100)}% está registrada como "${c1.label.toLowerCase()}", que se recupera con reposición. El monto es lo máximo recuperable, no una meta.`,
      hacer: [
        g.acc,
        sinStock.length ? `Coordinar con Embonor y la cadena el abastecimiento de ${sinStock.length} SKU con 7 días o más sin stock.` : null,
        "Ante un quiebre de stock: validar inventario físico, comparar con el sistema, revisar pedidos y verificar la reposición en góndola.",
      ],
      donde: topVp.map((x) => `${esc(x.sala.nombre)} (${clp(x.valor)})`).join(", "),
      resp: `${resp(topVp.map((x) => x.sala))}${sinStock.length ? " + Embonor" : ""}`,
      esperado: "Los SKU con quiebre salen del reporte de la semana siguiente.",
      verif: "Reporte Datawalt de quiebres siguiente.",
    });
  }
  const cards = prioridades.map((p, i) => `<div class="po"><div class="ph"><span class="n">${i + 1}</span>${p.titulo}</div><div class="pg">
      <span class="k">Situación</span><span>${p.situacion}</span>
      <span class="k">Dónde</span><span>${p.donde}</span>
      <span class="k">Responsable</span><span>${p.resp}</span>
      <span class="k">Resultado esperado</span><span>${p.esperado}</span>
      <span class="k">Se verifica con</span><span>${esc(p.verif)}</span></div></div>`).join("");

  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Informe semanal de gestión`, "Resumen ejecutivo y prioridades operativas", `Semana ${sm[2]} (${rango})<br>Emitido ${fechaCorta(datos.emitido)}`)}
    <h2>Indicadores contra meta</h2>${tabla}
    <h2>Comparativa general por supervisor</h2>${comparativa}
    <p class="nota">Verde: en meta · rojo: con oportunidad. Presentismo WM sin Acuenta y SMU sin S10/Super 10, horas topadas al objetivo diario.</p>
    <h2>Prioridades operativas</h2>
    ${cards}
    <p class="nota">Orden: primero las dos mayores oportunidades contra meta (en puntos porcentuales) y luego la venta perdida. Los responsables son propuestos por el informe. El detalle por sala está en las páginas siguientes.</p>
  </section>`;
}

// ---------------------------------------------------------------- página 2

function pagina2(datos, z, extras) {
  const { sem: sm } = z;
  const N = 6;
  const tablaRed = (c) => {
    const { meta, filas } = oportunidadesRed(z, c);
    if (!filas.length) return `<div class="blq"><h3>RED ${c.label}</h3><p class="x">Todas las salas medidas están en meta.</p></div>`;
    return `<div class="blq"><h3>RED ${c.label} <span class="x">· meta ${pct(meta, 0)}</span></h3>
      <table class="c"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th>Nota</th><th>Oportunidad</th><th class="l">Dónde sumar</th></tr>
      ${filas.slice(0, N).map((x) => `<tr><td class="l b">${esc(x.s.nombre)}</td><td class="l">${ap(supDe(z, x.s.sala_id))}</td><td class="bad">${pct(x.v)}</td><td>+${nf((meta - x.v) * 100, 1)} pp</td>
        <td class="l">${x.top ? `${esc(CORTO[x.top.label] ?? x.top.label)} <span class="x">(+${pts(x.top.pierde)} pts)</span>` : "–"}</td></tr>`).join("")}</table></div>`;
  };
  const tablaPres = (p) => {
    const salas = z.salasZona.filter((s) => z.porSala.get(s.sala_id).presTipo === p.key).map((s) => ({ s, h: extras.horas.get(s.sala_id), d: z.porSala.get(s.sala_id) }))
      .filter((x) => x.h && x.d.presSem[2] != null && x.d.presSem[2] < z.metas.presentismo).sort((a, b) => a.d.presSem[2] - b.d.presSem[2]);
    if (!salas.length) return "";
    return `<div class="blq"><h3>${p.label} <span class="x">· meta ${pct(z.metas.presentismo, 0)}</span></h3>
      <table class="c"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th>Semana</th><th>3 semanas</th><th>Oportunidad</th><th class="l">Días críticos</th></tr>
      ${salas.slice(0, N).map((x) => `<tr><td class="l b">${esc(x.s.nombre)}</td><td class="l">${ap(supDe(z, x.s.sala_id))}</td><td class="${x.d.presSem[2] != null && x.d.presSem[2] < z.metas.presentismo ? "bad" : ""}">${pct(x.d.presSem[2], 0)}</td><td>${pct(x.d.pres3, 0)}</td><td>+${nf((z.metas.presentismo - x.d.presSem[2]) * 100, 1)} pp</td>
        <td class="l">${esc(x.h.criticos.slice(0, 3).map((c) => c.split(" ")[0]).join(", ") || "repartido")}</td></tr>`).join("")}</table></div>`;
  };
  const vp = z.cadem.total ? `<div class="blq"><h3>Venta perdida Cadem <span class="x">· ${clp(z.cadem.total)}</span></h3>
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
  const filas = ranking.slice(0, N).map((x, i) => `<tr><td class="b">${i + 1}</td><td class="l b">${esc(x.sala.nombre)}</td><td class="l">${ap(supDe(z, x.sala.sala_id))}</td>
    ${celdaInd(x, "red", (p) => `${p.cat} ${pct(p.valor, 0)}`)}${celdaInd(x, "presentismo", (p) => pct(p.valor, 0))}${celdaInd(x, "venta_perdida", (p) => clp(p.valor))}
    <td class="l">${esc([...new Set(porPrio(x.ps).map((p) => p.corto))].slice(0, 2).join("; "))}</td></tr>`).join("");

  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Ranking de intervención`, "Salas ordenadas por cantidad de oportunidades prioritarias", `Semana ${sm[2]}`)}
    <table class="c"><tr><th>#</th><th class="l">Sala</th><th class="l">Supervisor</th><th>RED</th><th>Presentismo</th><th>Venta perdida</th><th class="l">Primer foco de trabajo</th></tr>${filas}</table>
    <p class="nota">Rojo: oportunidad prioritaria · amarillo: oportunidad media · "–": sin oportunidad en ese indicador. Se muestran las de mayor prioridad.
      <b>Prioridad (propuesta):</b> RED prioritaria si la categoría está bajo 75% o a 20 pp o más de la meta, media desde 10 pp. Presentismo prioritario si lleva 3 semanas bajo 80% y esta semana bajo meta, media si la semana quedó bajo meta con déficit relevante. Venta perdida prioritaria desde $50.000 o con un SKU 7 días o más sin stock, media desde $15.000. Cada indicador se clasifica por separado.</p>
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
