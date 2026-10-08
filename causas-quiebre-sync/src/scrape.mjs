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
    await bajarHastaTabla(tabla, page, downloadDir);
    // Los botones de la tabla (incluido "…") aparecen recién cuando el mouse
    // pasa por encima del visual (ver red-sync: revelarHeaderTabla).
    await tabla.hover();
    await page.waitForTimeout(800);
    await debugShot(page, downloadDir, "04-tabla");

    // La tabla llega colapsada a nivel Sala (⊞ en cada fila). El botón ↓
    // (drill-down-level-btn) NO sirve: baja de nivel y reemplaza la sala por
    // el SKU (corrida 37837679385: el export traía Sku-Item sin Sala). Hace
    // falta "Expandir todo un nivel" (⇊), que abre los SKU dentro de cada sala.
    const expandir = await ubicarBotonExpandir(frame);
    await expandir.click();
    await page.waitForTimeout(5000 * waitMultiplier);
    await debugShot(page, downloadDir, "04b-tabla-expandida");
    await tabla.hover();
    await page.waitForTimeout(800);

    await frame.locator('[data-testid="visual-more-options-btn"]:visible').first().click();
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
      writeFileSync(`${downloadDir}/debug-99-error-iframe.html`, await page.frameLocator("iframe").locator("html").evaluate((e) => e.outerHTML));
    } catch {
      // sin HTML de diagnóstico, no pasa nada
    }
    throw err;
  } finally {
    await browser.close();
  }
}

// La página "Causas del quiebre" es más alta que la pantalla y se desplaza
// por dentro del iframe de Power BI: scrollIntoView de Playwright no llega
// (el hover vencía a los 30 s con la tabla fuera de pantalla — corrida
// 37834694993), así que se baja con la rueda hasta que la tabla asome.
async function bajarHastaTabla(tabla, page, downloadDir) {
  const centro = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  for (let intento = 0; intento < 20; intento++) {
    const box = await tabla.boundingBox().catch(() => null);
    console.log(`Tabla: y=${box?.y} alto=${box?.height}`);
    if (box && box.height > 0 && box.y > 140 && box.y < VIEWPORT.height - 120) return;
    await page.mouse.move(centro.x, centro.y);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(500);
  }
  await debugShot(page, downloadDir, "03d-tabla-no-visible");
  console.warn("No se logró dejar la tabla a la vista tras bajar el reporte.");
}

// El <visual-container> de Power BI mide 0 de alto (corrida 37837032220:
// y=104 alto=0), así que no sirve para hacer scroll ni hover. En cambio el
// encabezado de columna sí es un elemento real con tamaño: "Última Causa
// Quiebre" solo existe en esta tabla (el slicer se llama "Causa quiebre").
async function ubicarBotonExpandir(frame) {
  const candidatos = frame.locator('[data-testid*="level"]:visible, [data-testid*="expand"]:visible, [data-testid*="drill"]:visible');
  const n = await candidatos.count();
  const info = [];
  for (let i = 0; i < n; i++) {
    const b = candidatos.nth(i);
    info.push({
      i,
      testid: await b.getAttribute("data-testid"),
      label: (await b.getAttribute("aria-label")) || (await b.getAttribute("title")) || "",
    });
  }
  console.log(`Botones de jerarquía visibles: ${JSON.stringify(info)}`);
  // Por nombre: el testid o la etiqueta dicen "expand".
  const porNombre = info.find((b) => /expand/i.test(`${b.testid} ${b.label}`));
  if (porNombre) return candidatos.nth(porNombre.i);
  // Por posición: en la cabecera el orden es ↑ ↓ ⇊ — el que sigue a drill-down.
  const abajo = info.findIndex((b) => b.testid === "drill-down-level-btn");
  if (abajo >= 0 && info[abajo + 1]) return candidatos.nth(abajo + 1);
  throw new Error(`No se encontró el botón "Expandir todo un nivel". Botones: ${JSON.stringify(info)}`);
}

async function ubicarTabla(frame) {
  const encabezado = frame.getByText("Última Causa Quiebre").first();
  await encabezado.waitFor({ state: "attached", timeout: 15000 });
  return encabezado;
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
