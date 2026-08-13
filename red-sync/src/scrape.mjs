import { chromium } from "playwright";

// El reporte de Datawalt es Power BI embebido: se renderiza en
// canvas/WebGL, no hay DOM accesible para los filtros/tablas/flechas de
// drill-down (confirmado inspeccionando la accessibility tree — solo
// aparecen botones genéricos sin texto). Por eso casi todo acá es clicks
// por coordenada, calibrados contra un viewport FIJO — si el layout del
// reporte cambia (Dichter Neira lo rediseña) o el viewport cambia, hay
// que recalibrar. El login sí es DOM real (no es Power BI), así que ese
// paso usa selectores normales.
export const VIEWPORT = { width: 1920, height: 889 };

const REPORT_URLS = {
  // NARTD = "Reporte - Embonor Agencia". Calibrado y verificado esta sesión.
  NARTD: "https://dichter-neira.datawalt.app/report/736",
  // ABI y VSR: reportes distintos en el mismo portal (vistos en el home
  // como "Reporte - ABI Auditoría" / "Reporte - VSR Auditoría"), pero
  // todavía no se abrieron ni se les sacó el report id real. Completar
  // antes de usar categoria=ABI/VSR.
  ABI: null,
  VSR: null,
};

// Coordenadas calibradas a mano el 2026-08-13 contra el reporte NARTD
// (id 736), pestaña Detalle, con el viewport de arriba. Puntos de fallo
// más probables si algo se rompe: el reporte cambió de layout, o Datawalt
// actualizó la versión de Power BI Embedded.
const COORDS = {
  sidebarRed: { x: 136, y: 442 },
  tabDetalle: { x: 449, y: 147 },
  drillDownArrow: { x: 1371, y: 585 },
  exportMenuButton: { x: 1518, y: 585 },
  exportarDatosItem: { x: 1596, y: 606 },
  exportarConfirmButton: { x: 1157, y: 745 },
  weekFilterDropdown: { x: 1843, y: 160 },
};

// De Planta (nivel 0) a Sala: Planta > Oficina > Cadena > Bandera > Sala.
const DRILL_DOWN_STEPS = 4;

export async function scrapeRedExport({ categoria, anio, mes, semana, datawaltUser, datawaltPass, downloadDir }) {
  const reportUrl = REPORT_URLS[categoria];
  if (!reportUrl) throw new Error(`No hay report URL calibrada para categoria=${categoria} todavía`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(`https://dichter-neira.datawalt.app/report/${reportUrl.split("/").pop()}`);

    // Login (DOM real, no Power BI) — si el portal cambia el copy de los
    // placeholders esto rompe acá primero, es lo más fácil de arreglar.
    await page.getByPlaceholder("Correo").fill(datawaltUser);
    await page.getByPlaceholder("Contraseña").fill(datawaltPass);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();
    await page.waitForLoadState("networkidle");

    // El login puede redirigir directo al reporte (callbackUrl) o al home;
    // forzar la navegación al reporte de nuevo asegura que quedemos ahí.
    await page.goto(reportUrl);
    await page.waitForTimeout(4000); // el embed de Power BI tarda en pintar

    await debugShot(page, downloadDir, "01-report-loaded");

    await page.mouse.click(COORDS.sidebarRed.x, COORDS.sidebarRed.y);
    await page.waitForTimeout(1500);
    await page.mouse.click(COORDS.tabDetalle.x, COORDS.tabDetalle.y);
    await page.waitForTimeout(1500);
    await debugShot(page, downloadDir, "02-red-detalle");

    // TODO(calibrar): seleccionar año/mes/semana específicos en el árbol
    // del filtro es la parte menos probada de todo el flujo — el árbol es
    // canvas puro y su layout cambia según qué esté expandido. Para la
    // corrida diaria (semana actual) el reporte YA viene con el año/mes
    // actual expandido por default, así que de momento no se toca el
    // filtro y se confía en el default. Si (anio, mes, semana) no
    // coinciden con el default del reporte, esto va a traer datos de la
    // semana equivocada sin avisar — hay que revisar el debug screenshot
    // "03-filtro-semana" de cada corrida hasta que se generalice esto.
    await page.mouse.click(COORDS.weekFilterDropdown.x, COORDS.weekFilterDropdown.y);
    await page.waitForTimeout(800);
    await debugShot(page, downloadDir, "03-filtro-semana");
    await page.keyboard.press("Escape");

    for (let i = 0; i < DRILL_DOWN_STEPS; i++) {
      await page.mouse.click(COORDS.drillDownArrow.x, COORDS.drillDownArrow.y);
      await page.waitForTimeout(1000);
    }
    await debugShot(page, downloadDir, "04-drill-down-sala");

    await page.mouse.click(COORDS.exportMenuButton.x, COORDS.exportMenuButton.y);
    await page.waitForTimeout(500);
    await page.mouse.click(COORDS.exportarDatosItem.x, COORDS.exportarDatosItem.y);
    await page.waitForTimeout(800);
    await debugShot(page, downloadDir, "05-dialogo-exportar");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.mouse.click(COORDS.exportarConfirmButton.x, COORDS.exportarConfirmButton.y),
    ]);

    const filePath = `${downloadDir}/red-${categoria}-${anio}-${semana}.xlsx`;
    await download.saveAs(filePath);
    return filePath;
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
