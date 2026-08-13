import { chromium } from "playwright";

// bi.frax.cl pasa primero por una pantalla propia de Power BI pidiendo
// el correo, y de ahí recién al login real de Microsoft (Azure AD) y a
// app.powerbi.com — es Power BI Service real (no embebido en un
// portal de terceros como Datawalt), pero el motor de renderizado del
// reporte es el mismo Power BI de siempre: mismo canvas para
// tablas/visuales, mismos data-testid en los botones de exportar
// (confirmado en vivo — ver bots/red-sync para el detalle de por qué
// esos selectores son estables). La diferencia real está en el login
// (Microsoft, no Cognito) y en que acá el filtro de fecha SÍ es un
// <input type="text"> real, no un árbol de checkboxes.
export const VIEWPORT = { width: 1920, height: 889 };

// Workspace "Walmart EXTERNOS" → reporte "WMC-Externos" → página
// "KPI - APE2" (la única de las 3 páginas del reporte que tiene selector
// de rango de fechas explícito; "INFO EN VIVO" solo muestra el día de
// hoy sin poder elegir fecha). IDs confirmados el 2026-08-13.
const REPORT_URL =
  "https://app.powerbi.com/groups/02d55b93-6dd2-4b31-824a-9e980b02afb5/reports/e3a2de1e-a071-4a23-9bc0-65e57a51519c/96968b20444fb49a9cd2?experience=power-bi";

const TABLE_AREA = { x: 700, y: 650 };

function toMDYYYY(date) {
  // Formato exigido por el input (aria-description: "Escriba la fecha en
  // formato M/d/yyyy") — sin ceros a la izquierda.
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

export async function scrapePresentismoExport({ fecha, datawaltUser, datawaltPass, downloadDir }) {
  const fechaStr = toMDYYYY(fecha);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto("https://bi.frax.cl");
    await page.waitForLoadState("networkidle").catch(() => {});
    await debugShot(page, downloadDir, "00-post-goto");

    // Confirmado en una corrida real: bi.frax.cl NO redirige directo a
    // login.microsoftonline.com — primero pasa por esta pantalla propia
    // de Power BI (dominio distinto) pidiendo el correo, con su propio
    // botón de envío. El TEXTO cambia según el idioma de la sesión (se
    // vio en inglés "Enter email"/"Submit" y en español "Escriba el
    // correo electrónico"/"Enviar" en corridas distintas), por eso se
    // usan los IDs (#email/#submitBtn), que no cambian. Opcional porque
    // no está confirmado que aparezca siempre (podría depender de
    // cookies previas del tenant), timeout corto para no frenar el flujo
    // si esta vez no sale.
    const pbiEmailInput = page.locator("#email");
    if (await pbiEmailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await pbiEmailInput.fill(datawaltUser);
      await page.locator("#submitBtn").click();
      await page.waitForTimeout(2000);
      await debugShot(page, downloadDir, "00b-post-email-submit");
    }

    // Login estándar de Microsoft/Azure AD (sin MFA, confirmado por el
    // usuario) — dos pasos con el mismo botón "Siguiente"/"Iniciar
    // sesión" (id idSIButton9 en ambas pantallas). IDs estables y
    // documentados de Microsoft, no específicos de este tenant. Ya no se
    // exige la URL login.microsoftonline.com de antemano — con que
    // aparezca el campo #i0116 alcanza, sea cual sea el dominio real.
    await page.waitForSelector("#i0116", { timeout: 20000 });
    await debugShot(page, downloadDir, "01-login-ms");
    await page.fill("#i0116", datawaltUser);
    await page.click("#idSIButton9");
    await page.waitForSelector("#i0118", { timeout: 15000 });
    await page.fill("#i0118", datawaltPass);
    await page.click("#idSIButton9");

    // "¿Seguir conectado?" — a veces aparece, a veces no (depende de si
    // Azure AD decide mostrarlo). Si aparece, "Sí" sirve para no tener
    // que loguearse de nuevo en la próxima corrida; si no aparece en 8s,
    // seguimos sin bloquear el flujo.
    try {
      await page.waitForSelector("#idSIButton9", { timeout: 8000 });
      await page.click("#idSIButton9");
    } catch {
      // no apareció, seguimos
    }

    await page.waitForURL(/app\.powerbi\.com/, { timeout: 20000 });
    await debugShot(page, downloadDir, "01-logged-in");

    await page.goto(REPORT_URL);
    // Mismo problema que con Datawalt: el canvas de Power BI tarda en
    // pintar y no hay selector para esperarlo antes de que exista.
    await page.waitForTimeout(10000);
    await debugShot(page, downloadDir, "02-report-loaded");

    const startInput = page.locator('input[aria-label^="Fecha de inicio"]');
    const endInput = page.locator('input[aria-label^="Fecha de finalización"]');

    await startInput.click({ clickCount: 3 });
    await startInput.fill(fechaStr);
    await startInput.press("Tab");
    await page.waitForTimeout(500);

    await endInput.click({ clickCount: 3 });
    await endInput.fill(fechaStr);
    await endInput.press("Tab");
    await page.waitForTimeout(3000);
    await debugShot(page, downloadDir, "03-fecha-filtrada");

    // Igual que en red-sync: la barra de herramientas del visual (donde
    // vive "Más opciones") tiene tamaño cero hasta que el mouse pasa
    // sobre la tabla completa.
    const moreOptionsBtn = page.locator('[data-testid="visual-more-options-btn"]');
    await page.mouse.move(TABLE_AREA.x, TABLE_AREA.y);
    await page.waitForTimeout(300);
    await moreOptionsBtn.click();
    await page.waitForTimeout(1500);
    await debugShot(page, downloadDir, "04-menu-abierto");

    await page.locator('[data-testid="pbimenu-item.Exportar datos"]').click();
    await page.waitForTimeout(2500);
    await debugShot(page, downloadDir, "05-dialogo-exportar");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator('[data-testid="export-btn"]').click(),
    ]);

    const filePath = `${downloadDir}/presentismo-${fecha.toISOString().slice(0, 10)}.xlsx`;
    await download.saveAs(filePath);
    return filePath;
  } catch (err) {
    await debugShot(page, downloadDir, "99-error");
    throw err;
  } finally {
    await browser.close();
  }
}

async function debugShot(page, dir, name) {
  try {
    await page.screenshot({ path: `${dir}/debug-${name}.png` });
  } catch {
    // no bloquear el flujo por un screenshot fallido
  }
}
