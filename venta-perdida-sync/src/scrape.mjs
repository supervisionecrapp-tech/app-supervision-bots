// Portal: mismo Django de teamcore-sync (cocacolaembonor.cl.teamcore.net),
// pero el reporte "Venta Perdida" vive bajo una app distinta del mismo
// backend: /core/dashboard/#/v2 (SPA "Descargador" de consultas guardadas)
// en vez de /ejecuciones/. El login es el mismo (misma cookie de sesión
// Django sirve para ambas apps, confirmado navegando ambas con la sesión
// abierta una sola vez).
//
// A diferencia del reporte "DETALLE" de teamcore-sync (que resuelve en
// segundos), este reporte tarda mucho y de forma muy irregular en
// completarse en la cola del portal (confirmado por el usuario: hasta
// ~45 min, "muy intermitente") — por eso el flujo se separa en dos fases
// que se corren como jobs de GitHub Actions distintos, sin estado
// compartido entre ambas: el nombre del job que se le da a la consulta en
// Teamcore es determinístico (semana + fecha de hoy), así que la fase
// "collect" puede recalcular el mismo nombre y buscarlo, sin necesidad de
// que "request" le pase ningún id.
//
// Confirmado inspeccionando la app real (Network tab) con una consulta
// guardada de ejemplo ("VP REAL"), no adivinado:
//   POST /corex/descargador/preQuery/   → { status, costs: <bytes> }
//   POST /corex/descargador/create/v2/  → crea el job (form.name = nombre
//     único, mb = costs formateado como "X.XX MB"/"KB"/"GB"/"0 Bytes")
//   GET  /corex/descargador/jobs/downloads/ → lista TODOS los jobs del
//     portal (no solo los propios) con job_name/job_status/job_result_file
//   job_result_file, una vez SUCCEEDED, es una URL firmada de Google Cloud
//     Storage (7 días de validez) descargable directo con fetch, sin
//     cookies — mismo patrón que el bucket S3 de teamcore-sync.
//
// Si "costs" da 0 Bytes, el portal RECHAZA crear el job ("Solo se admiten
// archivos con KB, MB y GB") — pasa cuando se pide la semana ISO actual
// apenas empezada, todavía sin datos cargados en el sistema origen
// (confirmado: la semana actual dio 0 Bytes, la semana anterior dio
// 227.78 MB). Por eso se intenta primero la semana actual y si no hay
// datos se cae a la semana anterior.
const BASE = "https://cocacolaembonor.cl.teamcore.net";

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

// Mismo flujo de login que teamcore-sync/src/scrape.mjs — ver los
// comentarios ahí para el detalle de cada paso. Duplicado a propósito
// (en vez de importar entre paquetes) porque cada bot de bots/ es
// autocontenido (su propio package.json/npm install).
async function login(jar, usuario, clave) {
  const loginPage = await request(`${BASE}/ejecuciones/login/`, jar);
  if (loginPage.status >= 400) throw new Error(`No se pudo cargar la página de login (status ${loginPage.status})`);
  const csrftoken = jar.csrftoken;
  if (!csrftoken) throw new Error("No se recibió cookie csrftoken en la home de login");

  const body = new URLSearchParams({ usuario, clave, csrfmiddlewaretoken: csrftoken });
  const loginRes = await request(`${BASE}/ejecuciones/login/`, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE}/ejecuciones/login/`,
      "X-CSRFToken": csrftoken,
    },
    body: body.toString(),
  });

  const location = loginRes.headers.get("location") || "";
  console.log(`Login POST → status ${loginRes.status}, location "${location}"`);
  if (loginRes.status !== 302 || location.includes("/ejecuciones/login/")) {
    throw new Error(
      `Login falló (usuario/contraseña inválidos, o TEAMCORE_USER/TEAMCORE_PASS mal configurados) — status ${loginRes.status}, location "${location}"`,
    );
  }

  const check = await request(`${BASE}/corex/descargador/get_quota/`, jar);
  if (check.status !== 200) {
    throw new Error(`La sesión no quedó autenticada después del login (GET get_quota devolvió ${check.status})`);
  }
  return jar;
}

// ISO 8601: la semana 1 es la que contiene el primer jueves del año.
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

function csrfHeaders(jar, referer) {
  return {
    "Content-Type": "application/json",
    Referer: referer,
    "X-CSRFToken": jar.csrftoken,
    "X-Requested-With": "XMLHttpRequest",
  };
}

// Payload base de la consulta "VP REAL" (portado tal cual del request real
// capturado en el portal — mismas columnas/filtros/indicadores que ya usa
// el proceso manual). Solo se le pisa job_filters.interval.weekYear en
// buildJobPayload().
function baseJobFilters() {
  return {
    range: [
      { monthYear: { months: [], year: null }, selected: 0, weeksDate: { weeks: [], year: null }, weekYear: { weeks: [], year: null }, relativeDate: "", exactDate: { startDate: null, endDate: null } },
      { monthYear: { months: [], year: null }, selected: 0, weeksDate: { weeks: [], year: null }, weekYear: { weeks: [], year: null }, relativeDate: "", exactDate: { startDate: null, endDate: null } },
    ],
    filter_active: "local",
    filters: [
      { items: [{ name: "ECR", value: "ECR" }], type: "local", name: "cluster" },
      { items: [{ name: "HABILITADO", value: "HABILITADO" }], type: "productFeatured", name: "estado" },
    ],
    indicators: {
      kpi: [],
      b2b: [{ name: "Venta", slug: "venta_clp_dia" }],
      cascade: [{ name: "Cascada de pérdida", slug: "cascada" }],
    },
    rangeDate: [],
    interval: {
      monthYear: { months: [], year: null },
      exactDate: { startDate: null, endDate: null },
      selected: "weekYear",
      weeksDate: { weeks: [], year: null },
      weekYear: { weeks: [{ id: null, name: null }], year: null },
      relativeDate: "",
      open: { selected: "Semanas", data: ["Dias", "Semanas", "Meses"] },
    },
    job_type: "",
    columns: {
      productsStatus: [],
      locals: [{ alias: "Código local proveedor", name: "codigo_local_proveedor", id: 7 }],
      productsFeatured: [{ alias: "Descripción", name: "descripcion_prod", id: 5 }],
      users: [],
    },
    predefined_report: "predefined_report",
  };
}

function buildJobPayload({ week, year, jobName }) {
  const job_filters = baseJobFilters();
  job_filters.interval.weekYear = { weeks: [{ id: week, name: String(week) }], year };
  return {
    job: {
      job_status: "QUEUED",
      job_created_at: null,
      job_selected: false,
      job_id: null,
      job_updated_at: null,
      job_result_file: null,
      job_type: "Retail",
      job_name: jobName,
      job_filters,
      job_description: "",
    },
    form: { description: null, name: jobName },
    type: "Retail",
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 Bytes";
  const units = ["Bytes", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(2)} ${units[i]}`;
}

async function preQuery(jar, payload) {
  const res = await request(`${BASE}/corex/descargador/preQuery/`, jar, {
    method: "POST",
    headers: csrfHeaders(jar, `${BASE}/core/dashboard/`),
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) throw new Error(`preQuery devolvió status ${res.status}`);
  const data = await res.json();
  if (!data.status) throw new Error(`preQuery respondió status:false — ${JSON.stringify(data)}`);
  return data.costs;
}

async function createJob(jar, payload, costs) {
  const res = await request(`${BASE}/corex/descargador/create/v2/`, jar, {
    method: "POST",
    headers: csrfHeaders(jar, `${BASE}/core/dashboard/`),
    body: JSON.stringify({ ...payload, onlyExecute: true, mb: formatBytes(costs) }),
  });
  if (res.status !== 200) throw new Error(`create/v2 devolvió status ${res.status}`);
  const data = await res.json();
  if (data.status === "error") throw new Error(`create/v2 respondió error: ${data.msg?.message || JSON.stringify(data)}`);
  return data;
}

/** Nombre determinístico: la fase "collect" (corrida ~2h después, mismo
 * día) y la fase "retry" (corrida más tarde el mismo día) lo pueden
 * recalcular sin que "request" les pase ningún estado. */
export function jobNameFor({ week, year, today }) {
  const fechaStr = today.toISOString().slice(0, 10).replace(/-/g, "");
  return `bot-vp-${year}w${String(week).padStart(2, "0")}-${fechaStr}`;
}

const JOB_NAME_RE = /^bot-vp-(\d{4})w(\d{2})-(\d{8})$/;

/** Extrae {week, year} de un nombre de job generado por jobNameFor —
 * usado por "retry" para saber qué semana volver a pedir sin tener que
 * adivinarla de nuevo (evita que un reintento corrido después de
 * medianoche apunte, por error, a la semana equivocada). */
export function parseJobName(jobName) {
  const m = JOB_NAME_RE.exec(jobName);
  if (!m) return null;
  return { year: Number(m[1]), week: Number(m[2]) };
}

/** Estrategia fija por día (hora de Chile): lunes = SOLO semana anterior
 * (ya cerrada, siempre con datos completos); miércoles y viernes = SOLO
 * semana actual (para levantar la carga parcial de la semana en curso a
 * mitad y fin de semana). Cualquier otro día (workflow_dispatch manual,
 * o un "retry" corrido pasada la medianoche) cae a semana actual por
 * default. Ya no se prueban las dos semanas en una misma corrida — antes
 * se hacía como fallback automático, pero el pedido explícito fue fijar
 * una sola semana por día y que un fallo dispare un reintento en vez de
 * silenciosamente probar la otra semana. */
export function targetWeekForToday(today) {
  const dow = today.getUTCDay(); // today es mediodía UTC del día calendario de Chile — ver hoyChile() en sync.mjs
  if (dow === 1) {
    // lunes → semana anterior
    return isoWeek(new Date(today.getTime() - 7 * 86400000));
  }
  return isoWeek(today);
}

/** Pide la descarga para UNA semana específica (ya resuelta por quien
 * llama — targetWeekForToday() para una corrida normal, o parseJobName()
 * para un reintento). Si el portal estima 0 Bytes (típico si la semana
 * todavía no tiene datos cargados en el sistema origen) tira error en vez
 * de caer silenciosamente a otra semana — el que llama decide si
 * reintentar. */
export async function requestVentaPerdida({ teamcoreUser, teamcorePass, week, year, jobName }) {
  const jar = {};
  await login(jar, teamcoreUser, teamcorePass);

  const payload = buildJobPayload({ week, year, jobName });
  console.log(`Solicitando semana ${year}-W${week} ("${jobName}")...`);
  const costs = await preQuery(jar, payload);
  console.log(`  costo estimado: ${formatBytes(costs)}`);
  if (costs <= 0) {
    throw new Error(`El portal estimó 0 Bytes para la semana ${year}-W${week} — todavía sin datos cargados en el sistema origen.`);
  }
  await createJob(jar, payload, costs);
  console.log(`  job creado OK.`);
  return { jobName, week, year };
}

async function listJobs(jar) {
  const res = await request(`${BASE}/corex/descargador/jobs/downloads/`, jar);
  if (res.status !== 200) throw new Error(`jobs/downloads devolvió status ${res.status}`);
  const data = await res.json();
  return data.objects || [];
}

/** "request"/"retry" calculan el mismo nombre determinístico que acá se
 * busca — ya no hace falta una lista de candidatos, cada corrida sabe
 * exactamente qué semana fue la suya. */
export async function collectVentaPerdida({ teamcoreUser, teamcorePass, jobName, downloadDir, timeoutMs = 20 * 60000, intervalMs = 15000 }) {
  const jar = {};
  await login(jar, teamcoreUser, teamcorePass);

  const deadline = Date.now() + timeoutMs;
  let job = null;
  while (Date.now() < deadline) {
    const jobs = await listJobs(jar);
    const found = jobs.find((j) => j.job_name === jobName);
    if (found) {
      if (found.job_status === "SUCCEEDED" && found.job_result_file) {
        job = found;
        break;
      }
      if (found.job_status === "FAILED" || found.job_status === "ERROR") {
        throw new Error(`El job "${jobName}" quedó en estado ${found.job_status} en el portal.`);
      }
      console.log(`  "${jobName}" sigue en estado ${found.job_status}, espero...`);
    } else {
      console.log(`  "${jobName}" todavía no aparece en /jobs/downloads/, espero...`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!job) {
    throw new Error(`Timeout esperando que "${jobName}" quede SUCCEEDED (¿la corrida "request" de hoy falló o no se ejecutó?).`);
  }

  // URL firmada de GCS, sin necesidad de cookies de sesión (confirmado
  // igual que el bucket S3 de teamcore-sync).
  const fileRes = await fetch(job.job_result_file);
  if (!fileRes.ok) throw new Error(`No se pudo descargar el CSV final (status ${fileRes.status})`);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  const filePath = `${downloadDir}/venta-perdida-${jobName}.csv`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, buf);
  return filePath;
}
