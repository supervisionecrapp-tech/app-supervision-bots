// Punto de entrada: `npm run start -- <informe> [destinatarios]`.
// Con SOLO_ARCHIVO=<ruta> el informe se guarda en disco y no se envía
// (para revisarlo antes de mandarlo).
import { writeFile } from "node:fs/promises";
import { enviarCorreo, REMITENTE } from "./correo.mjs";
import { generarInformeIndicadores, INDICADORES, VP_REFERENCIA, pct, estado, fechaCorta, masDias } from "./indicadores.mjs";

const [informe = "prueba", para = REMITENTE] = process.argv.slice(2);

const informes = {
  async prueba() {
    const ahora = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    await enviarCorreo({
      para,
      asunto: "Prueba de envío de informes",
      html: `<p>Este es un correo de prueba enviado desde GitHub Actions.</p>
             <p>Si te llegó, el envío de informes por correo está funcionando.</p>
             <p style="color:#888">Enviado el ${ahora}</p>`,
    });
  },

  async indicadores() {
    const r = await generarInformeIndicadores();
    const nombre = `indicadores_semana_${r.semana}_${r.anio}.pdf`;
    if (process.env.SOLO_ARCHIVO) {
      await writeFile(process.env.SOLO_ARCHIVO, r.pdf);
      await writeFile(process.env.SOLO_ARCHIVO.replace(/\.pdf$/i, ".html"), r.html);
      console.log(`Guardado en ${process.env.SOLO_ARCHIVO}`);
      return;
    }
    const color = { ok: "#15803d", bad: "#b91c1c" };
    const resumen = INDICADORES.map((ind) => {
      const v = r.total[ind.key];
      return `<tr><td style="padding:3px 12px 3px 0">${ind.label}</td>
        <td style="padding:3px 0;text-align:right;font-weight:600;color:${color[estado(ind, v, r.metas)] ?? "#1f2937"}">${pct(v, ind.inverso ? 2 : 1)}</td></tr>`;
    }).join("");
    await enviarCorreo({
      para,
      asunto: `Indicadores generales · Semana ${r.semana} (${fechaCorta(r.lunes)} – ${fechaCorta(masDias(r.lunes, 6))})`,
      html: `<div style="font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1f2937">
        <p>Adjunto el informe general de indicadores de la semana ${r.semana}, por zona y por supervisor.</p>
        <p style="margin-bottom:4px"><b>Total ${r.total.salas} salas:</b></p>
        <table style="border-collapse:collapse">${resumen}</table>
        <p style="color:#6b7280;font-size:12px">Rojo = fuera de meta. Venta perdida contra referencia de ${pct(VP_REFERENCIA, 0)}.</p>
      </div>`,
      adjuntos: [{ filename: nombre, content: r.pdf, contentType: "application/pdf" }],
    });
  },
};

if (!informes[informe]) {
  console.error(`Informe desconocido: ${informe}`);
  process.exit(1);
}
await informes[informe]();
