// Copia literal de bots/asistencia-sync/src/gv.mjs — mismo comportamiento,
// mismos límites y mitigaciones ya validados ahí. Se duplica en vez de
// compartir porque cada bot es su propio paquete node desplegable de forma
// independiente (mismo criterio ya usado entre asistencia-sync y los demás
// bots de este repo).

const GV_BASE = "https://customerapi.geovictoria.com/api/v1";
const GV_MAX_REGISTROS_POR_LLAMADA = 1400;
const GV_RATE_LIMIT_DELAY_MS = 400;

export function normalizeRut(id) {
  return id.replace(/[.-]/g, "").toUpperCase();
}

export function todaySantiagoYyyyMmDd() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()).replaceAll("-", "");
}

export function primerDiaMesSantiagoYyyyMmDd() {
  const hoy = todaySantiagoYyyyMmDd();
  return `${hoy.slice(0, 6)}01`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diasEnRango(desdeYyyyMmDd, hastaYyyyMmDd) {
  const parse = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return Math.floor((parse(hastaYyyyMmDd) - parse(desdeYyyyMmDd)) / 86400000) + 1;
}

export async function gvLogin(key, secret) {
  const res = await fetch(`${GV_BASE}/Login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ User: key, Password: secret }),
  });
  if (!res.ok) throw new Error(`GV Login falló: ${res.status}`);
  const data = await res.json();
  if (!data.token) throw new Error("GV Login no devolvió token");
  return data.token;
}

export async function gvActiveUsers(token) {
  const res = await fetch(`${GV_BASE}/User/ActiveUsers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`GV ActiveUsers falló: ${res.status} — ${await res.text()}`);
  return res.json();
}

async function gvAttendanceBookBatch(token, userIds, rango) {
  const res = await fetch(`${GV_BASE}/AttendanceBook`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      StartDate: `${rango.desde}000000`,
      EndDate: `${rango.hasta}235959`,
      UserIds: userIds.join(","),
    }),
  });
  if (!res.ok) throw new Error(`GV AttendanceBook falló: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  return data.Users ?? [];
}

export async function gvAttendanceBookAll(token, userIds, rango) {
  const dias = diasEnRango(rango.desde, rango.hasta);
  const batchSize = Math.max(1, Math.floor(GV_MAX_REGISTROS_POR_LLAMADA / dias));
  const batches = [];
  for (let i = 0; i < userIds.length; i += batchSize) {
    batches.push(userIds.slice(i, i + batchSize));
  }
  const results = [];
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(GV_RATE_LIMIT_DELAY_MS);
    results.push(...(await gvAttendanceBookBatch(token, batches[i], rango)));
  }
  return results;
}

export function gvUsersToFilas(users) {
  const filas = [];
  for (const user of users) {
    const nombre = `${user.Name} ${user.LastName}`.trim();
    for (const dia of user.PlannedInterval ?? []) {
      const shifts = dia.Shifts ?? [];
      if (shifts.length === 0) continue;
      const timeOffs = dia.TimeOffs ?? [];
      const primerIngreso = (dia.Punches ?? [])
        .filter((p) => p.Type === "Ingreso")
        .sort((a, b) => a.Date.localeCompare(b.Date))[0];
      filas.push({
        rut: user.Identifier,
        nombre,
        grupo_gv: user.GroupDescription,
        cargo: user.PositionDescription?.trim() || null,
        fecha: isoFromYyyyMmDd((dia.Date ?? "").slice(0, 8)),
        absent: dia.Absent === "True",
        shift_begins: shifts[0].Begins,
        timeoff_type: timeOffs[0]?.TimeOffTypeDescription ?? null,
        primer_ingreso_gmt0: primerIngreso?.Date ?? null,
      });
    }
  }
  return filas;
}

function isoFromYyyyMmDd(s) {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
