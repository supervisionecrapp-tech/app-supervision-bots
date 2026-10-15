// HTML del informe semanal de gestión (ver gestion.mjs para las reglas).
import {
  pct, clp, esc, nf, pts, diaLargo, diaMes, ddmm, masDias, CSS, RED, PRES, CORTO, celda, seccionVisitas, matrizFoco,
} from "./salas_foco.mjs";
import { GUIA_CAUSA, SECUENCIA_STOCK, guiaCausa, barras, tag, prioTag, pp, brechaTxt, fechaCorta, lista, plazo, causaLabelCorta } from "./gestion.mjs";

const CSS_GESTION = `
  .tag { display: inline-block; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 1px 5px; border-radius: 3px; margin-right: 4px; vertical-align: 1px; }
  .tag.dato { background: #dbeafe; color: #1e40af; } .tag.hip { background: #fef3c7; color: #92400e; }
  .tag.acc { background: #dcfce7; color: #166534; } .tag.falta { background: #e5e7eb; color: #374151; } .tag.prop { background: #ede9fe; color: #5b21b6; }
  .prio { display: inline-block; font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 3px; }
  .prio.Alta { background: #b91c1c; color: #fff; } .prio.Media { background: #f59e0b; color: #fff; }
  .kpi td, .kpi th { padding: 5px 8px; }
  .prioridades { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .pcard { border: 1px solid #e5e7eb; border-top: 3px solid #b91c1c; border-radius: 5px; padding: 8px 10px; font-size: 10px; background: #fff; }
  .pcard h3 { margin: 0 0 4px; font-size: 11.5px; }
  .pcard p { margin: 3px 0; }
  ul.limpia { margin: 0; padding-left: 15px; } ul.limpia li { margin: 3px 0; }
  .bloque-sala { border: 1px solid #e5e7eb; border-radius: 5px; margin: 8px 0; break-inside: avoid; }
  .bloque-sala .tit { background: #f3f4f6; padding: 5px 9px; font-weight: 700; font-size: 11px; display: flex; justify-content: space-between; }
  .prob { padding: 6px 9px; border-top: 1px solid #eef0f2; display: grid; grid-template-columns: 110px 1fr; gap: 2px 10px; font-size: 9.8px; }
  .prob .k { color: #6b7280; font-weight: 600; }
  .prob .titulo { grid-column: 1 / -1; font-weight: 700; font-size: 10.5px; }
  table.compacta td, table.compacta th { padding: 3px 5px; font-size: 9px; vertical-align: top; }
  table.compacta td.l { text-align: left; }
  .criterio { border: 1px dashed #c4b5fd; background: #faf5ff; border-radius: 5px; padding: 6px 10px; font-size: 9.5px; margin-top: 8px; }
  .secuencia { counter-reset: paso; margin: 0; padding-left: 0; list-style: none; columns: 2; font-size: 10px; }
  .secuencia li { counter-increment: paso; margin: 3px 0; break-inside: avoid; }
  .secuencia li::before { content: counter(paso) ". "; font-weight: 700; color: #b91c1c; }
  svg.barras { display: block; margin: 4px 0; }
  table.ranking tr.espacio td { border: none; padding: 0; height: 10px; }
  table.ranking tr.grupo td { background: #1f2937; color: #fff; font-weight: 700; font-size: 10.5px; padding: 5px 8px; text-align: left; border: none; }
  table.ranking tr.grupo td .x { color: #d1d5db; font-weight: 400; }
  table.ranking tr.sala-ini td { border-top: 1.5px solid #9ca3af; }
  table.ranking tr.grupo + tr.sala-ini td { border-top: none; }
  table.ranking td.sala-nombre { background: #f9fafb; }
  .dos-col { display: grid; grid-template-columns: 1.1fr 1fr; gap: 14px; }
  .resumen h2 { margin: 10px 0 5px; } .resumen .kpi td, .resumen .kpi th { padding: 3px 8px; }
  .resumen ul.limpia li { margin: 2px 0; } .resumen .pcard { font-size: 9.6px; padding: 6px 9px; }
`;

/** Salas sin RED esta semana: las que sí tenían en las 2 anteriores (falta la carga) y las que nunca tuvieron. */
function sinCargaRed(datos, z) {
  const tiene = (filas, id) => { const r = filas.find((x) => x.sala_id === id); return !!r && RED.some((c) => r[`red_${c.key}`] != null); };
  const sinAhora = z.salasZona.filter((s) => RED.every((c) => z.porSala.get(s.sala_id).red[c.key] == null));
  const faltaEstaSemana = sinAhora.filter((s) => tiene(datos.filasSem[1], s.sala_id) || tiene(datos.filasSem[0], s.sala_id));
  const ids = new Set(faltaEstaSemana.map((s) => s.sala_id));
  return { faltaEstaSemana, nunca: sinAhora.filter((s) => !ids.has(s.sala_id)) };
}

const cab = (titulo, sub, der) => `<div class="cab"><div><h1>${titulo}</h1><div class="s">${sub}</div></div><div class="d">${der}</div></div>`;

/** Tabla de indicadores contra meta, con brecha y variación. */
function tablaIndicadores(ind, metas, sem, cadem, nSalas) {
  const [a, b, w] = ind;
  const filaPct = (label, k, meta, conSerie) => {
    const v = w[k], ant = b[k];
    if (v == null && ant == null) return "";
    return `<tr><td class="l b">${label}</td>${celda(v, meta)}<td>${pct(meta, 0)}</td><td class="${v != null && v < meta ? "b" : ""}">${brechaTxt(v, meta)}</td>
      <td>${v != null && ant != null ? pp(v - ant) : "–"}</td><td class="l">${conSerie ? `S${sem[0]} ${pct(a[k], 0)} · S${sem[1]} ${pct(b[k], 0)} · S${sem[2]} ${pct(w[k], 0)}` : ""}</td></tr>`;
  };
  return `<table class="kpi"><tr><th class="l">Indicador</th><th>Resultado S${sem[2]}</th><th>Meta</th><th>Brecha</th><th>vs S${sem[1]}</th><th class="l">Evolución</th></tr>
    ${RED.map((c) => filaPct(`RED ${c.label}`, c.key, metas[c.meta], false)).join("")}
    ${PRES.map((p) => filaPct(p.label, p.key, metas.presentismo, true)).join("")}
    <tr><td class="l b">Venta perdida Cadem</td><td class="b">${clp(cadem.total)}</td><td>—</td><td>—</td><td>—</td>
      <td class="l">${cadem.salas.length} de ${nSalas} salas con datos de quiebre</td></tr></table>`;
}

/** Componente que más pts aporta dentro de las primeras acciones del plan. */
function grupoPlan(b) {
  if (!b || b.falta <= 0 || !b.plan.length) return null;
  const g = new Map();
  for (const a of b.plan) {
    const x = g.get(a.comp) ?? { comp: a.comp, sube: 0, salas: [] };
    x.sube += a.sube; x.salas.push(a.sala.nombre); g.set(a.comp, x);
  }
  return [...g.values()].sort((x, y) => y.sube - x.sube)[0];
}

// ---------------------------------------------------------------- página 1

function paginaResumen(datos, z, extras) {
  const { metas, sem } = z;
  const rango = `${diaMes(datos.lunes)}–${diaMes(masDias(datos.lunes, 6))}`;
  const ps = extras.problemas;

  // Lo más relevante: hechos medidos.
  const relevantes = [];
  const peorRed = RED.map((c) => ({ c, b: z.brechas[c.key] })).filter((x) => x.b && x.b.falta > 0).sort((a, b) => b.b.falta - a.b.falta)[0];
  if (peorRed) {
    const k = peorRed.b.componentes[0];
    relevantes.push(`RED ${peorRed.c.label} ${pct(peorRed.b.promedio)} contra meta ${pct(peorRed.b.meta, 0)} (${brechaTxt(peorRed.b.promedio, peorRed.b.meta)}). ${CORTO[k.label] ?? k.label} es el componente que más resta: ${pts(k.pierde)} pts, con nota promedio ${pct(k.nota, 0)}.`);
    const sup = [...z.supervisores].filter((s) => s.id !== "sin").sort((a, b) => (b.aporte[peorRed.c.key] ?? 0) - (a.aporte[peorRed.c.key] ?? 0))[0];
    if (sup?.aporte[peorRed.c.key] > 0) relevantes.push(`Las salas de ${esc(sup.nombre)} explican ${pts(sup.aporte[peorRed.c.key])} de esos pts: si todas llegaran a la meta, ${esc(z.zona)} subiría eso.`);
  }
  for (const p of PRES) {
    const v = z.ind[2][p.key];
    if (v == null || v >= metas.presentismo) continue;
    const salasP = z.salasZona.filter((s) => z.porSala.get(s.sala_id).presTipo === p.key);
    const horas = salasP.map((s) => extras.horas.get(s.sala_id)).filter(Boolean);
    const falta = horas.reduce((a, h) => a + Math.max(0, h.falta), 0);
    const bajo80 = salasP.filter((s) => (z.porSala.get(s.sala_id).pres3 ?? 1) < 0.8).length;
    relevantes.push(`${p.label} ${pct(v)} (${brechaTxt(v, metas.presentismo)}): faltaron ${nf(falta, 0)} h en la semana; ${bajo80} sala${bajo80 === 1 ? "" : "s"} bajo 80% en las últimas 3 semanas.`);
  }
  if (z.cadem.total) {
    const c1 = z.cadem.causas[0];
    relevantes.push(`Venta perdida Cadem ${clp(z.cadem.total)} en ${z.cadem.salas.length} salas: ${Math.round(c1.pct * 100)}% registrada como "${c1.label.toLowerCase()}". La sala con más monto es ${esc(z.cadem.salas[0].nombre)} (${clp(z.cadem.salas[0].total)}).`);
  }

  // Tres prioridades operativas.
  const prioridades = [];
  if (peorRed) {
    const g = grupoPlan(peorRed.b);
    const k = peorRed.b.componentes[0];
    prioridades.push({
      t: `${CORTO[k.label] ?? k.label} en RED ${peorRed.c.label}`,
      dato: `${pct(peorRed.b.promedio)} vs ${pct(peorRed.b.meta, 0)}; ${CORTO[k.label] ?? k.label} resta ${pts(k.pierde)} pts.`,
      problema: g ? `Las mayores pérdidas recuperables están en ${lista(g.salas, 4)}.` : "Brecha repartida en muchas salas.",
      accion: `Plan de ${peorRed.b.plan.length} acciones sala × componente${peorRed.b.alcanza ? ` que lleva ${esc(z.zona)} a ${pct(peorRed.b.plan[peorRed.b.plan.length - 1].proyectado)}` : ""} (detalle en cada ficha).`,
      verif: "Componente sobre 90% en la medición RED siguiente de cada sala del plan.",
    });
  }
  const presMal = ps.filter((p) => p.tipo === "presentismo");
  if (presMal.length) {
    const h = presMal.reduce((a, p) => a + (extras.horas.get(p.sala.sala_id)?.falta ?? 0), 0);
    prioridades.push({
      t: "Cobertura de horas en sala",
      dato: `${presMal.length} salas con presentismo en prioridad; faltaron ${nf(h, 0)} h en la semana.`,
      problema: `Las de mayor déficit: ${lista([...presMal].sort((a, b) => b.orden - a.orden).map((p) => `${p.sala.nombre} (${nf(p.orden, 0)} h)`), 3)}.`,
      accion: "Revisar marcas de los días críticos y cubrir con volante o reemplazo donde falte dotación.",
      verif: "Horas cumplidas ≥ objetivo en la semana siguiente.",
    });
  }
  const vpAlta = ps.filter((p) => p.tipo === "venta_perdida" && p.prioridad === "Alta");
  if (z.cadem.total) {
    const c1 = z.cadem.causas[0];
    const esc7 = vpAlta.flatMap((p) => p.sinStockLargo ?? []);
    prioridades.push({
      t: "Quiebres con venta perdida",
      dato: `${clp(z.cadem.total)} reportados; ${Math.round(c1.pct * 100)}% "${c1.label.toLowerCase()}".`,
      problema: esc7.length ? `${esc7.length} SKU sin stock 7 días o más: ${lista(esc7.map((r) => `${r.sku} en ${r.sala}`), 2)}.` : `${vpAlta.length} salas con monto alto.`,
      accion: esc7.length ? "Escalar abastecimiento de esos SKU con Embonor y la cadena; en el resto, reponer o ajustar inventario según la causa." : "Reponer o ajustar inventario según la causa registrada.",
      verif: "SKU fuera del reporte de quiebres Datawalt siguiente.",
    });
  }

  // Salas críticas: las que suman más problemas de prioridad alta.
  const porSala = new Map();
  for (const p of ps) {
    const x = porSala.get(p.sala.sala_id) ?? { sala: p.sala, altas: [], medias: [] };
    (p.prioridad === "Alta" ? x.altas : x.medias).push(p);
    porSala.set(p.sala.sala_id, x);
  }
  const criticas = [...porSala.values()].filter((x) => x.altas.length).sort((a, b) => b.altas.length - a.altas.length || b.medias.length - a.medias.length).slice(0, 6);
  const supNombre = (s) => z.supervisores.find((g) => g.salas.some((x) => x.sala_id === s.sala_id))?.nombre ?? "Sin supervisor";

  // Decisiones para gerencia.
  const decisiones = [];
  const sinStock = ps.flatMap((p) => p.sinStockLargo ?? []);
  if (sinStock.length) decisiones.push(`<b>Escalar abastecimiento</b> con Embonor y la cadena: ${sinStock.length} SKU sin stock 7 días o más (${clp(sinStock.reduce((a, r) => a + r.vp, 0))} reportados). ${lista(sinStock.map((r) => `${esc(r.sku)} en ${esc(r.sala)}, ${r.dias} d`), 3)}.`);
  const bajo80 = z.salasZona.filter((s) => (z.porSala.get(s.sala_id).pres3 ?? 1) < 0.8);
  if (bajo80.length) decisiones.push(`<b>Decidir cobertura de dotación</b> en ${bajo80.length} salas con presentismo bajo 80% en 3 semanas: ${lista(bajo80.map((s) => esc(s.nombre)), 4)}.`);
  const sinRed = sinCargaRed(datos, z).faltaEstaSemana;
  if (sinRed.length) decisiones.push(`<b>Pedir la carga RED</b> de ${sinRed.length} salas que tenían medición las semanas anteriores y esta no (${lista(sinRed.map((s) => esc(s.nombre)), 4)}): no se pueden evaluar.`);
  if (peorRed) {
    const sup = [...z.supervisores].filter((s) => s.id !== "sin").sort((a, b) => (b.aporte[peorRed.c.key] ?? 0) - (a.aporte[peorRed.c.key] ?? 0))[0];
    if (sup?.aporte[peorRed.c.key] > 0.02) decisiones.push(`<b>Revisar el plan de ${esc(sup.nombre)}</b> en reunión 1:1: concentra ${pts(sup.aporte[peorRed.c.key])} pts de la brecha RED ${peorRed.c.label} de la zona.`);
  }

  return `<section class="pag resumen">
    ${cab(`${esc(z.zona)} · Informe semanal de gestión`, "Resumen ejecutivo", `Semana ${sem[2]} (${rango})<br>Presentismo: S${sem[0]}–S${sem[2]} · emitido ${fechaCorta(datos.emitido)}`)}
    <h2>Indicadores contra meta</h2>
    ${tablaIndicadores(z.ind, metas, sem, z.cadem, z.salasZona.length)}
    <h2>Lo más relevante de la semana</h2>
    <ul class="limpia">${relevantes.map((r) => `<li>${tag("dato")}${r}</li>`).join("")}</ul>
    <h2>Tres prioridades operativas</h2>
    <div class="prioridades">${prioridades.slice(0, 3).map((p, i) => `<div class="pcard"><h3>${i + 1}. ${p.t}</h3>
      <p>${tag("dato")}${p.dato}</p><p><b>Problema:</b> ${p.problema}</p><p>${tag("acc")}${p.accion}</p><p class="x"><b>Se verifica con:</b> ${p.verif}</p></div>`).join("")}</div>
    <h2>Salas críticas</h2>
    <table class="compacta"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th class="l">Problemas de prioridad alta</th><th>Otros</th></tr>
      ${criticas.map((x) => `<tr><td class="l b">${esc(x.sala.nombre)}</td><td class="l">${esc(supNombre(x.sala))}</td>
        <td class="l">${x.altas.map((p) => esc(p.problema)).join(" · ")}</td><td>${x.medias.length || "–"}</td></tr>`).join("")}
    </table>
    <h2>Decisiones y escalamientos para gerencia</h2>
    ${decisiones.length ? `<ul class="limpia">${decisiones.map((d) => `<li>${tag("acc")}${d}</li>`).join("")}</ul>` : `<p class="vacio">Sin escalamientos esta semana.</p>`}
  </section>`;
}

// ---------------------------------------------------------------- página 2

function paginaRanking(z, extras) {
  const ps = extras.problemas;
  const altas = ps.filter((p) => p.prioridad === "Alta");
  const medias = ps.filter((p) => p.prioridad === "Media");
  const mostrar = [...altas, ...medias.slice(0, Math.max(0, 28 - altas.length))];
  const resultado = (p) => p.tipo === "venta_perdida" ? "—" : `${pct(p.valor)} / ${pct(p.meta, 0)}`;

  // Por supervisor; dentro de cada uno, por sala (primero las de más
  // problemas altos) y, en cada sala, lo de prioridad alta primero.
  const elegidos = new Set(mostrar);
  const grupos = z.supervisores.map((sup) => {
    const ids = new Set(sup.salas.map((s) => s.sala_id));
    const filas = ps.filter((p) => elegidos.has(p) && ids.has(p.sala.sala_id));
    const porSala = new Map();
    for (const p of filas) {
      if (!porSala.has(p.sala.sala_id)) porSala.set(p.sala.sala_id, []);
      porSala.get(p.sala.sala_id).push(p);
    }
    const altasDe = (l) => l.filter((p) => p.prioridad === "Alta").length;
    const salas = [...porSala.values()]
      .map((l) => l.sort((a, b) => (a.prioridad === "Alta" ? 0 : 1) - (b.prioridad === "Alta" ? 0 : 1)))
      .sort((a, b) => altasDe(b) - altasDe(a) || b.length - a.length || a[0].sala.nombre.localeCompare(b[0].sala.nombre, "es"));
    return { sup, salas, altas: filas.filter((p) => p.prioridad === "Alta").length, n: filas.length };
  }).filter((g) => g.n);

  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Ranking de intervención por sala`, "Dónde actuar primero, por supervisor", `${altas.length} problemas de prioridad alta<br>${medias.length} de prioridad media`)}
    <table class="compacta ranking">
      <tr><th class="l">Sala</th><th>Prioridad</th><th class="l">Problema</th><th>Resultado / meta</th><th class="r">Monto</th><th>Persiste</th><th class="l">Acción inicial</th></tr>
      ${grupos.map((g, gi) => `${gi ? `<tr class="espacio"><td colspan="7"></td></tr>` : ""}<tr class="grupo"><td colspan="7">${esc(g.sup.nombre)} <span class="x">· ${g.salas.length} sala${g.salas.length === 1 ? "" : "s"} · ${g.altas} alta${g.altas === 1 ? "" : "s"}${g.n > g.altas ? ` · ${g.n - g.altas} media${g.n - g.altas === 1 ? "" : "s"}` : ""}</span></td></tr>
        ${g.salas.map((l) => l.map((p, i) => `<tr${i === 0 ? ` class="sala-ini"` : ""}>${i === 0 ? `<td class="l b sala-nombre" rowspan="${l.length}">${esc(p.sala.nombre)}</td>` : ""}<td>${prioTag(p.prioridad)}</td>
          <td class="l">${esc(p.detalle)}</td><td>${resultado(p)}</td><td class="r">${p.tipo === "venta_perdida" ? clp(p.valor) : "—"}</td>
          <td>${p.persistente ? "Sí" : "–"}</td><td class="l">${esc(p.corto)}</td></tr>`).join("")).join("")}`).join("")}
    </table>
    ${medias.length + altas.length > mostrar.length ? `<p class="nota">Y ${altas.length + medias.length - mostrar.length} problemas más de prioridad media: están en las fichas de cada supervisor y en la matriz de compromisos.</p>` : ""}
    <div class="criterio">${tag("prop")}<b>Criterio de prioridad (propuesto, no viene de la medición).</b> Se clasifica cada tipo de problema por separado, sin sumar indicadores distintos.
      <b>RED</b> por categoría: alta si la categoría está bajo 75% o a 20 pp o más de la meta; media si está a 10 pp o más.
      <b>Presentismo:</b> alta si lleva 3 semanas bajo 80%; media si la semana quedó bajo meta con 8 h o más faltantes.
      <b>Venta perdida:</b> alta si la sala reporta $50.000 o más, o algún SKU lleva 7 días o más sin stock; media si reporta $15.000 o más o algún SKU lleva 7 días o más sin venta.
      <b>Persiste:</b> RED bajo meta también la semana anterior; presentismo bajo meta en 2 de las 3 últimas semanas; venta perdida con SKU de 7 días o más sin venta.
      Dentro de cada supervisor van primero las salas con más problemas altos.</div>
  </section>`;
}

// ---------------------------------------------------------------- fichas

function bloqueProblema(p, datos) {
  return `<div class="prob">
    <div class="titulo">${prioTag(p.prioridad)} ${esc(p.problema)}</div>
    <div class="k">${tag("dato")}</div><div>${esc(p.dato)}</div>
    <div class="k">${tag("hip")}</div><div>${esc(p.hipotesis)}</div>
    <div class="k">${tag("acc")}</div><div>${esc(p.accion)}</div>
    <div class="k">Evidencia de cierre</div><div>${esc(p.evidencia)}</div>
    <div class="k">Resultado esperado</div><div>${esc(p.esperado)}</div>
    <div class="k">Plazo ${tag("prop")}</div><div>${fechaCorta(plazo(datos, p.prioridad))}</div>
  </div>`;
}

function fichaSupervisor(s, datos, z, extras) {
  const { metas, sem } = z;
  const ids = new Set(s.salas.map((x) => x.sala_id));
  const ps = extras.problemas.filter((p) => ids.has(p.sala.sala_id));
  const altas = ps.filter((p) => p.prioridad === "Alta").length;

  // Principales problemas (hechos).
  const principales = [];
  for (const c of RED) {
    const b = s.brechas[c.key];
    if (!b || b.falta <= 0) continue;
    const k = b.componentes[0];
    const salasAlta = ps.filter((p) => p.tipo === "red" && p.cat === c.label && p.prioridad === "Alta").map((p) => p.sala.nombre);
    principales.push(`RED ${c.label} ${pct(b.promedio)} (${brechaTxt(b.promedio, b.meta)}). ${CORTO[k.label] ?? k.label} resta ${pts(k.pierde)} pts (nota ${pct(k.nota, 0)}).${salasAlta.length ? ` Prioridad alta en ${lista(salasAlta, 4)}.` : ""}`);
  }
  for (const p of PRES) {
    const v = s.ind[2][p.key];
    if (v == null || v >= metas.presentismo) continue;
    const hs = s.horas.filter((h) => z.porSala.get(h.sala_id)?.presTipo === p.key && h.falta >= 0.5);
    principales.push(`${p.label} ${pct(v)} (${brechaTxt(v, metas.presentismo)}): faltaron ${nf(hs.reduce((a, h) => a + h.falta, 0), 0)} h en ${hs.length} salas.`);
  }
  if (s.cadem.total) {
    const c1 = s.cadem.causas[0];
    principales.push(`Venta perdida ${clp(s.cadem.total)} en ${s.cadem.salas.length} salas; ${Math.round(c1.pct * 100)}% "${c1.label.toLowerCase()}". Mayor: ${esc(s.cadem.salas[0].nombre)} (${clp(s.cadem.salas[0].total)}).`);
  }

  // Salas a intervenir: las de más problemas altos (máx. 5), con hasta 3 problemas.
  const porSala = new Map();
  for (const p of ps) {
    if (!porSala.has(p.sala.sala_id)) porSala.set(p.sala.sala_id, []);
    porSala.get(p.sala.sala_id).push(p);
  }
  const salasPrio = [...porSala.values()].sort((a, b) => b.filter((p) => p.prioridad === "Alta").length - a.filter((p) => p.prioridad === "Alta").length || b.length - a.length).slice(0, 5);

  // Prioridades de la semana (máx. 3).
  const prios = [];
  const peor = RED.map((c) => ({ c, b: s.brechas[c.key] })).filter((x) => x.b && x.b.falta > 0).sort((a, b) => b.b.falta - a.b.falta)[0];
  if (peor) {
    const g = grupoPlan(peor.b);
    prios.push(`${tag("acc")}<b>RED ${peor.c.label}:</b> ${g ? `llevar ${CORTO[g.comp] ?? g.comp} a 100% en ${lista([...new Set(g.salas)], 4)} (suma +${pts(g.sube)} pts). ` : ""}El plan completo son ${peor.b.plan.length} acciones${peor.b.alcanza ? ` y deja al supervisor en ${pct(peor.b.plan[peor.b.plan.length - 1].proyectado)}` : `; ni con todo a 100% llega (máximo ${pct(peor.b.maximo)})`}. <span class="x">Verificación: medición RED siguiente.</span>`);
  }
  const pres = ps.filter((p) => p.tipo === "presentismo").sort((a, b) => b.orden - a.orden);
  if (pres.length) prios.push(`${tag("acc")}<b>Presentismo:</b> cubrir ${nf(pres.reduce((a, p) => a + p.orden, 0), 0)} h faltantes, empezando por ${lista(pres.map((p) => `${p.sala.nombre} (${nf(p.orden, 0)} h)`), 3)}. <span class="x">Verificación: horas cumplidas la semana siguiente.</span>`);
  const vp = ps.filter((p) => p.tipo === "venta_perdida").sort((a, b) => b.orden - a.orden);
  if (vp.length) prios.push(`${tag("acc")}<b>Venta perdida:</b> ${esc(vp[0].sala.nombre)} (${clp(vp[0].orden)}): ${esc(vp[0].accion.split(/(?<=\.)\s/)[0])} <span class="x">Verificación: reporte Datawalt siguiente.</span>`);

  return `<section class="pag">
    ${cab(esc(s.nombre), `Supervisor · Subzona ${esc(s.subzona ?? "–")} · ${s.salas.length} salas`, `${altas} problemas de prioridad alta · ${ps.length - altas} media<br>Semana ${sem[2]}`)}
    <h2>1. Diagnóstico</h2>
    ${tablaIndicadores(s.ind, metas, sem, s.cadem, s.salas.length)}
    <h2>2. Principales problemas</h2>
    ${principales.length ? `<ul class="limpia">${principales.map((x) => `<li>${tag("dato")}${x}</li>`).join("")}</ul>` : `<p class="vacio">Todos los indicadores en meta.</p>`}
    <h2>3. Prioridades de la semana</h2>
    ${prios.length ? `<ul class="limpia">${prios.slice(0, 3).map((x) => `<li>${x}</li>`).join("")}</ul>` : `<p class="vacio">Sin prioridades: mantener.</p>`}
    <h2>4. Acciones por sala</h2>
    ${salasPrio.map((lst) => `<div class="bloque-sala"><div class="tit"><span>${esc(lst[0].sala.nombre)}</span><span>${lst.map((p) => prioTag(p.prioridad)).join(" ")}</span></div>
      ${lst.slice(0, 3).map((p) => bloqueProblema(p, datos)).join("")}</div>`).join("") || `<p class="vacio">Sin salas con problemas de prioridad alta o media.</p>`}
    ${porSala.size > salasPrio.length ? `<p class="nota">Y ${porSala.size - salasPrio.length} salas más con problemas de prioridad media: ver matriz de compromisos.</p>` : ""}
  </section>`;
}

// ---------------------------------------------------------------- venta perdida

function paginasVentaPerdida(z, extras) {
  const cadem = z.cadem;
  if (!cadem.total) return `<section class="pag">${cab(`${esc(z.zona)} · Venta perdida y quiebres`, "Datawalt · Causas del quiebre", "")}
    <p>${tag("falta")}No hay datos de causas de quiebre cargados para la semana ${z.sem[2]}.</p></section>`;
  const supDe = (salaId) => z.supervisores.find((g) => g.salas.some((x) => x.sala_id === salaId))?.nombre ?? "–";
  const porSup = z.supervisores.filter((s) => s.cadem.total).map((s) => ({ label: s.nombre, valor: s.cadem.total })).sort((a, b) => b.valor - a.valor);
  const causasPresentes = [...new Set(cadem.filas.map((r) => r.causa))];
  const porCausa = new Map();
  for (const r of cadem.filas) porCausa.set(r.causa, (porCausa.get(r.causa) ?? 0) + r.vp);
  const escalar = cadem.filas.filter((r) => (r.causa === "SIN STOCK" && (r.dias ?? 0) >= 7) || (r.causa === "STOCK ESTATICO" && (r.dias ?? 0) >= 14))
    .sort((a, b) => b.vp - a.vp);

  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Venta perdida y quiebres`, `Datawalt · Causas del quiebre · Semana ${z.sem[2]}`, `${clp(cadem.total)} reportados<br>${cadem.salas.length} de ${z.salasZona.length} salas con datos`)}
    <p class="linea">${tag("dato")}El monto es <b>venta perdida reportada</b> por Datawalt. Corregir un quiebre no recupera automáticamente todo el monto: es el techo de lo recuperable. ${tag("falta")}Las ${z.salasZona.length - cadem.salas.length} salas sin datos de quiebre no están en cero; el reporte solo trae las que tuvieron quiebre medido.</p>
    <div class="dos-col">
      <div><h2>Por supervisor</h2>${barras(porSup, { fmt: clp, ancho: 340 })}</div>
      <div><h2>Por causa registrada</h2>${barras([...porCausa].map(([c, v]) => ({ label: causaLabelCorta(c), valor: v })).sort((a, b) => b.valor - a.valor), { fmt: clp, color: "#6b7280", ancho: 340 })}</div>
    </div>
    <h2>Ranking de salas por monto</h2>
    <table class="compacta"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th class="r">Venta perdida</th><th>SKU</th><th class="l">Causa principal</th><th>Máx. días sin venta</th><th class="l">Acción</th></tr>
      ${cadem.salas.slice(0, 15).map((s) => {
        const pc = new Map(); for (const r of s.filas) pc.set(r.causa, (pc.get(r.causa) ?? 0) + r.vp);
        const [causa] = [...pc].sort((a, b) => b[1] - a[1])[0];
        const maxD = Math.max(...s.filas.map((r) => r.dias ?? 0));
        return `<tr><td class="l b">${esc(s.nombre)}</td><td class="l">${esc(supDe(s.salaId))}</td><td class="r">${clp(s.total)}</td><td>${s.n}</td>
          <td class="l">${causaLabelCorta(causa)}</td><td class="${maxD >= 7 ? "bad" : ""}">${maxD}</td><td class="l">${guiaCausa(causa).corto}</td></tr>`;
      }).join("")}</table>
    <h2>SKU más afectados</h2>
    <table class="compacta"><tr><th class="l">SKU</th><th class="r">Venta perdida</th><th>Salas</th><th class="l">Causas registradas</th><th>Máx. días sin venta</th></tr>
      ${cadem.skus.slice(0, 10).map((k) => {
        const fs = cadem.filas.filter((r) => r.sku === k.sku);
        return `<tr><td class="l b">${esc(k.sku)}</td><td class="r">${clp(k.vp)}</td><td>${k.nSalas}</td>
          <td class="l">${[...new Set(fs.map((r) => causaLabelCorta(r.causa)))].join(", ")}</td><td>${Math.max(...fs.map((r) => r.dias ?? 0))}</td></tr>`;
      }).join("")}</table>
  </section>
  <section class="pag">
    ${cab(`${esc(z.zona)} · Quiebres: de la causa registrada a la causa raíz`, "Qué validar, qué hacer y a quién escalar", "")}
    <h2>Causa registrada vs. causa raíz</h2>
    <p class="linea">${tag("hip")}La causa que informa Datawalt sale del sistema de la cadena; la causa raíz se confirma en sala antes de actuar.</p>
    <table class="compacta"><tr><th class="l">Causa registrada</th><th class="r">Monto</th><th class="l">Validar antes de actuar</th><th class="l">Acción</th><th class="l">Escalar a</th><th class="l">Verificación</th></tr>
      ${causasPresentes.sort((a, b) => porCausa.get(b) - porCausa.get(a)).map((c) => { const g = guiaCausa(c); return `<tr><td class="l b">${causaLabelCorta(c)}</td><td class="r">${clp(porCausa.get(c))}</td>
        <td class="l">${esc(g.validar)}</td><td class="l">${esc(g.acc)}</td><td class="l">${esc(g.escalar)}</td><td class="l">${esc(g.verif)}</td></tr>`; }).join("")}
    </table>
    <h2>Problemas que requieren escalamiento</h2>
    ${escalar.length ? `<table class="compacta"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th class="l">SKU</th><th class="l">Causa</th><th>Días sin venta</th><th class="r">Venta perdida</th><th class="l">Escalar a</th></tr>
      ${escalar.map((r) => `<tr><td class="l b">${esc(r.sala)}</td><td class="l">${esc(supDe(r.salaId))}</td><td class="l">${esc(r.sku)}</td><td class="l">${causaLabelCorta(r.causa)}</td>
        <td class="bad">${r.dias}</td><td class="r">${clp(r.vp)}</td><td class="l">${esc(guiaCausa(r.causa).escalar)}</td></tr>`).join("")}</table>
      <p class="nota">Se escala: sin stock 7 días o más, y stock estático 14 días o más.</p>` : `<p class="vacio">Ningún SKU cumple el criterio de escalamiento esta semana.</p>`}
    <h2>Secuencia de revisión cuando hay un problema de stock</h2>
    <ol class="secuencia">${SECUENCIA_STOCK.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
    <p class="nota">La secuencia no supone la causa: cada paso descarta o confirma una. No se atribuye una causa a una sala sin la evidencia del paso correspondiente.</p>
  </section>`;
}

// ---------------------------------------------------------------- seguimiento

function paginasSeguimiento(datos, z, extras) {
  const sigSemana = z.sem[2] + 1;
  const supDe = (salaId) => z.supervisores.find((g) => g.salas.some((x) => x.sala_id === salaId))?.nombre ?? "–";
  const salaDe = (salaId) => z.salasZona.find((s) => s.sala_id === salaId)?.nombre ?? "–";
  const previos = extras.previos;
  const corto = (t) => esc(String(t).split(/(?<=\.)\s/)[0]);

  const tablaPrevios = previos.length ? `<table class="compacta"><tr><th class="l">Supervisor</th><th class="l">Sala</th><th class="l">Problema</th><th class="l">Acción comprometida</th><th>Plazo</th><th>Estado</th><th class="l">Resultado medido</th><th class="l">Próximo paso</th></tr>
      ${previos.sort((a, b) => supDe(a.sala_id).localeCompare(supDe(b.sala_id), "es")).map((c) => {
        const mejoro = /^Mejoró/.test(c.resultado);
        const siguiente = c.estado === "Resuelto con evidencia" ? "Cerrar" : mejoro ? "Pedir evidencia para cerrar" : /Sin dato/.test(c.resultado) ? "Pedir el dato" : "Mantener; escalar si se repite";
        return `<tr><td class="l">${esc(supDe(c.sala_id))}</td><td class="l b">${esc(salaDe(c.sala_id))}</td><td class="l">${esc(c.problema)}</td><td class="l">${corto(c.accion)}</td>
          <td>${c.plazo ? fechaCorta(new Date(c.plazo + "T12:00:00Z")) : "–"}</td><td>${esc(c.estado)}</td>
          <td class="l ${mejoro ? "okt" : /Empeoró/.test(c.resultado) ? "b" : ""}">${esc(c.resultado)}</td><td class="l">${siguiente}</td></tr>`;
      }).join("")}</table>`
    : `<p class="linea">${tag("falta")}No hay compromisos registrados de la semana ${z.sem[1]}: este es el primer informe con matriz de compromisos. Su resultado se medirá en el informe de la semana ${sigSemana}.</p>`;

  const actuales = [...extras.problemas].sort((a, b) => supDe(a.sala.sala_id).localeCompare(supDe(b.sala.sala_id), "es") || (a.prioridad === "Alta" ? -1 : 1));
  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Seguimiento de compromisos`, "Qué se comprometió, qué se hizo y qué mejoró", `Semana ${z.sem[2]}`)}
    <h2>Compromisos de la semana anterior (S${z.sem[1]})</h2>
    ${tablaPrevios}
    <p class="nota">El <b>resultado medido</b> compara el indicador de la sala con el valor que tenía cuando se propuso la acción. El <b>estado</b> lo registra el responsable; el informe no da por hecha ninguna acción sin evidencia.</p>
    <h2>Matriz de compromisos de esta semana (S${z.sem[2]})</h2>
    <table class="compacta"><tr><th class="l">Supervisor</th><th class="l">Sala</th><th>Prio.</th><th class="l">Problema</th><th class="l">Acción comprometida</th><th class="l">Responsable</th><th>Plazo</th><th>Estado</th><th class="l">Evidencia</th><th class="l">Resultado</th></tr>
      ${actuales.map((p) => `<tr><td class="l">${esc(supDe(p.sala.sala_id))}</td><td class="l b">${esc(p.sala.nombre)}</td><td>${prioTag(p.prioridad)}</td>
        <td class="l">${esc(p.detalle)}</td><td class="l">${corto(p.accion)}</td><td class="l">${esc(supDe(p.sala.sala_id))}</td>
        <td>${fechaCorta(plazo(datos, p.prioridad))}</td><td>Pendiente</td><td class="l">${esc(p.evidencia)}</td><td class="l">Se mide en S${sigSemana}</td></tr>`).join("")}
    </table>
    <p class="nota">${tag("prop")}Responsable y plazo son propuestas del informe. Estados posibles: Pendiente · En gestión · Resuelto con evidencia · Escalado · Pendiente de validación.</p>
  </section>`;
}

// ---------------------------------------------------------------- anexos

function paginasAnexos(datos, z, extras) {
  const { metas } = z;
  const supervisores = z.supervisores.filter((s) => s.id !== "sin");
  const faltantes = [];
  const { faltaEstaSemana, nunca } = sinCargaRed(datos, z);
  if (faltaEstaSemana.length) faltantes.push(`<b>${faltaEstaSemana.length} salas sin carga RED esta semana</b> que sí tenían las anteriores (${lista(faltaEstaSemana.map((s) => esc(s.nombre)), 6)}). Una sala sin carga no está en 0%: pedir la medición.`);
  if (nunca.length) faltantes.push(`<b>${nunca.length} salas sin medición RED</b> en las últimas 3 semanas: no se evalúan en RED (no aparecen en las brechas ni en el plan). Confirmar si deben estar en el programa de medición.`);
  faltantes.push(`<b>Venta perdida:</b> ${z.cadem.salas.length} de ${z.salasZona.length} salas con datos de quiebre en Datawalt. El reporte no trae las salas sin quiebre medido.`);
  faltantes.push(`<b>Causa raíz de quiebres:</b> la causa viene del sistema de la cadena; la confirmación en sala no está en los datos.`);
  faltantes.push(`<b>Presentismo:</b> se miden horas cumplidas contra objetivo; el motivo de la ausencia (licencia, vacante, falta de marca) no está en estos datos y debe validarse en GeoVictoria o con el supervisor.`);
  faltantes.push(`<b>RED NARTD por componente:</b> la descomposición en puntos es aproximada (la nota cargada no coincide exactamente con la suma ponderada de sus componentes, diferencia media de unos 2 pts); se escala a la nota real de cada sala. En ABI y VSR coincide exactamente.`);

  return `${supervisores.map((s) => `<section class="pag">
      ${cab(`Anexo A · ${esc(s.nombre)}`, "Salas foco: nota RED y componentes NARTD", `${s.foco.length} de ${s.salas.length} salas foco`)}
      ${matrizFoco(s.foco, z, metas)}
      <h2>Presentismo por sala · S${z.sem[2]}</h2>
      ${tablaHorasCompleta(s.horas)}
    </section>`).join("")}
    <section class="pag">
      ${cab(`Anexo B · ${esc(z.zona)}`, "Detalle de SKU con quiebre por sala", `Semana ${z.sem[2]}`)}
      ${z.cadem.total ? `<table class="compacta"><tr><th class="l">Supervisor</th><th class="l">Sala</th><th class="l">SKU</th><th class="l">Causa registrada</th><th>Días sin venta</th><th class="r">Venta perdida</th></tr>
        ${supervisores.flatMap((s) => s.cadem.salas.flatMap((sa) => sa.filas.sort((a, b) => b.vp - a.vp).map((r) => `<tr><td class="l">${esc(s.nombre)}</td><td class="l b">${esc(sa.nombre)}</td>
          <td class="l">${esc(r.sku)}</td><td class="l">${causaLabelCorta(r.causa)}</td><td class="${(r.dias ?? 0) >= 7 ? "bad" : ""}">${r.dias ?? "–"}</td><td class="r">${clp(r.vp)}</td></tr>`))).join("")}
      </table>` : `<p>${tag("falta")}Sin datos de quiebre esta semana.</p>`}
    </section>
    ${datos.incluirVisitas ? `<section class="pag">${cab(`Anexo C · ${esc(z.zona)}`, "Visitas registradas en la app con su análisis de IA", diaLargo(datos.ayer))}${seccionVisitas(z.visitas, datos.ayer)}</section>` : ""}
    <section class="pag">
      ${cab(`Anexo D · ${esc(z.zona)}`, "Información faltante y metodología", "")}
      <h2>Información faltante</h2>
      <ul class="limpia">${faltantes.map((f) => `<li>${tag("falta")}${f}</li>`).join("")}</ul>
      <h2>Metodología</h2>
      <ul class="limpia">
        <li><b>Metas:</b> RED NARTD ${pct(metas.red_nartd, 0)}, ABI ${pct(metas.red_abi, 0)}, VSR ${pct(metas.red_vsr, 0)}; presentismo ${pct(metas.presentismo, 0)}. Brechas en puntos porcentuales (pp).</li>
        <li><b>RED por grupo:</b> promedio simple de las salas con carga en la semana. <b>Puntos por componente:</b> lo que le falta a cada sala para 100% se reparte entre sus componentes según su peso (NARTD: NSS 20, SOVI 35, ICE 20, exhibición 12, NSF 5, catálogos 5, POP 3; ABI: 25 cada uno; VSR: NSS y catálogos 50).</li>
        <li><b>Plan a la meta:</b> acciones "llevar un componente de una sala a 100%", ordenadas por cuánto suben el promedio del grupo, acumuladas hasta la meta. Es el mínimo de acciones necesario, no una predicción.</li>
        <li><b>Presentismo:</b> WM sin Acuenta; SMU sin S10/Super 10. Horas cumplidas topadas al objetivo de cada día; días eximidos fuera del cálculo.</li>
        <li><b>Sala foco:</b> RED y presentismo fuera de meta a la vez, alguna categoría RED bajo 75% o presentismo de 3 semanas bajo 80%.</li>
        <li><b>Etiquetas:</b> ${tag("dato")}medido en los datos · ${tag("hip")}causa posible a validar · ${tag("acc")}medida propuesta · ${tag("falta")}dato que no está disponible · ${tag("prop")}criterio o plazo propuesto por el informe.</li>
      </ul>
    </section>`;
}

function tablaHorasCompleta(horas) {
  const con = horas.filter((h) => h.falta >= 0.5).sort((a, b) => b.falta - a.falta);
  if (!con.length) return `<p class="vacio">Todas las salas con objetivo de horas lo cumplieron.</p>`;
  return `<table class="compacta"><tr><th class="l">Sala</th><th>Objetivo</th><th>Cumplidas</th><th>Faltan</th><th class="l">Días bajo 75% (cumplidas/objetivo)</th></tr>
    ${con.map((h) => `<tr><td class="l b">${esc(h.nombre)}</td><td>${nf(h.obj, 0)} h</td><td>${nf(h.real, 0)} h</td><td class="bad">${nf(h.falta, 0)} h</td>
      <td class="l">${esc(h.criticos.join(" · ") || "Déficit repartido en la semana")}</td></tr>`).join("")}</table>`;
}

// ---------------------------------------------------------------- documento

export function htmlGestion(datos, z, extras) {
  const supervisores = z.supervisores.filter((s) => s.id !== "sin");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(z.zona)} · Informe semanal de gestión</title>
    <style>${CSS}${CSS_GESTION}</style></head><body>
    ${paginaResumen(datos, z, extras)}
    ${paginaRanking(z, extras)}
    ${supervisores.map((s) => fichaSupervisor(s, datos, z, extras)).join("")}
    ${paginasVentaPerdida(z, extras)}
    ${paginasSeguimiento(datos, z, extras)}
    ${paginasAnexos(datos, z, extras)}
  </body></html>`;
}
