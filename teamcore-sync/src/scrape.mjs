import { writeFile } from "node:fs/promises";

// A diferencia de red-sync/presentismo-sync, este portal NO es Power BI —
// es una app Django propia (login usuario/contraseña, formulario HTML
// normal) con CSRF estándar de Django. No hace falta Playwright: todo el
// flujo (login, pedir la descarga, sondear el estado, bajar el archivo)
// se puede hacer con fetch + un cookie jar manual. Confirmado inspeccionando
// la app real con devtools (ver comentarios abajo para cada endpoint).
const BASE = "https://cocacolaembonor.cl.teamcore.net";

function toDDMMYYYY(date) {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}

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

// GET/POST propios en vez de fetch con redirect:"follow" porque el fetch
// de Node no trae cookie jar — hay que leer los Set-Cookie de cada
// respuesta a mano y no perderlos en medio de una redirección.
async function request(url, jar, opts = {}) {
  const headers = { Cookie: cookieHeader(jar), ...opts.headers };
  const res = await fetch(url, { ...opts, headers, redirect: "manual" });
  updateJar(jar, res);
  return res;
}

async function login(jar, usuario, clave) {
  const home = await request(`${BASE}/`, jar);
  if (home.status >= 400) throw new Error(`No se pudo cargar la home de login (status ${home.status})`);
  // El token en el cookie csrftoken y el que Django espera de vuelta en
  // el body/header son el mismo valor mientras no rote — no hace falta
  // parsear el <input hidden> del HTML, alcanza con el valor del cookie.
  const csrftoken = jar.csrftoken;
  if (!csrftoken) throw new Error("No se recibió cookie csrftoken en la home de login");

  const body = new URLSearchParams({ usuario, clave, csrfmiddlewaretoken: csrftoken });
  const loginRes = await request(`${BASE}/ejecuciones/login/`, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE}/`,
      "X-CSRFToken": csrftoken,
    },
    body: body.toString(),
  });

  // Login correcto = redirect (302) fuera de /ejecuciones/login/. Si
  // Django vuelve a renderizar el form (200), las credenciales fallaron.
  if (loginRes.status !== 302) {
    throw new Error(`Login falló (usuario/contraseña inválidos) — status ${loginRes.status}`);
  }
}

async function requestDownload(jar, { inicio, termino }) {
  // Confirmado con Network tools en una sesión real: el botón "Solicitar
  // descarga de datos" NO es un submit de formulario normal, es un POST
  // AJAX a esta URL que responde 200 (no redirect) y el JS del lado
  // cliente navega solo a /corex/downloads después.
  const page = await request(`${BASE}/corex/descarga_excel`, jar);
  if (page.status >= 400) throw new Error(`No se pudo abrir /corex/descarga_excel (status ${page.status})`);
  const csrftoken = jar.csrftoken;

  const body = new URLSearchParams({ reporte: "DETALLE", inicio, termino, csrfmiddlewaretoken: csrftoken });
  const res = await request(`${BASE}/corex/solicitud_descarga`, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE}/corex/descarga_excel`,
      "X-CSRFToken": csrftoken,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => "");
    throw new Error(`solicitud_descarga devolvió status ${res.status}: ${text.slice(0, 300)}`);
  }
}

// La tabla de /corex/downloads no tiene ningún id que identifique "esta
// es mi solicitud" — solo Tipo/Rango/Fecha/Estado. Se asume que la
// primera fila que matchea tipo+rango es la nuestra (la tabla viene
// ordenada de más nueva a más vieja y la acabamos de pedir, así que va a
// estar arriba o casi arriba). Este portal lo usa también otro proceso
// que pide el mismo reporte/rango seguido (ver handoff) — en el peor caso
// de una carrera agarramos la fila de ESE otro proceso en vez de la
// nuestra, pero para el mismo rango de fechas el contenido es
// prácticamente el mismo dato fuente, así que no afecta el resultado.
function parseDownloadsTable(html) {
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return [];
  const rows = [...tbodyMatch[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
  return rows.map((r) => {
    const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, "").trim(),
    );
    const hrefMatch = r[1].match(/href="([^"]+)"/);
    return {
      tipoRango: tds[0] || "",
      estado: tds[2] || "",
      href: hrefMatch ? hrefMatch[1] : null,
    };
  });
}

async function pollForDownload(jar, { inicio, termino }, { timeoutMs = 180000, intervalMs = 5000 } = {}) {
  const wantedPrefix = `DETALLE ${inicio} a ${termino}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(`${BASE}/corex/downloads`, jar);
    if (res.status === 200) {
      const html = await res.text();
      const rows = parseDownloadsTable(html);
      const match = rows.find((r) => r.tipoRango === wantedPrefix);
      if (match) {
        if (match.href) return match.href;
        // "Descargando"/"Pendiente" — seguimos esperando. Si el estado
        // es otra cosa (ej. un error del portal) igual seguimos
        // sondeando hasta el timeout, el error real (si lo hay) se ve en
        // el mensaje de timeout de abajo.
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout esperando que "${wantedPrefix}" quede Completado en /corex/downloads`);
}

export async function scrapeTeamcoreExport({ fecha, teamcoreUser, teamcorePass, downloadDir }) {
  const jar = {};
  await login(jar, teamcoreUser, teamcorePass);

  const fechaStr = toDDMMYYYY(fecha);
  await requestDownload(jar, { inicio: fechaStr, termino: fechaStr });
  const href = await pollForDownload(jar, { inicio: fechaStr, termino: fechaStr });

  // El link de descarga apunta directo a S3 (bucket público, sin firma) —
  // confirmado en una corrida real: no hace falta reenviar cookies de
  // sesión para bajarlo.
  const fileRes = await fetch(href);
  if (!fileRes.ok) throw new Error(`No se pudo descargar el archivo final (status ${fileRes.status}): ${href}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  const filePath = `${downloadDir}/teamcore-${fecha.toISOString().slice(0, 10)}.xlsx`;
  await writeFile(filePath, buf);
  return filePath;
}
