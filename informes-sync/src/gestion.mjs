// Informe semanal de gestión por zona: resumen ejecutivo para gerencia,
// ranking de intervención por sala, ficha de trabajo por supervisor, venta
// perdida y quiebres, matriz de compromisos con seguimiento, y anexos.
//
// Todo sale de los mismos datos que el portal (ver salas_foco.mjs). Cada
// afirmación va etiquetada: DATO (está en los datos), HIPÓTESIS (causa
// posible que hay que validar), ACCIÓN (propuesta) o FALTA INFORMACIÓN. Las
// hipótesis y acciones salen de reglas fijas por componente RED o causa de
// quiebre, escritas abajo; no hay texto generado por IA.
import {
  pct, clp, esc, nf, pts, diaLargo, diaMes, ddmm, masDias, CSS, RED, PRES, COMPONENTES, CORTO,
  perdidasSala, celda, celdaComp, seccionVisitas, matrizFoco,
} from "./salas_foco.mjs";

// ---------------------------------------------------------------- reglas

/** Qué puede explicar cada componente RED bajo y qué hacer. Son guías de
 * trabajo: la hipótesis siempre se valida en sala antes de darla por causa. */
const GUIA_COMPONENTE = {
  "NSS · disponibilidad": {
    corto: "Reponer portafolio obligatorio",
    hip: "Faltan SKU del portafolio obligatorio en góndola: quiebre en sala, SKU sin codificar o sin pedido.",
    acc: (cat) => `Recorrer la góndola de ${cat} con la lista del portafolio obligatorio; reponer desde bodega lo que haya y dejar pedido de lo que no.`,
    apoyo: "Jefe de sala si un SKU no está codificado; Embonor si el quiebre es de abastecimiento.",
    evid: "Foto de góndola completa y lista de SKU repuestos o pedidos (con N° de pedido).",
  },
  "SOVI · espacio en góndola": {
    corto: "Recuperar frentes (SOVI)",
    hip: "La categoría tiene menos frentes que el objetivo: planograma desactualizado o frentes ocupados por otra marca.",
    acc: (cat) => `Contar los frentes de ${cat} contra el objetivo de SOVI y recuperar los frentes cedidos; si el planograma no da el espacio, pedir su corrección.`,
    apoyo: "Jefe de sala o category de la cadena cuando el planograma no asigna el espacio.",
    evid: "Foto de la góndola con conteo de frentes antes y después.",
  },
  "Estrategia ICE": {
    corto: "Armar plataformas ICE",
    hip: "Plataformas o cabeceras de la estrategia ICE (Meals, Morning Time, Breaks, etc.) sin implementar.",
    acc: () => "Verificar en sala cada plataforma ICE exigida y armar las que falten con el material disponible.",
    apoyo: "Trade Embonor si falta material o espacio negociado.",
    evid: "Foto de cada plataforma armada.",
  },
  "Exhibición pactada": {
    corto: "Instalar exhibición pactada",
    hip: "La exhibición acordada con la cadena no está instalada o no está en la ubicación pactada.",
    acc: () => "Confirmar con el jefe de sala la ubicación pactada e instalar la exhibición.",
    apoyo: "KAM Embonor si la sala no reconoce el acuerdo.",
    evid: "Foto de la exhibición instalada en su ubicación.",
  },
  "Exhibición adicional": {
    corto: "Instalar exhibición adicional",
    hip: "Exhibición adicional sin instalar o sin producto.",
    acc: () => "Instalar la exhibición adicional y dejarla cargada.",
    apoyo: "Trade AB InBev si falta material.",
    evid: "Foto de la exhibición cargada.",
  },
  "NSF · nivel de frío": {
    corto: "Completar cooler",
    hip: "Cooler con SKU faltantes, sin carga o con falla.",
    acc: () => "Revisar carga y planograma del cooler; completar los SKU en frío.",
    apoyo: "Servicio técnico Embonor si el equipo falla.",
    evid: "Foto del cooler cargado.",
  },
  "Catálogos": {
    corto: "Instalar cartelería de catálogo",
    hip: "Falta cartelería de promociones del catálogo vigente.",
    acc: () => "Instalar la cartelería de cada promoción del catálogo vigente.",
    apoyo: "Trade si el material no llegó a la sala.",
    evid: "Foto de cada cartel instalado.",
  },
  "Comunicación POP": {
    corto: "Instalar POP",
    hip: "Material POP de la campaña vigente sin instalar.",
    acc: () => "Instalar el POP de la campaña vigente.",
    apoyo: "Trade Embonor si falta material.",
    evid: "Foto del material instalado.",
  },
};

/** Qué validar y hacer según la causa de quiebre que informa Datawalt. */
const GUIA_CAUSA = {
  "GONDOLA SIN REPOSICION": {
    corto: "Reponer góndola",
    validar: "Que el stock esté físicamente en bodega o sala y no solo en sistema.",
    acc: "Reponer desde bodega y dejar frentes completos; si no hay stock físico, tratarlo como stock estático.",
    escalar: "Jefe de sala si la reposición depende del personal de la sala.",
    verif: "El SKU deja de aparecer con quiebre en el reporte Datawalt siguiente.",
  },
  "SIN STOCK": {
    corto: "Pedido / abastecimiento",
    validar: "Si hay pedido emitido y por qué no llegó (pedido no generado, rechazado o atrasado).",
    acc: "Revisar pedidos pendientes y generar o reclamar el pedido del SKU.",
    escalar: "Embonor (abastecimiento) y comprador de la cadena si el quiebre supera 7 días.",
    verif: "Pedido con N° y fecha de entrega; SKU con venta en el reporte siguiente.",
  },
  "STOCK ESTATICO": {
    corto: "Ajuste de inventario",
    validar: "Conteo físico contra el stock del sistema: el sistema dice que hay, pero no se vende.",
    acc: "Contar el SKU en sala y bodega y pedir el ajuste de inventario para que se gatille el pedido.",
    escalar: "Jefe de sala / inventario de la cadena para registrar el ajuste.",
    verif: "Ajuste registrado y SKU con venta en el reporte siguiente.",
  },
  "STOCK NEGATIVO": {
    corto: "Ajuste de inventario",
    validar: "Conteo físico: el sistema tiene stock negativo y no genera pedido.",
    acc: "Contar el SKU y pedir el ajuste de inventario a la sala.",
    escalar: "Jefe de sala / inventario de la cadena.",
    verif: "Stock en sistema corregido y SKU con venta en el reporte siguiente.",
  },
  "SIN INFORMACION B2B": {
    corto: "Validar B2B",
    validar: "Si el SKU está codificado y la cadena informa su venta en B2B.",
    acc: "Revisar en sala si el SKU existe y se vende; informar a Embonor si el dato B2B falta.",
    escalar: "Embonor (datos B2B).",
    verif: "El SKU aparece con datos en el reporte siguiente.",
  },
};
const guiaCausa = (c) => GUIA_CAUSA[c] ?? { corto: "Revisar", validar: "Causa no informada.", acc: "Revisar el SKU en sala.", escalar: "—", verif: "Reporte siguiente." };

const SECUENCIA_STOCK = [
  "Validar el inventario físico del SKU en sala y bodega.",
  "Compararlo con el stock que informa el sistema de la cadena.",
  "Revisar si hay unidades en bodega sin reponer.",
  "Revisar pedidos pendientes y su estado de abastecimiento.",
  "Validar reposición y exhibición en góndola.",
  "Identificar la causa y el área responsable (sala, cadena o Embonor).",
  "Registrar la solución o escalarla con N° de pedido o ajuste.",
  "Verificar en el reporte Datawalt siguiente que el SKU volvió a venderse.",
];

// ---------------------------------------------------------------- utilidades

const DIA = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const pp = (v, dec = 1) => (v == null ? "–" : Math.abs(v) * 100 < 0.05 ? "0,0 pp" : `${v > 0 ? "+" : "−"}${nf(Math.abs(v) * 100, dec)} pp`);
const brechaTxt = (v, meta) => (v == null ? "–" : v >= meta ? "en meta" : `−${nf((meta - v) * 100, 1)} pp`);
const fechaCorta = (d) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const lista = (xs, n = 3) => (xs.length <= n ? xs.join(", ") : `${xs.slice(0, n).join(", ")} y ${xs.length - n} más`);
const tag = (t) => ({ dato: `<span class="tag dato">Dato</span>`, hip: `<span class="tag hip">Hipótesis</span>`,
  acc: `<span class="tag acc">Acción propuesta</span>`, falta: `<span class="tag falta">Falta información</span>`,
  prop: `<span class="tag prop">Propuesta</span>` })[t];
const prioTag = (p) => `<span class="prio ${p}">${p}</span>`;

/** Barras horizontales simples en SVG (para comparar supervisores o salas). */
function barras(items, { color = "#b91c1c", fmt = (v) => v, ancho = 520 } = {}) {
  const max = Math.max(...items.map((i) => i.valor), 0);
  if (!items.length || max <= 0) return "";
  const alto = 18, etiqueta = 150, h = items.length * (alto + 6);
  return `<svg class="barras" width="${ancho}" height="${h}" viewBox="0 0 ${ancho} ${h}" role="img">
    ${items.map((it, i) => {
      const y = i * (alto + 6), w = Math.max(2, ((ancho - etiqueta - 90) * it.valor) / max);
      return `<text x="0" y="${y + 13}" font-size="10" fill="#374151">${esc(it.label)}</text>
        <rect x="${etiqueta}" y="${y + 2}" width="${w}" height="${alto - 4}" rx="2" fill="${color}"/>
        <text x="${etiqueta + w + 6}" y="${y + 13}" font-size="10" fill="#1f2937">${esc(fmt(it.valor))}</text>`;
    }).join("")}</svg>`;
}

// ---------------------------------------------------------------- problemas por sala

/**
 * Problemas de una sala, uno por tipo y categoría (RED por categoría,
 * presentismo, venta perdida). La prioridad es una clasificación propuesta:
 *   RED          Alta: categoría bajo 75% o brecha ≥ 20 pp. Media: brecha ≥ 10 pp.
 *   Presentismo  Alta: 3 semanas bajo 80%. Media: semana bajo meta con ≥ 8 h faltantes.
 *   Venta perd.  Alta: ≥ $50.000 o algún SKU sin stock ≥ 7 días. Media: ≥ $15.000 o algún SKU ≥ 7 días sin venta.
 * Nunca se mezclan tipos en un puntaje único.
 */
function problemasSala(s, z, datos, extras) {
  const { metas } = z;
  const d = z.porSala.get(s.sala_id);
  const prev = datos.filasSem[1].find((r) => r.sala_id === s.sala_id);
  const out = [];

  for (const c of RED) {
    const v = d.red[c.key];
    const meta = metas[c.meta];
    if (v == null || v >= meta) continue;
    const brecha = meta - v;
    const prioridad = v < 0.75 || brecha >= 0.2 ? "Alta" : brecha >= 0.1 ? "Media" : null;
    if (!prioridad) continue;
    const p = perdidasSala(z.comp[c.key].get(s.sala_id), c.key);
    const comps = (p?.comps ?? []).filter((k) => k.pierde > 0.002).sort((a, b) => b.pierde - a.pierde);
    const top = comps[0];
    const vPrev = prev?.[`red_${c.key}`] == null ? null : Number(prev[`red_${c.key}`]);
    const guia = top ? GUIA_COMPONENTE[top.label] : null;
    const faltanCat = top?.label === "Catálogos"
      ? (extras.presencia.get(`${s.sala_id}|${c.label}`) ?? []).filter((x) => x.encontrado === false).map((x) => x.promocion) : [];
    out.push({
      tipo: "red", sala: s, prioridad, cat: c.label,
      detalle: `${c.label}${top ? ` · ${CORTO[top.label] ?? top.label}` : ""}`,
      indicador: `RED ${c.label}`, valor: v, meta, orden: brecha,
      problema: `RED ${c.label} ${pct(v)} (meta ${pct(meta, 0)})`,
      dato: `RED ${c.label} ${pct(v)}, ${brechaTxt(v, meta)}${vPrev != null ? `; semana anterior ${pct(vPrev)} (${pp(v - vPrev)})` : ""}.`
        + (comps.length ? ` Restan más: ${comps.slice(0, 3).map((k) => `${CORTO[k.label] ?? k.label} ${pct(k.nota, 0)} (−${pts(k.pierde)} pts)`).join(", ")}.` : ""),
      persistente: vPrev != null && vPrev < meta,
      hipotesis: guia?.hip ?? "Sin detalle de componentes en la carga RED.",
      corto: guia?.corto ?? "Revisar medición RED",
      accion: guia ? guia.acc(c.label) + (faltanCat.length ? ` Faltan según la última alarma: ${lista(faltanCat, 4)}.` : "") : "Revisar la medición RED de la sala.",
      apoyo: guia?.apoyo ?? "—",
      evidencia: guia?.evid ?? "Medición RED siguiente.",
      esperado: top ? `${CORTO[top.label] ?? top.label} sobre 90% en la próxima medición; RED ${c.label} sube hasta ${pts(top.pierde)} pts si el componente llega a 100%.` : "RED en meta.",
    });
  }

  // Presentismo
  if (d.presTipo && d.pres3 != null) {
    const h = extras.horas.get(s.sala_id);
    const sem = d.presSem;
    const bajo3 = d.pres3 < 0.8;
    const semMal = sem[2] != null && sem[2] < metas.presentismo && (h?.falta ?? 0) >= 8;
    const semBajo = sem[2] != null && sem[2] < metas.presentismo;
    const prioridad = bajo3 && semBajo ? "Alta" : semMal ? "Media" : null;
    if (prioridad) {
      const finde = h?.criticos.length && h.criticos.every((c) => /^(Sáb|Dom)/.test(c));
      const todos = (h?.criticos.length ?? 0) >= 5;
      const hip = todos ? "Dotación incompleta (vacante o persona con licencia sin reemplazo) o persona que asiste sin marcar."
        : finde ? "Turno de fin de semana sin cubrir."
        : h?.criticos.length ? "Ausencias puntuales en los días indicados o marcas faltantes." : "Déficit repartido: atrasos o salidas anticipadas.";
      out.push({
        tipo: "presentismo", sala: s, prioridad, cat: d.presTipo,
        detalle: `Presentismo ${d.presTipo}`, indicador: `Presentismo ${d.presTipo}`, valor: sem[2], meta: metas.presentismo,
        orden: h?.falta ?? 0,
        problema: `Presentismo ${d.presTipo} ${pct(sem[2])} (meta ${pct(metas.presentismo, 0)})`,
        dato: `S${z.sem[0]} ${pct(sem[0], 0)} · S${z.sem[1]} ${pct(sem[1], 0)} · S${z.sem[2]} ${pct(sem[2], 0)}; 3 semanas ${pct(d.pres3, 0)}.`
          + (h ? ` Semana: ${nf(h.real, 0)} de ${nf(h.obj, 0)} h objetivo, faltan ${nf(h.falta, 0)} h${h.criticos.length ? ` (${h.criticos.join(", ")})` : ""}.` : ""),
        persistente: sem.filter((x) => x != null && x < metas.presentismo).length >= 2,
        hipotesis: hip,
        corto: todos ? "Cubrir dotación y revisar marcas" : `Revisar marcas ${h?.criticos.length ? h.criticos.map((c) => c.split(" ")[0]).join(", ") : "de la semana"}`,
        accion: `Revisar las marcas de ${h?.criticos.length ? "los días " + h.criticos.map((c) => c.split(" ")[0]).join(", ") : "la semana"}: confirmar si la persona asistió sin marcar o no asistió; si falta dotación, pedir cobertura (volante o reemplazo).`,
        apoyo: todos ? "RRHH / coordinación de dotación para cubrir la vacante." : "Coordinación de dotación si hay que cubrir turnos.",
        evidencia: "Marcas corregidas o reemplazo asignado con nombre y turno.",
        esperado: `Horas cumplidas ≥ objetivo la semana siguiente (${pct(metas.presentismo, 0)}).`,
      });
    }
  }

  // Venta perdida
  const filas = z.vpFilas.filter((r) => r.salaId === s.sala_id);
  if (filas.length) {
    const total = filas.reduce((a, r) => a + r.vp, 0);
    const sinStockLargo = filas.filter((r) => r.causa === "SIN STOCK" && (r.dias ?? 0) >= 7);
    const largos = filas.filter((r) => (r.dias ?? 0) >= 7);
    const prioridad = total >= 50000 || sinStockLargo.length ? "Alta" : total >= 15000 || largos.length ? "Media" : null;
    if (prioridad) {
      const porCausa = new Map();
      for (const r of filas) porCausa.set(r.causa, (porCausa.get(r.causa) ?? 0) + r.vp);
      const [causa] = [...porCausa].sort((a, b) => b[1] - a[1])[0];
      const g = guiaCausa(causa);
      const top = [...filas].sort((a, b) => b.vp - a.vp).slice(0, 3);
      out.push({
        tipo: "venta_perdida", sala: s, prioridad, cat: "Cadem",
        detalle: "Venta perdida sala", indicador: "Venta perdida Cadem", valor: total, meta: null, orden: total,
        problema: `Venta perdida ${clp(total)} (${filas.length} SKU con quiebre)`,
        dato: `${clp(total)} en ${filas.length} SKU; ${Math.round((porCausa.get(causa) / total) * 100)}% registrado como "${causaLabelCorta(causa)}". Mayores: ${top.map((r) => `${r.sku} ${clp(r.vp)}${r.dias != null ? `, ${r.dias} d sin venta` : ""}`).join("; ")}.`,
        persistente: largos.length > 0,
        hipotesis: `Causa registrada por Datawalt: ${causaLabelCorta(causa).toLowerCase()}. Validar: ${g.validar}`,
        corto: sinStockLargo.length ? `${g.corto} y escalar` : g.corto,
        accion: g.acc + (sinStockLargo.length ? ` Escalar ${sinStockLargo.map((r) => r.sku).join(", ")} (sin stock ${Math.max(...sinStockLargo.map((r) => r.dias))} días).` : ""),
        apoyo: g.escalar,
        evidencia: g.verif,
        esperado: "Los SKU listados dejan de aparecer con quiebre en el reporte siguiente. El monto informado es venta perdida estimada, no recuperación garantizada.",
        sinStockLargo,
      });
    }
  }
  return out;
}
const causaLabelCorta = (c) => ({ "GONDOLA SIN REPOSICION": "Góndola sin reposición", "SIN STOCK": "Sin stock", "STOCK ESTATICO": "Stock estático",
  "STOCK NEGATIVO": "Stock negativo", "SIN INFORMACION B2B": "Sin información B2B" })[c] ?? c;

const ORDEN_PRIO = { Alta: 0, Media: 1 };
const ORDEN_TIPO = { venta_perdida: 0, red: 1, presentismo: 2 };
function ordenarProblemas(ps) {
  // Por prioridad; dentro de la prioridad, salas con más problemas altos
  // primero y, en cada tipo, el de mayor magnitud propia (pp, h o $).
  const altasPorSala = new Map();
  for (const p of ps) if (p.prioridad === "Alta") altasPorSala.set(p.sala.sala_id, (altasPorSala.get(p.sala.sala_id) ?? 0) + 1);
  return [...ps].sort((a, b) => ORDEN_PRIO[a.prioridad] - ORDEN_PRIO[b.prioridad]
    || (altasPorSala.get(b.sala.sala_id) ?? 0) - (altasPorSala.get(a.sala.sala_id) ?? 0)
    || a.sala.nombre.localeCompare(b.sala.nombre, "es")
    || ORDEN_TIPO[a.tipo] - ORDEN_TIPO[b.tipo]);
}

// ---------------------------------------------------------------- datos extra

const isoSemanaAnterior = (w) => w; // las semanas ya vienen calculadas en datos.semanas

/**
 * Lo que el informe de gestión necesita además de armarZona: horas por sala,
 * catálogo encontrado por sala, problemas y los compromisos de la semana
 * anterior para medir su resultado.
 */
export async function cargarExtrasGestion(sb, datos, z) {
  const horas = new Map(z.horas.map((h) => [h.sala_id, h]));
  const ids = z.salasZona.map((s) => s.sala_id);
  const presencia = new Map();
  const { data: pres } = await sb.from("catalogo_presencia_sala").select("sala_id, categoria, promocion, encontrado").in("sala_id", ids);
  for (const r of pres ?? []) {
    const k = `${r.sala_id}|${r.categoria}`;
    if (!presencia.has(k)) presencia.set(k, []);
    presencia.get(k).push(r);
  }
  const extras = { horas, presencia };
  extras.problemas = ordenarProblemas(z.salasZona.flatMap((s) => problemasSala(s, z, datos, extras)));

  const ant = datos.semanas[1];
  const { data: previos, error } = await sb.from("informe_compromisos")
    .select("sala_id, supervisor_id, tipo, detalle, prioridad, problema, accion, valor_base, meta, plazo, estado, estado_nota")
    .eq("zona_id", z.zonaId).eq("anio", ant.anio).eq("semana", ant.semana);
  if (error) throw new Error(`informe_compromisos: ${error.message}`);
  extras.previos = (previos ?? []).map((c) => ({ ...c, ...medirCompromiso(c, z) }));
  return extras;
}

/** Resultado medido de un compromiso de la semana anterior con los datos de esta. */
function medirCompromiso(c, z) {
  const d = z.porSala.get(c.sala_id);
  let actual = null, mejor = "sube";
  if (c.tipo === "red") {
    const cat = RED.find((r) => c.detalle.startsWith(r.label));
    actual = cat ? d?.red[cat.key] ?? null : null;
  } else if (c.tipo === "presentismo") {
    actual = d?.presSem?.[2] ?? null;
  } else {
    const filas = z.vpFilas.filter((r) => r.salaId === c.sala_id);
    actual = filas.length ? filas.reduce((a, r) => a + r.vp, 0) : 0;
    mejor = "baja";
  }
  const base = c.valor_base == null ? null : Number(c.valor_base);
  if (actual == null || base == null) return { actual, resultado: "Sin dato esta semana" };
  const dif = actual - base;
  if (c.tipo === "venta_perdida") {
    return { actual, resultado: Math.abs(dif) < 1000 ? "Sin cambio" : dif < 0 ? `Mejoró (${clp(-dif)} menos)` : `Empeoró (${clp(dif)} más)` };
  }
  return { actual, resultado: Math.abs(dif) < 0.01 ? "Sin cambio" : (dif > 0) === (mejor === "sube") ? `Mejoró (${pp(dif)})` : `Empeoró (${pp(dif)})` };
}

/** Deja registrados los compromisos de esta semana (Alta y Media). Repetir la
 * corrida no los duplica ni les pisa el estado. */
export async function registrarCompromisos(sb, datos, z, extras) {
  const w = datos.semanas[2];
  const filas = extras.problemas.map((p) => ({
    zona_id: z.zonaId, anio: w.anio, semana: w.semana, sala_id: p.sala.sala_id,
    supervisor_id: p.sala.supervisorId ?? null, tipo: p.tipo, detalle: p.detalle, prioridad: p.prioridad,
    problema: p.problema, accion: p.accion, evidencia: p.evidencia,
    valor_base: p.valor, meta: p.meta, plazo: plazo(datos, p.prioridad).toISOString().slice(0, 10),
  }));
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await sb.from("informe_compromisos")
      .upsert(filas.slice(i, i + 200), { onConflict: "zona_id,anio,semana,sala_id,tipo,detalle" });
    if (error) throw new Error(`informe_compromisos: ${error.message}`);
  }
  return filas.length;
}

/** Plazo propuesto: Alta, 2 días desde la emisión; Media, el domingo de esta semana. */
function plazo(datos, prioridad) {
  const e = datos.emitido;
  if (prioridad === "Alta") return masDias(e, 2);
  const dow = e.getUTCDay() || 7;
  return masDias(e, 7 - dow);
}

export { problemasSala, ordenarProblemas, GUIA_CAUSA, SECUENCIA_STOCK, guiaCausa, barras, tag, prioTag, pp, brechaTxt, fechaCorta, lista, DIA, plazo, causaLabelCorta };
