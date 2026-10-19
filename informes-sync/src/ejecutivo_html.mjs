// Informe semanal EJECUTIVO por zona: 3 páginas para gerentes y subgerentes.
//   Pág. 1  Situación de la zona: indicadores contra meta, lectura de la semana
//           y decisiones que necesita de gerencia.
//   Pág. 2  Supervisores y salas críticas: dónde está la brecha y qué se hace.
//   Pág. 3  Venta perdida y quiebres, seguimiento de compromisos y vacíos de datos.
// Los mismos datos y reglas que el informe de gestión detallado (gestion.mjs);
// aquí solo se elige lo que decide un gerente. Los topes de filas garantizan
// que no pase de 3 páginas (aPdfEjecutivo lo verifica).
import { pct, clp, esc, nf, pts, diaMes, masDias, CSS, RED, PRES, CORTO, celda } from "./salas_foco.mjs";
import { pp, brechaTxt, fechaCorta, lista, causaLabelCorta, guiaCausa } from "./gestion.mjs";

const CSS_EJEC = `
  body { font-size: 10px; line-height: 1.4; }
  .pag { height: 267mm; overflow: hidden; }
  .cab h1 { font-size: 21px; } .cab { margin-bottom: 8px; }
  h2 { margin: 11px 0 5px; }
  .kpi td, .kpi th { padding: 4px 8px; font-size: 10.5px; }
  .lectura { margin: 0; padding-left: 16px; font-size: 10.8px; } .lectura li { margin: 4px 0; }
  .decide { border: 1px solid #fecaca; background: #fef2f2; border-radius: 5px; padding: 6px 12px; }
  .decide ol { margin: 0; padding-left: 18px; font-size: 10.8px; } .decide li { margin: 4px 0; }
  .prio { display: inline-block; font-size: 8.5px; font-weight: 700; padding: 1px 6px; border-radius: 3px; }
  .prio.Alta { background: #b91c1c; color: #fff; } .prio.Media { background: #f59e0b; color: #fff; }
  table.c td, table.c th { padding: 3px 5px; font-size: 9.3px; vertical-align: top; }
  .semaforo { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
  .semaforo.ok { background: #16a34a; } .semaforo.bad { background: #dc2626; } .semaforo.na { background: #9ca3af; }
  .tres { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .mini { border: 1px solid #e5e7eb; border-radius: 5px; padding: 6px 9px; background: #f9fafb; }
  .mini b.n { display: block; font-size: 19px; line-height: 1.2; } .mini span { color: #6b7280; font-size: 9px; }
  .pie { color: #6b7280; font-size: 8.5px; margin-top: 8px; border-top: 1px solid #e5e7eb; padding-top: 4px; }
  svg.barras { display: block; margin: 2px 0; }
`;

const cab = (t, s, d) => `<div class="cab"><div><h1>${t}</h1><div class="s">${s}</div></div><div class="d">${d}</div></div>`;
const prioTag = (p) => `<span class="prio ${p}">${p}</span>`;
const sem = (v, meta) => `<span class="semaforo ${v == null ? "na" : v >= meta ? "ok" : "bad"}"></span>`;
const flecha = (v, ant) => (v == null || ant == null ? "–" : Math.abs(v - ant) < 0.0005 ? "=" : `${v > ant ? "▲" : "▼"} ${pp(v - ant)}`);

function barras(items, { color = "#b91c1c", fmt = (v) => v, ancho = 330 } = {}) {
  const max = Math.max(...items.map((i) => i.valor), 0);
  if (!items.length || max <= 0) return "";
  const alto = 15, et = 118, h = items.length * (alto + 4);
  return `<svg class="barras" width="${ancho}" height="${h}" viewBox="0 0 ${ancho} ${h}">${items.map((it, i) => {
    const y = i * (alto + 4), w = Math.max(2, ((ancho - et - 62) * it.valor) / max);
    return `<text x="0" y="${y + 11}" font-size="9" fill="#374151">${esc(it.label)}</text><rect x="${et}" y="${y + 1}" width="${w}" height="${alto - 3}" rx="2" fill="${color}"/>
      <text x="${et + w + 5}" y="${y + 11}" font-size="9" fill="#1f2937">${esc(fmt(it.valor))}</text>`;
  }).join("")}</svg>`;
}

function sinCargaRed(datos, z) {
  const tiene = (filas, id) => { const r = filas.find((x) => x.sala_id === id); return !!r && RED.some((c) => r[`red_${c.key}`] != null); };
  const sinAhora = z.salasZona.filter((s) => RED.every((c) => z.porSala.get(s.sala_id).red[c.key] == null));
  return sinAhora.filter((s) => tiene(datos.filasSem[1], s.sala_id) || tiene(datos.filasSem[0], s.sala_id));
}

// ---------------------------------------------------------------- página 1

function pagina1(datos, z, extras) {
  const { metas, sem: sm } = z;
  const [a, b, w] = z.ind;
  const rango = `${diaMes(datos.lunes)}–${diaMes(masDias(datos.lunes, 6))}`;
  const ps = extras.problemas;

  const filaPct = (label, k, meta, serie) => {
    if (w[k] == null && b[k] == null) return "";
    return `<tr><td class="l b">${sem(w[k], meta)}${label}</td>${celda(w[k], meta)}<td>${pct(meta, 0)}</td><td class="${w[k] != null && w[k] < meta ? "b" : ""}">${brechaTxt(w[k], meta)}</td>
      <td>${flecha(w[k], b[k])}</td><td class="l x">${serie ? `S${sm[0]} ${pct(a[k], 0)} · S${sm[1]} ${pct(b[k], 0)} · S${sm[2]} ${pct(w[k], 0)}` : ""}</td></tr>`;
  };
  const tabla = `<table class="kpi"><tr><th class="l">Indicador</th><th>S${sm[2]}</th><th>Meta</th><th>Brecha</th><th>vs S${sm[1]}</th><th class="l">Últimas 3 semanas</th></tr>
    ${RED.map((c) => filaPct(`RED ${c.label}`, c.key, metas[c.meta], false)).join("")}
    ${PRES.map((p) => filaPct(p.label, p.key, metas.presentismo, true)).join("")}
    <tr><td class="l b"><span class="semaforo na"></span>Venta perdida Cadem</td><td class="b">${clp(z.cadem.total)}</td><td>—</td><td>—</td><td>—</td><td class="l x">${z.cadem.salas.length} de ${z.salasZona.length} salas con quiebre medido</td></tr></table>`;

  // Lectura: hechos medidos, máximo 4.
  const lectura = [];
  const peorRed = RED.map((c) => ({ c, b: z.brechas[c.key] })).filter((x) => x.b && x.b.falta > 0).sort((p, q) => q.b.falta - p.b.falta)[0];
  if (peorRed) {
    const k = peorRed.b.componentes[0];
    lectura.push(`<b>RED ${peorRed.c.label} es la mayor brecha:</b> ${pct(peorRed.b.promedio)} contra meta ${pct(peorRed.b.meta, 0)}. El componente que más resta es ${CORTO[k.label] ?? k.label} (${pts(k.pierde)} pts).`
      + (peorRed.b.alcanza ? ` Con ${peorRed.b.plan.length} acciones sala×componente la zona llega a ${pct(peorRed.b.plan[peorRed.b.plan.length - 1].proyectado)}.` : ""));
    const sup = [...z.supervisores].filter((s) => s.id !== "sin").sort((p, q) => (q.aporte[peorRed.c.key] ?? 0) - (p.aporte[peorRed.c.key] ?? 0))[0];
    if (sup?.aporte[peorRed.c.key] > 0.02) lectura.push(`<b>${esc(sup.nombre)} concentra la brecha RED ${peorRed.c.label}:</b> ${pts(sup.aporte[peorRed.c.key])} pts de lo que le falta a la zona.`);
  } else lectura.push("<b>RED en meta</b> en todas las categorías medidas.");
  for (const p of PRES) {
    const v = w[p.key];
    if (v == null || v >= metas.presentismo) continue;
    const salasP = z.salasZona.filter((s) => z.porSala.get(s.sala_id).presTipo === p.key);
    const falta = salasP.map((s) => extras.horas.get(s.sala_id)).filter(Boolean).reduce((x, h) => x + Math.max(0, h.falta), 0);
    const bajo80 = salasP.filter((s) => (z.porSala.get(s.sala_id).pres3 ?? 1) < 0.8).length;
    lectura.push(`<b>${p.label} ${pct(v)}</b> (${brechaTxt(v, metas.presentismo)}): faltaron ${nf(falta, 0)} h; ${bajo80} sala${bajo80 === 1 ? "" : "s"} bajo 80% en 3 semanas.`);
  }
  if (z.cadem.total) {
    const c1 = z.cadem.causas[0];
    lectura.push(`<b>Venta perdida ${clp(z.cadem.total)}:</b> ${Math.round(c1.pct * 100)}% registrada como "${c1.label.toLowerCase()}". Mayor monto en ${esc(z.cadem.salas[0].nombre)} (${clp(z.cadem.salas[0].total)}).`);
  }

  // Decisiones (qué necesita de gerencia).
  const dec = [];
  const sinStock = ps.flatMap((p) => p.sinStockLargo ?? []);
  if (sinStock.length) dec.push(`<b>Escalar abastecimiento con Embonor y la cadena:</b> ${sinStock.length} SKU llevan 7 días o más sin stock (${clp(sinStock.reduce((x, r) => x + r.vp, 0))} reportados). ${lista(sinStock.map((r) => `${esc(r.sku)} en ${esc(r.sala)}`), 3)}.`);
  const bajo80 = z.salasZona.filter((s) => (z.porSala.get(s.sala_id).pres3 ?? 1) < 0.8);
  if (bajo80.length) dec.push(`<b>Resolver cobertura de dotación</b> en ${bajo80.length} salas con presentismo bajo 80% tres semanas seguidas: ${lista(bajo80.map((s) => esc(s.nombre)), 4)}.`);
  const sinRed = sinCargaRed(datos, z);
  if (sinRed.length) dec.push(`<b>Exigir la medición RED</b> de ${sinRed.length} salas que la tenían antes y esta semana no: ${lista(sinRed.map((s) => esc(s.nombre)), 4)}.`);
  if (peorRed) {
    const g = peorRed.b.plan.length;
    dec.push(`<b>Respaldar el plan RED ${peorRed.c.label}</b>: ${g} acciones sala×componente; verificación en la medición siguiente.`);
  }

  const altas = ps.filter((p) => p.prioridad === "Alta").length, medias = ps.length - altas;
  const salasAlta = new Set(ps.filter((p) => p.prioridad === "Alta").map((p) => p.sala.sala_id)).size;
  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Informe semanal de gestión`, "Resumen ejecutivo", `Semana ${sm[2]} (${rango})<br>Emitido ${fechaCorta(datos.emitido)}`)}
    <h2>Indicadores contra meta</h2>${tabla}
    <div class="tres" style="margin-top:9px">
      <div class="mini"><b class="n">${z.salasZona.length}</b><span>salas en la zona · ${z.supervisores.filter((s) => s.id !== "sin").length} supervisores</span></div>
      <div class="mini"><b class="n" style="color:#b91c1c">${salasAlta}</b><span>salas con algún problema de prioridad alta (${altas} problemas)</span></div>
      <div class="mini"><b class="n">${z.foco.length}</b><span>salas foco (RED y presentismo fuera de meta a la vez) · ${medias} problemas de prioridad media</span></div>
    </div>
    <h2>Lectura de la semana</h2>
    <ul class="lectura">${lectura.slice(0, 5).map((l) => `<li>${l}</li>`).join("")}</ul>
    <h2>Lo que necesitamos de gerencia</h2>
    ${dec.length ? `<div class="decide"><ol>${dec.slice(0, 4).map((d) => `<li>${d}</li>`).join("")}</ol></div>` : `<p class="x">Sin escalamientos esta semana.</p>`}
    <p class="pie">Metas: RED NARTD ${pct(metas.red_nartd, 0)}, ABI ${pct(metas.red_abi, 0)}, VSR ${pct(metas.red_vsr, 0)}; presentismo ${pct(metas.presentismo, 0)} (S${sm[0]}–S${sm[2]}). Presentismo WM sin Acuenta y SMU sin S10/Super 10, horas topadas al objetivo diario. El detalle por supervisor y sala está en el portal.</p>
  </section>`;
}

// ---------------------------------------------------------------- página 2

function pagina2(datos, z, extras) {
  const { metas, sem: sm } = z;
  const ps = extras.problemas;
  const supNombre = (id) => z.supervisores.find((g) => g.salas.some((x) => x.sala_id === id))?.nombre ?? "Sin supervisor";
  const horasSup = (s) => s.horas.reduce((x, h) => x + Math.max(0, h.falta), 0);

  const filaSup = (s) => {
    const ids = new Set(s.salas.map((x) => x.sala_id));
    const mios = ps.filter((p) => ids.has(p.sala.sala_id));
    const al = mios.filter((p) => p.prioridad === "Alta").length;
    const celdaRed = (c) => { const v = s.ind[2][c.key], ap = s.aporte[c.key]; return `<td class="${v == null ? "na" : v >= metas[c.meta] ? "ok" : "bad"}">${pct(v)}${ap > 0.0005 ? `<span class="x"> −${pts(ap)}</span>` : ""}</td>`; };
    const presV = PRES.map((p) => s.ind[2][p.key]).find((v) => v != null);
    return `<tr><td class="l b">${esc(s.nombre)}</td><td>${s.salas.length}</td>${RED.map(celdaRed).join("")}
      <td class="${presV == null ? "na" : presV >= metas.presentismo ? "ok" : "bad"}">${pct(presV)}</td>
      <td>${horasSup(s) >= 0.5 ? `${nf(horasSup(s), 0)} h` : "–"}</td><td class="r">${s.cadem.total ? clp(s.cadem.total) : "–"}</td>
      <td class="b ${al ? "bad" : ""}">${al || "–"}</td><td>${s.foco.length}</td></tr>`;
  };

  // Salas críticas: las de más problemas altos; una línea por sala con sus problemas y la acción inicial.
  const porSala = new Map();
  for (const p of ps) {
    const x = porSala.get(p.sala.sala_id) ?? { sala: p.sala, altas: [], medias: [] };
    (p.prioridad === "Alta" ? x.altas : x.medias).push(p);
    porSala.set(p.sala.sala_id, x);
  }
  const criticas = [...porSala.values()].filter((x) => x.altas.length)
    .sort((a, b) => b.altas.length - a.altas.length || b.medias.length - a.medias.length || a.sala.nombre.localeCompare(b.sala.nombre, "es")).slice(0, 10);
  const accion = (x) => [...new Set(x.altas.map((p) => p.corto))].slice(0, 2).join("; ");
  const restantes = [...porSala.values()].filter((x) => x.altas.length).length - criticas.length;

  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Supervisores y salas críticas`, "Dónde está la brecha y dónde actuar primero", `Semana ${sm[2]}`)}
    <h2>Resultado por supervisor</h2>
    <table class="c"><tr><th class="l">Supervisor</th><th>Salas</th>${RED.map((c) => `<th>${c.label}</th>`).join("")}<th>Pres.</th><th>Horas faltantes</th><th class="r">Vta. perdida</th><th>Prob. altos</th><th>Salas foco</th></tr>
      ${z.supervisores.map(filaSup).join("")}</table>
    <p class="nota">En rojo, fuera de meta. El número chico junto a cada nota RED son los puntos que sube el promedio de la zona si todas las salas del supervisor llegan a la meta.</p>
    <h2>Salas críticas (prioridad alta)</h2>
    <table class="c"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th class="l">Qué está pasando</th><th class="l">Acción inicial</th><th>Otros</th></tr>
      ${criticas.map((x) => `<tr><td class="l b">${esc(x.sala.nombre)}</td><td class="l">${esc(supNombre(x.sala.sala_id))}</td>
        <td class="l">${x.altas.map((p) => esc(p.problema)).join(" · ")}</td><td class="l">${esc(accion(x))}</td><td>${x.medias.length || "–"}</td></tr>`).join("")}
    </table>
    ${restantes > 0 ? `<p class="nota">Y ${restantes} sala${restantes === 1 ? "" : "s"} más con problemas de prioridad alta: están en el portal.</p>` : ""}
    <div class="criterio" style="border:1px dashed #c4b5fd;background:#faf5ff;border-radius:5px;padding:5px 9px;font-size:9px;margin-top:8px">
      <b>Criterio de prioridad (propuesto).</b> <b>RED</b>: alta si la categoría está bajo 75% o a 20 pp o más de la meta. <b>Presentismo</b>: alta si lleva 3 semanas bajo 80% y esta semana bajo meta.
      <b>Venta perdida</b>: alta si la sala suma $50.000 o más, o un SKU lleva 7 días o más sin stock. Cada tipo se clasifica por separado, sin sumar indicadores distintos.</div>
  </section>`;
}

// ---------------------------------------------------------------- página 3

function pagina3(datos, z, extras) {
  const sm = z.sem;
  const cadem = z.cadem;
  const supDe = (id) => z.supervisores.find((g) => g.salas.some((x) => x.sala_id === id))?.nombre ?? "–";

  let vp;
  if (!cadem.total) {
    vp = `<p class="x">No hay datos de causas de quiebre cargados para la semana ${sm[2]}.</p>`;
  } else {
    const porCausa = new Map();
    for (const r of cadem.filas) porCausa.set(r.causa, (porCausa.get(r.causa) ?? 0) + r.vp);
    const porSup = z.supervisores.filter((s) => s.cadem.total).map((s) => ({ label: s.nombre, valor: s.cadem.total })).sort((a, b) => b.valor - a.valor);
    const escalar = cadem.filas.filter((r) => (r.causa === "SIN STOCK" && (r.dias ?? 0) >= 7) || (r.causa === "STOCK ESTATICO" && (r.dias ?? 0) >= 14)).sort((a, b) => b.vp - a.vp);
    vp = `<div class="dos">
        <div><h2>Por supervisor</h2>${barras(porSup, { fmt: clp })}</div>
        <div><h2>Por causa registrada</h2>${barras([...porCausa].map(([c, v]) => ({ label: causaLabelCorta(c), valor: v })).sort((a, b) => b.valor - a.valor), { fmt: clp, color: "#6b7280" })}</div>
      </div>
      <h2>Salas con más venta perdida</h2>
      <table class="c"><tr><th class="l">Sala</th><th class="l">Supervisor</th><th class="r">Venta perdida</th><th>SKU</th><th class="l">Causa principal</th><th>Máx. días</th><th class="l">Acción</th></tr>
        ${cadem.salas.slice(0, 7).map((s) => {
          const pc = new Map(); for (const r of s.filas) pc.set(r.causa, (pc.get(r.causa) ?? 0) + r.vp);
          const [causa] = [...pc].sort((a, b) => b[1] - a[1])[0];
          const maxD = Math.max(...s.filas.map((r) => r.dias ?? 0));
          return `<tr><td class="l b">${esc(s.nombre)}</td><td class="l">${esc(supDe(s.salaId))}</td><td class="r">${clp(s.total)}</td><td>${s.n}</td><td class="l">${causaLabelCorta(causa)}</td><td class="${maxD >= 7 ? "bad" : ""}">${maxD}</td><td class="l">${guiaCausa(causa).corto}</td></tr>`;
        }).join("")}</table>
      <h2>Para escalar (sin stock 7 días o más · stock estático 14 días o más)</h2>
      ${escalar.length ? `<table class="c"><tr><th class="l">Sala</th><th class="l">SKU</th><th class="l">Causa</th><th>Días</th><th class="r">Venta perdida</th><th class="l">Escalar a</th></tr>
        ${escalar.slice(0, 6).map((r) => `<tr><td class="l b">${esc(r.sala)}</td><td class="l">${esc(r.sku)}</td><td class="l">${causaLabelCorta(r.causa)}</td><td class="bad">${r.dias}</td><td class="r">${clp(r.vp)}</td><td class="l">${esc(guiaCausa(r.causa).escalar)}</td></tr>`).join("")}</table>
        ${escalar.length > 6 ? `<p class="nota">Y ${escalar.length - 6} SKU más en el portal.</p>` : ""}` : `<p class="x">Ningún SKU cumple el criterio de escalamiento esta semana.</p>`}`;
  }

  // Seguimiento: resumen de los compromisos de la semana anterior.
  const prev = extras.previos;
  const cuenta = (f) => prev.filter(f).length;
  const mejoro = cuenta((c) => /^Mejoró/.test(c.resultado)), empeoro = cuenta((c) => /^Empeoró/.test(c.resultado));
  const resueltos = cuenta((c) => c.estado === "Resuelto con evidencia");
  const peores = prev.filter((c) => /^Empeoró/.test(c.resultado)).slice(0, 4);
  const nomSala = (id) => z.salasZona.find((s) => s.sala_id === id)?.nombre ?? "–";
  const seguimiento = prev.length
    ? `<div class="tres">
        <div class="mini"><b class="n">${prev.length}</b><span>compromisos de la semana ${sm[1]}</span></div>
        <div class="mini"><b class="n" style="color:#15803d">${mejoro}</b><span>mejoraron su indicador · ${resueltos} cerrados con evidencia</span></div>
        <div class="mini"><b class="n" style="color:#b91c1c">${empeoro}</b><span>empeoraron${peores.length ? `: ${lista(peores.map((c) => esc(nomSala(c.sala_id))), 3)}` : ""}</span></div>
      </div>`
    : `<p class="x">Este es el primer informe con compromisos registrados: su resultado se medirá en el informe de la semana ${sm[2] + 1}.</p>`;

  // Vacíos de datos.
  const vacios = [];
  const sinRed = sinCargaRed(datos, z);
  if (sinRed.length) vacios.push(`${sinRed.length} salas sin carga RED esta semana (${lista(sinRed.map((s) => esc(s.nombre)), 3)}); una sala sin carga no está en 0%.`);
  vacios.push(`Venta perdida: ${cadem.salas.length} de ${z.salasZona.length} salas con quiebre medido; el reporte no trae las demás.`);
  vacios.push("La causa de los quiebres viene del sistema de la cadena; la causa raíz se confirma en sala. El motivo de una ausencia se valida en GeoVictoria o con el supervisor.");

  return `<section class="pag">
    ${cab(`${esc(z.zona)} · Venta perdida y seguimiento`, `Datawalt · Semana ${sm[2]}`, cadem.total ? `${clp(cadem.total)} reportados<br>${cadem.salas.length} de ${z.salasZona.length} salas` : "")}
    ${vp}
    <h2>Seguimiento de compromisos · semana ${sm[1]}</h2>${seguimiento}
    <h2>Qué no sabemos todavía</h2>
    <ul class="lectura" style="font-size:9.8px">${vacios.map((v) => `<li>${v}</li>`).join("")}</ul>
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
