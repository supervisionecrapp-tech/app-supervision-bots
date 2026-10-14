// Punto de entrada: `npm run start -- <informe> [destinatarios]`.
// Por ahora sólo existe `prueba`, que confirma que el envío funciona.
import { enviarCorreo, REMITENTE } from "./correo.mjs";

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
};

if (!informes[informe]) {
  console.error(`Informe desconocido: ${informe}`);
  process.exit(1);
}
await informes[informe]();
