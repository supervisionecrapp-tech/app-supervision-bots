import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import AdmZip from "adm-zip";

const PORTAL_URL = "https://5.dec.cl/portal";
const REPORTERIA_URL = "https://5.dec.cl/reporteria";
const LISTADO_URL = "https://5.dec.cl/reporteria/listado_reportes";

// Todo lo de acá abajo (ids, endpoints, texto del modal) se confirmó
// interactuando con el portal real (sesión SOLUC_ESPECIALIZADAS_OUT_SA,
// 2026-08-27) salvo el campo de clave de Acepta — ver el comentario grande
// en login() más abajo.
export async function scrapeDecReporte({
  decUser,
  decPass,
  downloadDir,
  pollTimeoutMs = 10 * 60 * 1000,
  waitMultiplier = 1,
}) {
  mkdirSync(downloadDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await login(page, decUser, decPass, downloadDir);
    const reportId = await triggerReporte(page, downloadDir, waitMultiplier);
    const zipPath = await pollAndDownload(page, reportId, downloadDir, pollTimeoutMs);
    return extractXlsx(zipPath, downloadDir);
  } catch (err) {
    await debugShot(page, downloadDir, "99-error");
    throw err;
  } finally {
    await browser.close();
  }
}

async function login(page, decUser, decPass, downloadDir) {
  await page.goto(PORTAL_URL);
  await page.waitForLoadState("networkidle").catch(() => {});
  await debugShot(page, downloadDir, "00-portal");

  // Confirmado en vivo con el usuario probando manualmente: esta cuenta NO
  // entra por la pestaña "Usar Pin" (RUT+clave directo en 5.dec.cl) — hay
  // que usar "Identidad Digital", que redirige a un login federado OAuth2
  // (servicios.dec.cl -> identidaddigital.acepta.com, proveedor externo
  // Acepta).
  //
  // OJO (confirmado por la corrida #1 real, que falló acá): la página tiene
  // DOS botones "Ingresar" al mismo tiempo, uno por cada tab del login
  // ("Usar Pin" y "Identidad Digital" se renderizan ambos en el DOM, solo
  // se oculta el contenido, no el botón) — un selector por texto/accessible
  // name matchea los dos y Playwright lo rechaza (strict mode violation).
  // Hay que apuntar al id real de la tab de Identidad Digital:
  // #log-button = tab "Usar Pin" (queda `disabled` sin RUT+clave cargados).
  // #id-login = tab "Identidad Digital" (el que sirve — su propio onclick
  // ya revela el redirect real: dmg.trust.sovos.com/oauthidd/.../dec_prod_cl).
  await page.getByText("Identidad Digital", { exact: true }).click();
  await page.locator("#id-login").click();

  await page.waitForURL(/identidaddigital\.acepta\.com|servicios\.dec\.cl|5\.dec\.cl/, { timeout: 20000 });
  await debugShot(page, downloadDir, "01-tras-ingresar");

  if (/identidaddigital\.acepta\.com/.test(page.url())) {
    // Confirmado en vivo: primero hay que elegir país (<select>, opción
    // "Chile") y recién ahí aparece el input de RUT (placeholder real
    // "Ingresa tu RUT") y el botón "ENTRAR".
    await page.locator("select").first().selectOption({ label: "Chile" });
    await page.getByPlaceholder("Ingresa tu RUT").fill(decUser);
    await page.getByRole("button", { name: "ENTRAR" }).click();
    await page.waitForTimeout(1500);
    await debugShot(page, downloadDir, "02-tras-rut");

    // NO CONFIRMADO todavía: la sesión de prueba ya estaba autenticada en
    // Acepta (cookie cacheada del usuario) así que nunca llegamos a ver la
    // pantalla real que pide la clave — se asume un <input type="password">
    // estándar en la misma pantalla (o la siguiente, Playwright espera
    // igual). Si esto falla en la primera corrida real, revisar
    // debug-02-tras-rut.png/.html y ajustar el selector acá.
    const claveInput = page.locator('input[type="password"]').first();
    await claveInput.waitFor({ timeout: 10000 });
    await claveInput.fill(decPass);
    await page.getByRole("button", { name: "ENTRAR" }).click();
    await debugShot(page, downloadDir, "03-tras-clave");

    // El reCAPTCHA visible en la pantalla de Acepta es la mayor incógnita de
    // este login (no se confirmó si es v2 checkbox o v3 invisible) — si
    // bloquea a Playwright headless corriendo desde IP de datacenter de
    // GitHub Actions, revisar este screenshot primero (mismo tipo de
    // bloqueo que tuvo presentismo-sync con Cloudflare Turnstile).
  }

  await page.waitForURL(/5\.dec\.cl/, { timeout: 30000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await debugShot(page, downloadDir, "04-post-login");
}

async function triggerReporte(page, downloadDir, waitMultiplier) {
  await page.goto(REPORTERIA_URL);
  await page.waitForLoadState("networkidle").catch(() => {});

  // Ids reales del formulario, confirmados leyendo el DOM real (no
  // adivinados): #filtro-reporte, #date_from, #filtro-estados, #btnBuscar.
  await page.locator("#filtro-reporte").selectOption({ label: "Estado de Firma de Docs" });

  const year = new Date().getFullYear();
  const desde = page.locator("#date_from");
  await desde.click();
  await desde.fill(`01/01/${year}`);
  // El datepicker (jQuery UI) se abre solo con el foco/click de arriba —
  // Escape lo cierra sin tocar #date_to (que se deja con el default de hoy).
  await page.keyboard.press("Escape");

  await page.locator("#filtro-estados").selectOption({ label: "Pendiente" });
  await debugShot(page, downloadDir, "10-filtros-listos");

  const [searchResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/reporteria/getTableWithResultsFromTransactionerCall")),
    page.locator("#btnBuscar").click(),
  ]);
  if (!searchResp.ok()) throw new Error(`Buscar falló: HTTP ${searchResp.status()}`);
  await page.waitForTimeout(1000 * waitMultiplier);
  await debugShot(page, downloadDir, "11-resultados-busqueda");

  // El botón "Exportar" no tiene id propio (confirmado en el DOM real) y
  // solo existe una vez que Buscar pintó la tabla de resultados — se ubica
  // por accessible name, tomando el primero visible (hay dos "Exportar" en
  // la página real, uno arriba y otro repetido más abajo de la tabla).
  const exportarBtn = page.getByRole("button", { name: "Exportar", exact: true }).first();
  const [exportResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/reporteria/exportReportesDec")),
    exportarBtn.click(),
  ]);
  if (!exportResp.ok()) throw new Error(`Exportar falló: HTTP ${exportResp.status()}`);

  // Confirmado en vivo: el modal de confirmación dice literal
  // "Se generó el reporte N° <id>".
  const modalText = await page.getByText(/Se gener./).textContent({ timeout: 15000 });
  const match = modalText.match(/N[°º]\s*(\d+)/);
  if (!match) throw new Error(`No se pudo leer el ID del reporte del modal: "${modalText}"`);
  const reportId = match[1];
  console.log(`Reporte generado: ${reportId}`);

  await page.getByRole("button", { name: "OK" }).click().catch(() => {});
  return reportId;
}

async function pollAndDownload(page, reportId, downloadDir, timeoutMs) {
  await page.goto(LISTADO_URL);
  const deadline = Date.now() + timeoutMs;
  const POLL_INTERVAL_MS = 15000;

  while (Date.now() < deadline) {
    await page.waitForLoadState("networkidle").catch(() => {});

    // Tabla real confirmada en vivo: #tabla_grilla_reportes, columnas
    // N°/ID/FECHA/CANAL/TOTAL REGISTROS/ESTADO/(acciones). Se matchea la
    // fila por texto EXACTO en la celda de ID (:text-is), no por substring,
    // para no confundir el ID de reporte con otro número de la fila.
    const row = page.locator(`#tabla_grilla_reportes tbody tr:has(td:text-is("${reportId}"))`);
    const found = (await row.count()) > 0;
    const estado = found ? (await row.locator("td").nth(5).textContent())?.trim() ?? "" : "";
    console.log(`Reporte ${reportId}: ${found ? `estado=${estado}` : "fila no encontrada todavía"}`);

    if (estado === "OK") {
      const link = row.locator("a").first();
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      const zipPath = `${downloadDir}/dec-reporte-${reportId}.zip`;
      await download.saveAs(zipPath);
      return zipPath;
    }
    if (estado && /error|fall/i.test(estado)) {
      throw new Error(`El reporte ${reportId} quedó en estado "${estado}"`);
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
    await page.reload();
  }
  await debugShot(page, downloadDir, "98-timeout-polling");
  throw new Error(`El reporte ${reportId} no llegó a "OK" en ${Math.round(timeoutMs / 1000)}s`);
}

// El zip trae el .xlsx real adentro (confirmado bajando el reporte 69398 a
// mano) — a diferencia de teamcore-sync/smu-presentismo-sync, acá hace
// falta descomprimir antes de parsear.
function extractXlsx(zipPath, downloadDir) {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(".xlsx"));
  if (!entry) throw new Error(`El zip ${zipPath} no tiene ningún .xlsx adentro`);
  const xlsxPath = `${downloadDir}/${entry.entryName.split("/").pop()}`;
  zip.extractEntryTo(entry, downloadDir, false, true);
  return xlsxPath;
}

async function debugShot(page, dir, name) {
  try {
    await page.screenshot({ path: `${dir}/debug-${name}.png` });
  } catch {
    // no bloquear el flujo por un screenshot fallido
  }
}
