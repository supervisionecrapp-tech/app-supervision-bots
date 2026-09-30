import { writeFile } from "node:fs/promises";

// Reporte "Cumplimiento Agencias" del portal "GeoVictoria Externos" de SMU
// (https://externos.geovictoria.com/Reports) — misma cuenta y mismo login que
// smu-presentismo-sync (SMU_GV_USER / SMU_GV_PASS), otro reporte del mismo
// portal. Todo por fetch, sin navegador; el flujo se confirmó grabando la
// pantalla real y leyendo su JS (Reports/Index):
//   1. GET  /Reports/GetCumplimientoAgenciasFiltros -> { Groups, Formats }
//   2. POST /Reports/CumplimientoAgenciasExcel      -> JSON con la URL del .xlsx
//   3. GET  esa URL (Azure Blob público, sin cookies)
const BASE = "https://externos.geovictoria.com";

// Mismo valor con nbsp que manda el portal en "Todos los disponibles".
const SELECT_USUARIO_TODOS = "Todos los disponibles   ";

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
  const location = res.headers.get("location") || "";
  console.log(`Login POST → status ${res.status}, location "${location}"`);

  const check = await request(`${BASE}/Reports`, jar);
  if (check.status !== 200) {
    throw new Error(
      `La sesión no quedó autenticada después del login (SMU_GV_USER/SMU_GV_PASS inválidos?) — GET /Reports devolvió ${check.status}`,
    );
  }
}

/** IdGrupo de todos los locales accesibles. El backend valida GroupIds.NotEmpty()
 * y rechaza con 400 si vienen vacíos; la propia pantalla manda todos los
 * visibles cuando no se elige ninguno. */
async function fetchGroupIds(jar) {
  const res = await request(`${BASE}/Reports/GetCumplimientoAgenciasFiltros`, jar, {
    headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Referer: `${BASE}/Reports` },
  });
  if (res.status !== 200) throw new Error(`GetCumplimientoAgenciasFiltros devolvió status ${res.status}`);
  const data = await res.json();
  const ids = (data.Groups || []).map((g) => g.IdGrupo).filter((id) => id != null);
  if (ids.length === 0) throw new Error("GetCumplimientoAgenciasFiltros no devolvió ningún local (Groups vacío)");
  return ids;
}

async function downloadCumplimientoExcel(jar, { start, end }) {
  const groupIds = await fetchGroupIds(jar);
  console.log(`Locales accesibles en el portal: ${groupIds.length}`);

  // Igual que $.ajax con traditional:true: groupIds repetido, sin corchetes.
  const parts = [
    `reportType=CumplimientoAgencias`,
    `sn=`,
    `start=${encodeURIComponent(start)}`,
    `end=${encodeURIComponent(end)}`,
    `selectUsuario=${encodeURIComponent(SELECT_USUARIO_TODOS)}`,
    ...groupIds.map((id) => `groupIds=${encodeURIComponent(id)}`),
  ];

  const res = await request(`${BASE}/Reports/CumplimientoAgenciasExcel`, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "*/*",
      Origin: BASE,
      Referer: `${BASE}/Reports`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: parts.join("&"),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => "");
    throw new Error(`/Reports/CumplimientoAgenciasExcel devolvió status ${res.status}: ${text.slice(0, 300)}`);
  }

  const text = await res.text();
  let fileUrl;
  try {
    fileUrl = JSON.parse(text);
  } catch {
    throw new Error(`/Reports/CumplimientoAgenciasExcel no devolvió el JSON esperado: "${text.slice(0, 300)}"`);
  }
  if (typeof fileUrl !== "string" || !fileUrl.startsWith("http")) {
    throw new Error(`/Reports/CumplimientoAgenciasExcel devolvió un valor inesperado: "${text.slice(0, 300)}"`);
  }

  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`No se pudo descargar el archivo final (status ${fileRes.status}): ${fileUrl}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  if (buf.slice(0, 2).toString() !== "PK") {
    throw new Error(`El archivo descargado de "${fileUrl}" no es un .xlsx válido (no empieza con "PK").`);
  }
  return buf;
}

export async function scrapeCumplimientoExcel({ desde, hasta, smuUser, smuPass, downloadDir }) {
  const jar = {};
  await login(jar, smuUser, smuPass);

  const buf = await downloadCumplimientoExcel(jar, {
    start: `${desde} 00:00:00`,
    end: `${hasta} 23:59:59`,
  });

  const filePath = `${downloadDir}/cumplimiento-smu-${desde}_${hasta}.xlsx`;
  await writeFile(filePath, buf);
  return filePath;
}
