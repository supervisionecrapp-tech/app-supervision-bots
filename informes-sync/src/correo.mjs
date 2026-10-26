// Envío de correo por SMTP de Gmail con contraseña de aplicación.
// Remitente fijo: la cuenta dedicada a informes. La contraseña llega por el
// secreto GMAIL_APP_PASSWORD (16 letras, sin espacios).
import nodemailer from "nodemailer";

export const REMITENTE = "supervisionecrapp@gmail.com";

export async function enviarCorreo({ para, cc, asunto, html, adjuntos = [] }) {
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!pass) throw new Error("Falta GMAIL_APP_PASSWORD");

  const transporte = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: REMITENTE, pass },
  });

  const info = await transporte.sendMail({
    from: `"Informes Supervisión ECR" <${REMITENTE}>`,
    to: para,
    ...(cc ? { cc } : {}),
    subject: asunto,
    html,
    attachments: adjuntos,
  });
  console.log(`Enviado a ${para}: ${info.messageId}`);
  return info;
}
