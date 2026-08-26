// Port a Node (plain fetch, sin Playwright) de la lógica de GeoVictoria que
// vive en supabase/functions/ausencias-hoy/index.ts — mismo comportamiento,
// mismos límites y mitigaciones ya validados ahí (no se reinventa nada acá,
// solo se traduce TS Deno -> JS Node):
//   - GV limita AttendanceBook a 1500 REGISTROS por llamada (usuario x día
//     del rango), no 1500 usuarios — el tamaño de lote se calcula según
//     cuántos días tiene el rango pedido.
//   - GV limita a 3 llamadas/segundo — 400ms de por medio entre lotes.
//   - AttendanceBook exige el RUT sin puntos/guión y con "K" mayúscula.
//   - GroupDescription solo viene poblado en AttendanceBook, no en
//     ActiveUsers, así que hay que traer TODOS los activos y no se puede
//     filtrar antes.

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

// /User/List trae GroupDescription, PositionDescription y ContractDate
// directo por usuario, sin depender de que haya tenido un turno planificado
// en algún rango de fechas — a diferencia de escanear AttendanceBook (lo
// que hacía roster.mjs antes), esto no deja a nadie sin grupo/cargo solo
// porque no trabajó en la ventana consultada. Ver
// https://wiki.geovictoria.com/knowledge-base/user-list/ — no requiere
// parámetros en el body.
export async function gvUserList(token) {
  const res = await fetch(`${GV_BASE}/User/List`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`GV User/List falló: ${res.status} — ${await res.text()}`);
  return res.json();
}

async function gvAttendanceBookBatch(token, userIds, rango) {
  const res = await fetch(`${GV_BASE}/AttendanceBook`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    // UserIds va como string separado por comas, NO como array — un array
    // JSON tira 400 "request body malformed" pese a lo que dice la doc.
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

// Solo se quedan los días con turno programado (Shifts.length>0), igual
// que en la Edge Function — un día libre no cuenta como ausencia ni corta
// racha, así que nunca aparece en ninguna lista, no hace falta guardarlo.
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
