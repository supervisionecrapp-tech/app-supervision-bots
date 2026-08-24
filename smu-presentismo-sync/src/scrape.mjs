import { writeFile } from "node:fs/promises";

// Portal "GeoVictoria Externos" de SMU (https://externos.geovictoria.com) —
// a pesar del nombre de dominio, esta es una cuenta/empresa GeoVictoria
// distinta de la que ya usa bots/asistencia-sync por API
// (customerapi.geovictoria.com) para Ausencias de WM: acá no hay API, es
// una app clásica ASP.NET MVC con login usuario/contraseña por formulario
// (sin token anti-forgery en el form) y sesión por cookie, confirmado
// inspeccionando la app real con devtools en una sesión ya autenticada del
// usuario (no se tocó ninguna credencial para esto).
const BASE = "https://externos.geovictoria.com";

// Valor exacto del campo "selectUsuario" cuando queda en su default "Todos
// los disponibles" — el <option> tiene como value su propio texto, con un
// espacio + nbsp ( ) + espacio de más al final tal cual lo manda el
// portal (confirmado con "Copy as cURL" de un request real). Se hardcodea
// tal cual para no arriesgar una transcripción distinta.
const SELECT_USUARIO_TODOS = "Todos los disponibles   ";

function updateJar(jar, res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const pair = c.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// Igual que teamcore-sync: fetch de Node no trae cookie jar propio, así que
// se arma uno a mano y se sigue cada respuesta con redirect:"manual" para
// no perder ningún Set-Cookie en medio de una redirección.
async function request(url, jar, opts = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    Cookie: cookieHeader(jar),
    ...opts.headers,
  };
  const res = await fetch(url, { ...opts, headers, redirect: "manual" });
  updateJar(jar, res);
  return res;
}

async function login(jar, usuario, password) {
  const body = new URLSearchParams({ usuario, password, ReturnUrl: "" });
  const res = await request(`${BASE}/account/login`, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: `${BASE}/Account/Login`,
    },
    body: body.toString(),
  });

  // Login correcto = redirect (302) fuera de /account/login. Confirmación
  // real (no solo el status code): un GET a /Reports después debe devolver
  // 200 y no rebotar de vuelta al login.
  const location = res.headers.get("location") || "";
  console.log(`Login POST → status ${res.status}, location "${location}"`);

  const check = await request(`${BASE}/Reports`, jar);
  if (check.status !== 200) {
    throw new Error(
      `La sesión no quedó autenticada después del login (usuario/contraseña inválidos, o SMU_GV_USER/SMU_GV_PASS mal configurados) — GET /Reports devolvió ${check.status} (login POST fue ${res.status}, location "${location}")`,
    );
  }
}

function toGvDateRange(fecha) {
  const iso = fecha.toISOString().slice(0, 10);
  return { start: `${iso} 00:00:00`, end: `${iso} 23:59:59` };
}

async function downloadAccessExcel(jar, { start, end }) {
  // Mismo body que manda el botón "Descargar Excel" del portal para el
  // reporte "Accesos" (confirmado con Copy as cURL de un request real) —
  // se arma el body a mano en vez de con URLSearchParams para no
  // reencodear selectUsuario y arriesgar un mismatch con el nbsp.
  const body =
    `reportType=Access` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}` +
    `&selectUsuario=${encodeURIComponent(SELECT_USUARIO_TODOS)}`;

  const res = await request(`${BASE}/Reports/AccessExcel`, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "*/*",
      Origin: BASE,
      Referer: `${BASE}/Reports`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });

  if (res.status !== 200) {
    const text = await res.text().catch(() => "");
    throw new Error(`/Reports/AccessExcel devolvió status ${res.status}: ${text.slice(0, 300)}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());

  // El endpoint debería devolver el binario .xlsx directo (Content-Type
  // application/vnd.openxmlformats...) — si en cambio viene HTML/JSON es
  // que el portal cambió el flujo (ej. igual que Teamcore, quizás pide
  // "generar" antes de "descargar", o entrega una URL en vez del archivo)
  // y hay que revisar esto de nuevo con una sesión real.
  if (!contentType.includes("spreadsheet") && !contentType.includes("octet-stream") && buf.slice(0, 2).toString() !== "PK") {
    throw new Error(
      `/Reports/AccessExcel no devolvió un .xlsx (Content-Type "${contentType}", primeros bytes "${buf.slice(0, 200).toString("utf8")}") — revisar el flujo real del portal, puede haber cambiado.`,
    );
  }

  return buf;
}

export async function scrapeSmuAccessExcel({ fecha, smuUser, smuPass, downloadDir }) {
  const jar = {};
  await login(jar, smuUser, smuPass);

  const { start, end } = toGvDateRange(fecha);
  const buf = await downloadAccessExcel(jar, { start, end });

  const filePath = `${downloadDir}/smu-accesos-${fecha.toISOString().slice(0, 10)}.xlsx`;
  await writeFile(filePath, buf);
  return filePath;
}
