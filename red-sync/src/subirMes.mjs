import { readFileSync, readdirSync } from "node:fs";

// Sube a Storage (bucket privado bono-cadem) los 3 exports de RED de un mes,
// para que el panel web arme la planilla de bonos. Sin tablas: solo archivos.
//   <dir>/red-<CAT>-<año>-mes<mes>.xlsx → bono-cadem/<año>-<MM>/<CAT>.xlsx
const dir = process.argv[2] || "./exports";
const anio = Number(process.env.ANIO);
const mes = Number(process.env.MES);
const url = process.env.SUPABASE_URL || "https://lbwwnrsbgaxjulpfbwdz.supabase.co";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!anio || !mes || !key) throw new Error("Faltan ANIO, MES o SUPABASE_SERVICE_ROLE_KEY");

const carpeta = `${anio}-${String(mes).padStart(2, "0")}`;
const archivos = readdirSync(dir, { recursive: true }).filter((f) => /red-(NARTD|ABI|VSR)-\d+-mes\d+\.xlsx$/.test(f));
const cats = new Set(archivos.map((f) => f.match(/red-(NARTD|ABI|VSR)-/)[1]));
for (const c of ["NARTD", "ABI", "VSR"]) if (!cats.has(c)) throw new Error(`Falta el export de ${c}`);

for (const f of archivos) {
  const cat = f.match(/red-(NARTD|ABI|VSR)-/)[1];
  const res = await fetch(`${url}/storage/v1/object/bono-cadem/${carpeta}/${cat}.xlsx`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "x-upsert": "true",
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    body: readFileSync(`${dir}/${f}`),
  });
  if (!res.ok) throw new Error(`No se pudo subir ${cat}: ${res.status} ${await res.text()}`);
  console.log(`Subido ${carpeta}/${cat}.xlsx`);
}
