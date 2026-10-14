// Baja los PDF de las alarmas B2B (Dichter & Neira) que llegaron reenviados a
// la cuenta de informes, para revisar su formato. Solo lee: no marca ni mueve
// correos. Uso: node src/alarmas_muestra.mjs <carpeta_salida> [cantidad]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { REMITENTE } from "./correo.mjs";

const [salida = "alarmas", cantidad = "12"] = process.argv.slice(2);
const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
if (!pass) throw new Error("Falta GMAIL_APP_PASSWORD");

const imap = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: REMITENTE, pass }, logger: false });
await imap.connect();
await mkdir(salida, { recursive: true });
const lock = await imap.getMailboxLock("INBOX", { readOnly: true });
try {
  const uids = (await imap.search({ subject: "ALARMA B2B" }, { uid: true })).slice(-Number(cantidad));
  const indice = [];
  for await (const msg of imap.fetch(uids, { source: true }, { uid: true })) {
    const m = await simpleParser(msg.source);
    for (const a of m.attachments.filter((a) => a.contentType === "application/pdf")) {
      await writeFile(path.join(salida, `${msg.uid}_${a.filename}`), a.content);
      indice.push(`${msg.uid}\t${m.subject}\t${a.filename}`);
    }
  }
  await writeFile(path.join(salida, "indice.tsv"), indice.join("\n"));
  console.log(`${indice.length} PDF guardados en ${salida}`);
} finally {
  lock.release();
  await imap.logout();
}
