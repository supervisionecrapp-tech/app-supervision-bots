import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

// Mismo portal y mismo reporte que red-sync (Datawalt > "Reporte - Embonor
// Agencia", report/736, un iframe de Power BI cross-origin). Acá se va a la
// página "Causas del quiebre" del menú lateral, se filtra por semana igual
// que en Red y se exporta la tabla Sala > SKU ("Última Causa Quiebre"), que
// ya viene con la jerarquía abierta hasta SKU: el export trae una fila
// "Total" por sala y una fila por SKU.
export const VIEWPORT = { width: 1920, height: 889 };

const REPORT_URL = "https://dichter-neira.datawalt.app/report/736";

// Coordenadas de último recurso — solo se usan si el selector real no
// aparece (ver abrirFiltroSemana). Calibradas a ojo sobre una captura del
// reporte, NO verificadas en el runner: revisar las capturas de debug.
const FALLBACK_WEEK_DROPDOWN = { x: 1750, y: 215 };

// Contenedor del visual de la tabla: "Última Causa Quiebre" es un
// encabezado que solo tiene esa tabla (el slicer "Causa quiebre" no lo
// contiene completo).
const TABLA_SELECTORS = [
  'visual-container:has-text("Última Causa Quiebre")',
  '.visualContainer:has-text("Última Causa Quiebre")',
  '.visual-container-component:has-text("Última Causa Quiebre")',
];

export async function scrapeCausasQuiebre({
  anio,
  mes,
  semana,
  datawaltUser,
  datawaltPass,
  downloadDir,
  waitMultiplier = 1,
}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(REPORT_URL);
    await page.waitForLoadState("networkidle").catch(() => {});
    console.log(`URL tras goto: ${page.url()}`);

    // Login en dos pasos (ver red-sync/src/scrape.mjs): botón "Iniciar
    // sesión" y luego el Hosted UI de Cognito.
    await page.getByText("Iniciar sesión", { exact: true }).click();
    await page.waitForURL(/amazoncognito\.com/, { timeout: 15000 });
    await page.getByPlaceholder("Ingrese el nombre de usuario").fill(datawaltUser);
    await page.getByPlaceholder("Ingrese la contraseña").fill(datawaltPass);
    await page.locator('button[type="submit"]').click();
    await page.waitForLoadState("networkidle");

    await page.goto(REPORT_URL);
    await page.waitForTimeout(10000 * waitMultiplier);
    await debugShot(page, downloadDir, "01-report-loaded");

    const frame = page.frameLocator("iframe");

    // Ítem "Causas del quiebre" del menú lateral del reporte.
    const menu = frame.getByText("Causas del quiebre", { exact: true }).first();
    await menu.waitFor({ state: "visible", timeout: 20000 });
    await menu.click();
    await page.waitForTimeout(8000 * waitMultiplier);
    await debugShot(page, downloadDir, "02-causas-quiebre");

    await selectWeek(frame, page, { anio, mes, semana }, downloadDir, waitMultiplier);

    const tabla = await ubicarTabla(frame);
    await tabla.scrollIntoViewIfNeeded().catch(() => {});
    await tabla.hover();
    await page.waitForTimeout(500);
    await debugShot(page, downloadDir, "04-tabla");

    await tabla.locator('[data-testid="visual-more-options-btn"]').click();
    await page.waitForTimeout(1500);
    await debugShot(page, downloadDir, "05a-menu-abierto");

    await frame.locator('[data-testid="pbimenu-item.Exportar datos"]').click();
    await page.waitForTimeout(2500);
    await debugShot(page, downloadDir, "05-dialogo-exportar");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      frame.locator('[data-testid="export-btn"]').click(),
    ]);

    const filePath = `${downloadDir}/causas-quiebre-${anio}-${semana}.xlsx`;
    await download.saveAs(filePath);
    return filePath;
  } catch (err) {
    await debugShot(page, downloadDir, "99-error");
    try {
      writeFileSync(`${downloadDir}/debug-99-error.html`, await page.content());
    } catch {
      // sin HTML de diagnóstico, no pasa nada
    }
    throw err;
  } finally {
    await browser.close();
  }
}

async function ubicarTabla(frame) {
  for (const sel of TABLA_SELECTORS) {
    const cont = frame.locator(sel).first();
    if ((await cont.count().catch(() => 0)) > 0) return cont;
  }
  throw new Error('No se encontró el visual de la tabla "Última Causa Quiebre".');
}

// Slicer "Año > Mes > Semana": mismo árbol que en Red (cada fila es un
// .slicerItemContainer con aria-level 1=año, 2=mes, 3=semana). Las semanas
// se agrupan bajo el mes de su JUEVES (ver isoWeekOwnerMonth).
async function abrirFiltroSemana(frame, page) {
  const candidatos = [
    frame.locator('visual-container:has-text("Año > Mes > Semana") .slicer-dropdown-menu').first(),
    frame.locator('.slicer-dropdown-menu:has-text("(Año)")').first(),
  ];
  for (const c of candidatos) {
    if (await c.isVisible({ timeout: 3000 }).catch(() => false)) {
      await c.click();
      return;
    }
  }
  console.warn("No apareció el dropdown de semana por selector — usando coordenadas de respaldo.");
  await page.mouse.click(FALLBACK_WEEK_DROPDOWN.x, FALLBACK_WEEK_DROPDOWN.y);
}

async function selectWeek(frame, page, { anio, mes, semana }, downloadDir, waitMultiplier = 1) {
  await abrirFiltroSemana(frame, page);
  await page.waitForTimeout(1000 * waitMultiplier);
  await debugShot(page, downloadDir, "03-filtro-abierto");

  // Vaciar el árbol mirando el estado real (ver red-sync): "Seleccionar
  // todo" alterna nada→todo / parcial→todo / todo→nada.
  const selectAll = frame.locator('.slicerItemContainer[title="Seleccionar todo"] .slicerCheckbox');
  for (let intento = 0; intento < 4; intento++) {
    const estado = await checkboxState(selectAll);
    console.log(`Filtro de semana — "Seleccionar todo": ${estado}`);
    if (estado === "none") break;
    await selectAll.click();
    await page.waitForTimeout(700 * waitMultiplier);
  }

  const yearItem = frame.locator(`.slicerItemContainer[title="${anio}"][aria-level="1"]`);
  await expandirSiHaceFalta(yearItem, page, waitMultiplier);

  const monthItem = frame.locator(`.slicerItemContainer[title="${mes}"][aria-level="2"]`);
  await expandirSiHaceFalta(monthItem, page, waitMultiplier);
  await debugShot(page, downloadDir, "03a-filtro-mes-expandido");

  const weekItem = frame.locator(`.slicerItemContainer[title="${semana}"][aria-level="3"]`);
  await scrollWeekIntoView(page, weekItem, waitMultiplier);
  await weekItem.locator(".slicerCheckbox").click();
  await page.waitForTimeout(1500 * waitMultiplier);
  await debugShot(page, downloadDir, "03b-filtro-semana");
  await verifyOnlyWeekSelected(frame, { mes, semana });

  await page.keyboard.press("Escape");
  await page.waitForTimeout(500 * waitMultiplier);
  await cerrarDropdownSemana(frame, page, waitMultiplier);
  await page.waitForTimeout(3000 * waitMultiplier);
  await debugShot(page, downloadDir, "03c-filtro-cerrado");
}

// Solo clickea el chevron si el ítem está colapsado: este reporte puede
// abrir con el año/mes ya expandidos, y un click de más los cerraría.
async function expandirSiHaceFalta(item, page, waitMultiplier) {
  const expandido = await item.getAttribute("aria-expanded").catch(() => null);
  if (expandido === "true") return;
  await item.locator(".expandButton").click();
  await page.waitForTimeout(500 * waitMultiplier);
}

async function scrollWeekIntoView(page, weekItem, waitMultiplier = 1) {
  if (await weekItem.isVisible({ timeout: 500 }).catch(() => false)) return;
  const scrollPoint = { x: 1750, y: 400 };
  for (let intento = 0; intento < 12; intento++) {
    if (await weekItem.isVisible({ timeout: 300 }).catch(() => false)) return;
    await page.mouse.move(scrollPoint.x, scrollPoint.y);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(200 * waitMultiplier);
  }
  console.warn("No se pudo scrollear hasta encontrar la semana en el popup.");
}

async function checkboxState(checkbox) {
  const cls = (await checkbox.first().getAttribute("class").catch(() => "")) || "";
  if (/\bpartiallySelected\b/.test(cls)) return "partial";
  if (/\bselected\b/.test(cls)) return "all";
  return "none";
}

// Red de seguridad: antes de exportar, la semana pedida tiene que ser la
// ÚNICA marcada. Es preferible una corrida en rojo a cargar números de
// otras semanas con la etiqueta de ésta.
async function verifyOnlyWeekSelected(frame, { mes, semana }) {
  const problemas = [];
  const semanaEstado = await checkboxState(
    frame.locator(`.slicerItemContainer[title="${semana}"][aria-level="3"] .slicerCheckbox`),
  );
  if (semanaEstado !== "all") problemas.push(`la semana ${semana} quedó "${semanaEstado}"`);

  for (const nivel of [2, 3]) {
    const items = frame.locator(`.slicerItemContainer[aria-level="${nivel}"]`);
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const item = items.nth(i);
      const titulo = await item.getAttribute("title");
      if (nivel === 2 && titulo === String(mes)) continue;
      if (nivel === 3 && titulo === String(semana)) continue;
      const estado = await checkboxState(item.locator(".slicerCheckbox"));
      if (estado !== "none") problemas.push(`${nivel === 2 ? "mes" : "semana"} ${titulo} está "${estado}"`);
    }
  }

  if (problemas.length > 0) {
    throw new Error(`Filtro de semana incorrecto para la semana ${semana}: ${problemas.join("; ")}`);
  }
  console.log(`Filtro de semana verificado: solo la semana ${semana} marcada.`);
}

// Hay varios slicers con dropdown en el reporte: se cuentan los popups
// VISIBLES (el estricto de Playwright revienta con más de uno).
async function popupsAbiertos(frame) {
  return frame.locator(".slicer-dropdown-popup:visible").count().catch(() => 0);
}

async function cerrarDropdownSemana(frame, page, waitMultiplier) {
  for (let intento = 0; intento < 3; intento++) {
    if ((await popupsAbiertos(frame)) === 0) return;
    await abrirFiltroSemana(frame, page); // toggle: el mismo control que lo abrió
    await page.waitForTimeout(800 * waitMultiplier);
  }
  if ((await popupsAbiertos(frame)) > 0) {
    console.warn("El dropdown del filtro de semana sigue abierto — puede tapar la tabla.");
  }
}

async function debugShot(page, dir, name) {
  try {
    await page.screenshot({ path: `${dir}/debug-${name}.png` });
  } catch {
    // no bloquear el flujo por un screenshot fallido
  }
}
