import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import AdmZip from "adm-zip";

const PORTAL_URL = "https://5.dec.cl/portal";
const REPORTERIA_URL = "https://5.dec.cl/reporteria";
const LISTADO_URL = "https://5.dec.cl/reporteria/listado_reportes";

// El botón de submit del login federado cambia de texto entre pasos
// ("ENTRAR" para RUT, "CONTINUAR" para clave — confirmado en vivo) — se
// prueba con los nombres conocidos en vez de hardcodear uno solo.
//
// OJO (confirmado por la corrida #7 real, que se colgó acá pese a que la
// captura debug-99-error.png mostraba el botón "ENTRAR" perfectamente
// visible en pantalla): el form es server-rendered clásico, el control
// real es un <input type="submit"/"button" value="ENTRAR"> — NO un
// <button>ENTRAR</button>. `page.locator("button:visible")` solo matchea
// la etiqueta <button> y por eso nunca encontraba nada. getByRole SÍ
// reconoce <input type=submit> por su rol ARIA (button), sea cual sea la
// etiqueta HTML real — volver a esto en vez de un selector de tag fijo.
async function clickSubmit(page) {
  const btn = page.getByRole("button", { name: /^(ENTRAR|CONTINUAR)$/ });
  await btn.first().click();
}

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
  // que usar "Identidad Digital", que redirige a un login federado OAuth2.
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

  // OJO (confirmado por la corrida #3 real, que se colgó acá): el
  // formulario de país/RUT/clave en realidad queda SERVIDO DESDE
  // servicios.dec.cl — NO redirige a identidaddigital.acepta.com salvo en
  // casos borde (se vio ese dominio una sola vez, al cancelar un flujo ya
  // viciado a mano). Esperar un dominio específico es frágil (ya falló dos
  // veces por asumir el dominio equivocado) — en vez de eso, esperamos
  // directamente a que aparezca el <select> de país, el primer control
  // real del formulario, sea cual sea el dominio final.
  const paisSelect = page.locator("select").first();
  await paisSelect.waitFor({ timeout: 20000 });
  console.log(`Formulario de login federado cargado en: ${page.url()}`);
  await debugShot(page, downloadDir, "01-form-login-federado");

  // Confirmado en vivo: primero hay que elegir país (opción "Chile") y
  // recién ahí aparece el input de RUT y el botón "ENTRAR".
  //
  // OJO (confirmado por la corrida #6 real, error mío en un fix anterior):
  // el campo REAL para Chile tiene placeholder exacto "Ingresa tu RUT" —
  // "Ingresa tu RUT/DNI" (id="taxpayer_id") es un campo DISTINTO, oculto,
  // de otro paso/país del mismo formulario multi-país. Un selector por
  // "Ingresa tu RUT/DNI" matchea ese decoy oculto y nunca se vuelve
  // visible (falló 3/3 intentos). La captura debug-02-pais-seleccionado.png
  // de esa corrida confirma que, apenas se elige Chile, el campo visible
  // real ya dice "Ingresa tu RUT" (sin "/DNI").
  await paisSelect.selectOption({ label: "Chile" });
  await debugShot(page, downloadDir, "02-pais-seleccionado");

  const rutInput = page.getByPlaceholder("Ingresa tu RUT", { exact: true });
  try {
    await rutInput.waitFor({ state: "visible", timeout: 8000 });
  } catch {
    // Sí confirmado como flaky en la corrida #5 (2 de 3 intentos): a veces
    // el widget no reacciona al primer selectOption. Reintentar alcanzó
    // ahí — se deja como red de seguridad, aunque la causa raíz de la
    // corrida #6 era el selector equivocado, no esto.
    console.log("Campo de RUT seguía oculto tras seleccionar país, reintentando selectOption…");
    await paisSelect.selectOption({ label: "Chile" });
    await rutInput.waitFor({ state: "visible", timeout: 15000 });
  }
  await rutInput.fill(decUser);
  console.log("RUT completado, clic ENTRAR…");
  await clickSubmit(page);
  await debugShot(page, downloadDir, "03-tras-rut-entrar");

  // Confirmar que apareció el campo de clave antes de tocarlo — si no, el
  // error queda claro acá en vez de arrastrarse como un timeout confuso
  // más adelante en Reportería (lo que pasó en la corrida #2: el login "no
  // tiró error" pero en realidad nunca completó).
  const claveInput = page.locator('input[type="password"]').first();
  try {
    await claveInput.waitFor({ timeout: 10000 });
  } catch {
    throw new Error(
      `Tras completar el RUT, no apareció el campo de clave (quedó en ${page.url()}) — revisar debug-03-tras-rut-entrar.png de esta corrida.`,
    );
  }
  await claveInput.fill(decPass);
  // OJO (confirmado en vivo por el usuario mirando la corrida real): el
  // botón de este paso NO se llama "ENTRAR" como el del RUT — es
  // "CONTINUAR". clickSubmit() prueba los dos nombres en vez de asumir uno
  // solo, para no repetir este mismo error si vuelve a cambiar el texto.
  console.log("Clave completada, clic CONTINUAR…");
  await debugShot(page, downloadDir, "04-tras-clave");
  await clickSubmit(page);

  // El reCAPTCHA visible en esta pantalla es la mayor incógnita de este
  // login (no se confirmó si es v2 checkbox o v3 invisible) — si bloquea a
  // Playwright headless corriendo desde IP de datacenter de GitHub
  // Actions, revisar debug-04-tras-clave.png / 05-post-login.png primero
  // (mismo tipo de bloqueo que tuvo presentismo-sync con Cloudflare
  // Turnstile — el fallback documentado ahí es Python+Scrapling/Camoufox
  // en vez de Playwright puro).

  await page.waitForURL(/5\.dec\.cl/, { timeout: 30000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  console.log(`URL final tras login: ${page.url()}`);
  await debugShot(page, downloadDir, "05-post-login");

  // Como se explicó arriba, /5\.dec\.cl/ matchea tanto el portal
  // autenticado como su propia pantalla de login — confirmar que
  // REALMENTE quedamos adentro buscando un elemento que solo existe
  // autenticado ("Mi Portal" en el menú superior).
  const dentro = await page.getByRole("link", { name: "Mi Portal" }).count();
  if (dentro === 0) {
    throw new Error(
      `El login no terminó adentro del portal — la URL final (${page.url()}) coincide con /5\\.dec\\.cl/ pero es la pantalla de login, no el portal (revisar debug-05-post-login.png).`,
    );
  }
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
