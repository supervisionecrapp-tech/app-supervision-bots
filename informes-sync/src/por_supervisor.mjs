// Informe de una zona dividido por supervisor: una hoja por supervisor con sus
// indicadores (3 semanas, meta y comparación con la zona), las salas con más
// oportunidad por indicador y la venta perdida NARTD por sala con sus 5 SKU.
import { cargarDatos, armarZona, aPdf, pct, clp, esc, nf, pts, perdidasSala, CSS, RED, PRES, CORTO } from "./salas_foco.mjs";
import { pp } from "./gestion.mjs";

const CSS_X = `
  .pag { break-after: page; } .cab h1 { font-size: 21px; } .cab { margin-bottom: 8px; } h2 { margin: 11px 0 5px; }
  table.c td, table.c th { padding: 3px 5px; font-size: 9.3px; vertical-align: top; }
  .blq h3 { margin: 8px 0 3px; font-size: 10.5px; } .blq .x { font-weight: 400; }
  table.vp td, table.vp th { font-size: 8.8px; padding: 2px 5px; }
`;
const cab = (t, s, d) => `<div class="cab"><div><h1>${t}</h1><div class="s">${s}</div></div><div class="d">${d}</div></div>`;
const cls = (v, m) => (v == null ? "na" : v >= m ? "ok" : "bad");

// conZona: columnas contra la zona; con un solo supervisor serían siempre 0 pp.
function seccionSup(z, sup, conZona) {
  const sm = z.sem;
  const metaDe = (k) => (RED.find((c) => c.key === k) ? z.metas[RED.find((c) => c.key === k).meta] : z.metas.presentismo);
  const inds = [...RED.map((c) => ({ k: c.key, label: `RED ${c.label}` })), ...PRES.map((p) => ({ k: p.key, label: p.label }))]
    .filter((i) => sup.ind.some((x) => x[i.k] != null));
  const kpi = `<table class="c"><tr><th class="l">Indicador</th>${sm.map((w) => `<th>S${w}</th>`).join("")}<th>Meta</th><th>Oportunidad</th>${conZona ? `<th>${esc(z.zona)} S${sm[2]}</th><th>vs ${esc(z.zona)}</th>` : ""}</tr>
    ${inds.map((i) => {
      const m = metaDe(i.k), v = sup.ind[2][i.k], zt = z.ind[2][i.k];
      return `<tr><td class="l b">${i.label}</td>${sup.ind.map((x) => `<td class="${cls(x[i.k], m)}">${pct(x[i.k])}</td>`).join("")}<td>${pct(m, 0)}</td>
        <td class="${v != null && v < m ? "b" : ""}">${v != null && v < m ? `+${nf((m - v) * 100, 1)} pp` : "En meta"}</td>${conZona ? `<td>${pct(zt)}</td><td class="${v != null && zt != null && v < zt ? "bad" : "ok"}">${v != null && zt != null ? pp(v - zt) : "–"}</td>` : ""}</tr>`;
    }).join("")}</table>`;

  // Hasta 3 salas por indicador para que cada supervisor quepa en una hoja.
  const tablaRed = (c) => {
    const meta = z.metas[c.meta];
    const f = sup.salas.map((s) => ({ s, v: z.porSala.get(s.sala_id).red[c.key] })).filter((x) => x.v != null && x.v < meta).sort((a, b) => a.v - b.v);
    if (!f.length) return "";
    return `<div class="blq"><h3>RED ${c.label} <span class="x">· meta ${pct(meta, 0)}</span></h3><table class="c"><tr><th class="l">Sala</th><th>Nota</th><th>Oportunidad</th><th class="l">Dónde sumar</th></tr>
      ${f.slice(0, 3).map((x) => {
        const top = (perdidasSala(z.comp[c.key].get(x.s.sala_id), c.key)?.comps ?? []).filter((k) => k.pierde > 0.002).sort((a, b) => b.pierde - a.pierde)[0];
        return `<tr><td class="l b">${esc(x.s.nombre)}</td><td class="bad">${pct(x.v)}</td><td>+${nf((meta - x.v) * 100, 1)} pp</td><td class="l">${top ? `${esc(CORTO[top.label] ?? top.label)} <span class="x">(+${pts(top.pierde)} pts)</span>` : "–"}</td></tr>`;
      }).join("")}</table></div>`;
  };
  const tablaPres = (p) => {
    const f = sup.salas.filter((s) => z.porSala.get(s.sala_id).presTipo === p.key)
      .map((s) => ({ s, d: z.porSala.get(s.sala_id), h: z.horas.find((h) => h.sala_id === s.sala_id) }))
      .filter((x) => x.d.presSem[2] != null && x.d.presSem[2] < z.metas.presentismo).sort((a, b) => a.d.presSem[2] - b.d.presSem[2]);
    if (!f.length) return "";
    return `<div class="blq"><h3>${p.label} <span class="x">· meta ${pct(z.metas.presentismo, 0)}</span></h3><table class="c"><tr><th class="l">Sala</th><th>Semana</th><th>3 semanas</th><th>Oportunidad</th><th class="l">Días críticos</th></tr>
      ${f.slice(0, 3).map((x) => `<tr><td class="l b">${esc(x.s.nombre)}</td><td class="bad">${pct(x.d.presSem[2], 0)}</td><td>${pct(x.d.pres3, 0)}</td><td>+${nf((z.metas.presentismo - x.d.presSem[2]) * 100, 1)} pp</td>
        <td class="l">${esc((x.h?.criticos ?? []).slice(0, 3).map((c) => c.split(" ")[0]).join(", ") || "repartido")}</td></tr>`).join("")}</table></div>`;
  };

  const vpSalas = [...sup.cadem.salas].sort((a, b) => b.total - a.total).slice(0, 6);
  const vp = sup.cadem.total ? `<h2>Venta perdida NARTD · ${clp(sup.cadem.total)}</h2>
    <table class="c vp"><tr><th class="l">Sala</th><th class="r">Venta perdida</th><th class="l">5 SKU de mayor monto</th></tr>
    ${vpSalas.map((sa) => `<tr><td class="l b">${esc(sa.nombre)}</td><td class="r">${clp(sa.total)}</td><td class="l">${[...sa.filas].sort((a, b) => b.vp - a.vp).slice(0, 5).map((r) => `${esc(r.sku)} <span class="x">${clp(r.vp)}</span>`).join(" · ")}</td></tr>`).join("")}</table>` : "";

  return `<section class="pag">
    ${cab(esc(sup.nombre), `Supervisor · Subzona ${esc(sup.subzona ?? "–")} · ${esc(z.zona)}`, `Semana ${sm[2]}`)}
    <h2>Indicadores</h2>${kpi}
    <h2>Salas con oportunidad por indicador</h2>
    ${RED.map(tablaRed).join("")}${["WM", "SMU"].map((k) => PRES.find((p) => p.key === k)).map(tablaPres).join("")}
    ${vp}
  </section>`;
}

/** Correo con el PDF por supervisor de una zona. */
export async function generarPorSupervisor(sb, zonaId) {
  const datos = await cargarDatos(sb, { incluirVisitas: false });
  const z = armarZona(datos, zonaId);
  const sups = z.supervisores.filter((s) => s.id !== "sin");
  if (!sups.length) throw new Error(`${z.zona} no tiene supervisores con salas activas`);
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(z.zona)} por supervisor</title><style>${CSS}${CSS_X}</style></head><body>
    ${sups.map((s) => seccionSup(z, s, sups.length > 1)).join("")}</body></html>`;
  const [pdf] = await aPdf([html]);
  const sem = z.sem[2];
  const slug = z.zona.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_");
  const zona = esc(z.zona);
  return {
    asunto: `${process.env.ASUNTO_PREFIJO ?? ""}${z.zona} · Informe por supervisor · Semana ${sem}`,
    html: `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1f2937">
      <p>Estimados,</p>
      <p>Adjunto el informe de ${zona} por supervisor de la semana ${sem}: una hoja por supervisor con sus indicadores contra meta${sups.length > 1 ? " y contra la zona" : ""}, las salas con más oportunidad por indicador y la venta perdida NARTD por sala.</p>
      <p>Supervisores: ${sups.map((s) => esc(s.nombre)).join(", ")}.</p></div>`,
    adjuntos: [{ filename: `informe_${slug}_por_supervisor_${datos.emitido.toISOString().slice(0, 10)}.pdf`, content: pdf, contentType: "application/pdf" }],
  };
}
