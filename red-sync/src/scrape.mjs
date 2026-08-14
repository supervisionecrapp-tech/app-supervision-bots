import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

// El reporte de Datawalt vive dentro de un <iframe src="https://app.powerbi.com/...">
// (Power BI Embedded, cross-origin respecto a dichter-neira.datawalt.app).
// Playwright SÍ puede apuntar adentro de un iframe cross-origin vía
// page.frameLocator() — a diferencia de JS de página normal, no lo
// bloquea CORS. La mayoría de los controles del reporte (filtro, botón
// de drill-down, menú de exportar) tienen selectores DOM reales y
// estables (confirmado inspeccionando el HTML real con devtools, no
// adivinado) — con eso alcanza para no depender de coordenadas de
// pantalla en la parte más frágil del flujo.
//
// Dos cosas siguen siendo coordenadas, a propósito: el ítem "RED" del
// menú lateral y la pestaña "Detalle" son shapes de Power BI (botones de
// bookmark hechos con figuras básicas) sin texto ni atributo que los
// distinga de cualquier otro shape del reporte — no hay selector real
// posible ahí. Son clicks simples y de navegación fija (poco riesgo de
// romperse) así que no vale la pena perseguir una alternativa.
export const VIEWPORT = { width: 1920, height: 889 };

const REPORT_URLS = {
  // NARTD = "Reporte - Embonor Agencia". Calibrado y verificado esta sesión.
  NARTD: "https://dichter-neira.datawalt.app/report/736",
  // ABI: layout de RED>Detalle idéntico a NARTD (mismo botón de drill,
  // mismo mecanismo de export) y columnas del Excel confirmadas EXACTAS
  // contra un archivo real — redColumns.mjs no necesitó ningún ajuste.
  ABI: "https://dichter-neira.datawalt.app/report/750",
  // VSR: mismo mecanismo de export, PERO la tabla "Resumen de RED" carga
  // ya parcialmente expandida en vez de plana (ver el colapso con
  // drill-up-level-btn más abajo, necesario solo para esta categoría en
  // la práctica). Columnas del Excel NO confirmadas todavía contra un
  // archivo real (se alcanzó a exportar pero no se llegó a inspeccionar
  // el resultado en esta sesión) — redColumns.mjs.VSR sigue siendo el
  // mapeo viejo sin verificar.
  VSR: "https://dichter-neira.datawalt.app/report/754",
};

// Únicas coordenadas que quedan — ver el comentario grande de más arriba
// sobre por qué RED/Detalle no tienen selector real posible.
const COORDS = {
  sidebarRed: { x: 136, y: 442 },
  tabDetalle: { x: 449, y: 147 },
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
    await page.waitForLoadState("networkidle").catch(() => {});

    // Diagnóstico: si el login de más abajo falla, esto deja evidencia de
    // qué página/estado real encontró el runner (podría ser un bloqueo
    // anti-bot por IP de datacenter, un timing distinto al local, etc.)
    await debugShot(page, downloadDir, "00-post-goto");
    writeFileSync(`${downloadDir}/debug-00-post-goto.html`, await page.content());
    console.log(`URL tras goto: ${page.url()}`);

    // Login real (verificado en vivo el 2026-08-13, no adivinado): son DOS
    // pasos, no uno.
    // 1) login.datawalt.app muestra una pantalla de bienvenida con un solo
    //    botón "Iniciar sesión" (sin accessible name, pero es el único
    //    <button> de la página).
    // 2) Ese botón redirige a un dominio TOTALMENTE distinto — AWS Cognito
    //    Hosted UI (datawalt-app.auth.us-east-1.amazoncognito.com) — que es
    //    donde están los campos reales: placeholders "Ingrese el nombre de
    //    usuario" / "Ingrese la contraseña", no "Correo"/"Contraseña".
    await page.getByText("Iniciar sesión", { exact: true }).click();
    await page.waitForURL(/amazoncognito\.com/, { timeout: 15000 });

    await page.getByPlaceholder("Ingrese el nombre de usuario").fill(datawaltUser);
    await page.getByPlaceholder("Ingrese la contraseña").fill(datawaltPass);
    await page.locator('button[type="submit"]').click();
    await page.waitForLoadState("networkidle");

    // El login puede redirigir directo al reporte (callbackUrl) o al home;
    // forzar la navegación al reporte de nuevo asegura que quedemos ahí.
    await page.goto(reportUrl);
    // El embed de Power BI (canvas/WebGL) tarda en pintar y no hay forma de
    // esperarlo con un selector real ANTES de entrar al iframe. 10s dio
    // margen de sobra en una corrida real del runner de GitHub Actions.
    await page.waitForTimeout(10000);

    await debugShot(page, downloadDir, "01-report-loaded");

    const frame = page.frameLocator("iframe");

    // RED y Detalle: ver comentario grande arriba, son shapes sin selector
    // real posible. Esperas generosas a propósito: cada navegación repinta
    // el canvas entero y en el runner tarda bastante más que en local.
    await page.mouse.click(COORDS.sidebarRed.x, COORDS.sidebarRed.y);
    await page.waitForTimeout(8000);
    await page.mouse.click(COORDS.tabDetalle.x, COORDS.tabDetalle.y);
    await page.waitForTimeout(8000);
    await debugShot(page, downloadDir, "02-red-detalle");

    await selectWeek(frame, page, { anio, mes, semana }, downloadDir);

    // El .vcHeader que contiene estos botones tiene tamaño CERO hasta que
    // el mouse pasa sobre la visualización entera (la tabla) — es un
    // hover-reveal atado al contenedor, no al botón. drillDownBtn.hover()
    // no lo dispara porque el botón no tiene bounding box todavía cuando
    // Playwright intenta ubicarlo. La solución es mover el mouse real a un
    // punto amplio dentro de la tabla (coordenada de página, no del
    // iframe — funciona igual que antes porque page.screenshot() ya
    // captura el iframe compuesto en coordenadas de página) y RECIÉN
    // ahí clickear por selector.
    const TABLE_AREA = { x: 700, y: 650 };

    // VSR (a diferencia de NARTD/ABI) carga la tabla "Resumen de RED" YA
    // parcialmente expandida (Planta > Oficina anidados desde el
    // arranque, confirmado en vivo) en vez de plana en el nivel más alto
    // — si se le suman los 4 clicks de "bajar nivel" sobre ese estado, no
    // queda en Sala. Por eso primero se colapsa todo con "Resumir"
    // ([data-testid="drill-up-level-btn"], el ícono ↑) las mismas veces
    // que se va a drillear, para arrancar siempre desde el mismo estado
    // plano sin importar la categoría.
    //
    // OJO: cuando ya está en el nivel más alto (caso NARTD/ABI, que
    // arrancan colapsados) este botón viene con el atributo `disabled`
    // (confirmado en el HTML real) — un `.click()` de Playwright sobre un
    // botón disabled se queda esperando a que se habilite y nunca pasa,
    // cuelga el flujo entero. Por eso se chequea `isEnabled()` antes de
    // cada click y se corta el loop apenas está deshabilitado (ya no hay
    // más para colapsar).
    const drillUpBtn = frame.locator('[data-testid="drill-up-level-btn"]');
    for (let i = 0; i < DRILL_DOWN_STEPS; i++) {
      await page.mouse.move(TABLE_AREA.x, TABLE_AREA.y);
      await page.waitForTimeout(300);
      const puedeColapsar = await drillUpBtn.isEnabled().catch(() => false);
      if (!puedeColapsar) break;
      await drillUpBtn.click();
      await page.waitForTimeout(1500);
    }
    await debugShot(page, downloadDir, "03b-colapsado");

    // Cada drill-down re-consulta el dataset y repinta la tabla entera.
    // Se deja un screenshot por nivel: si el bot termina exportando el
    // nivel equivocado (Planta en vez de Sala), estas capturas dicen
    // exactamente en qué paso se perdió el click.
    const drillDownBtn = frame.locator('[data-testid="drill-down-level-btn"]');
    for (let i = 0; i < DRILL_DOWN_STEPS; i++) {
      await page.mouse.move(TABLE_AREA.x, TABLE_AREA.y);
      await page.waitForTimeout(300);
      await drillDownBtn.click();
      await page.waitForTimeout(4000);
      await debugShot(page, downloadDir, `04-drill-${i + 1}`);
    }

    const moreOptionsBtn = frame.locator('[data-testid="visual-more-options-btn"]');
    await page.mouse.move(TABLE_AREA.x, TABLE_AREA.y);
    await page.waitForTimeout(300);
    await moreOptionsBtn.click();
    await page.waitForTimeout(1500);
    await debugShot(page, downloadDir, "05a-menu-abierto");

    await frame.locator('[data-testid="pbimenu-item.Exportar datos"]').click();
    await page.waitForTimeout(2500);
    await debugShot(page, downloadDir, "05-dialogo-exportar");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      frame.locator('[data-testid="export-btn"]').click(),
    ]);

    const filePath = `${downloadDir}/red-${categoria}-${anio}-${semana}.xlsx`;
    await download.saveAs(filePath);
    return filePath;
  } catch (err) {
    // Screenshot de "dónde quedó pintada la página" en el momento exacto
    // del error — sea cual sea el paso que falló, sin tener que agregar un
    // debugShot manual en cada línea.
    await debugShot(page, downloadDir, "99-error");
    throw err;
  } finally {
    await browser.close();
  }
}

// El árbol de filtro Año>Mes>Semana SÍ tiene DOM real dentro del iframe:
// cada fila es un <div class="slicerItemContainer" role="treeitem"
// title="<texto visible>" aria-level="N" aria-expanded="...">, con un
// <div class="expandButton"> (chevron) y <div class="slicerCheckbox">
// adentro. aria-level confirmado en vivo con devtools: 1=año, 2=mes,
// 3=semana (visto en un item title="12" con aria-level="2" y
// aria-setsize="7", consistente con ser un mes). Esto reemplaza todas
// las coordenadas que usaba la versión anterior de este archivo.
//
// El botón "Seleccionar todo" es la única pieza de este árbol sin HTML
// confirmado a mano todavía — se asume el mismo patrón (title="Seleccionar
// todo") por consistencia con el resto de los items. Si falla, revisar
// debug-03a-filtro-mes-expandido.png de esa corrida.
//
// Secuencia (igual que antes, ahora con selectores en vez de píxeles):
//  1. Abrir el dropdown (esto sigue siendo coordenada: el control que lo
//     abre es el mismo tipo de shape sin selector que RED/Detalle).
//  2. El estado default de una sesión nueva viene con el AÑO actual ya
//     marcado (ni "todo" ni "nada") — un click en "Seleccionar todo" lo
//     COMPLETA a todo marcado; hace falta un SEGUNDO click para vaciarlo
//     del todo y partir limpio. Contraintuitivo pero así se comporta.
//  3. Expandir el año buscado (chevron) → aparecen sus meses.
//  4. Expandir el mes buscado (chevron) → aparecen sus semanas.
//  5. Marcar el checkbox de la semana buscada.
// Las semanas se agrupan bajo el mes de SU LUNES, no el del día 1 del mes
// (ver firstIsoWeekOfMonth en isoWeek.mjs) — por eso agosto 2026 arranca
// en la semana 32, no la 31.
const WEEK_FILTER_DROPDOWN = { x: 1843, y: 160 };

async function selectWeek(frame, page, { anio, mes, semana }, downloadDir) {
  await page.mouse.click(WEEK_FILTER_DROPDOWN.x, WEEK_FILTER_DROPDOWN.y);
  await page.waitForTimeout(1000);

  const selectAll = frame.locator('.slicerItemContainer[title="Seleccionar todo"] .slicerCheckbox');
  await selectAll.click();
  await page.waitForTimeout(500);
  await selectAll.click();
  await page.waitForTimeout(500);

  const yearItem = frame.locator(`.slicerItemContainer[title="${anio}"][aria-level="1"]`);
  await yearItem.locator(".expandButton").click();
  await page.waitForTimeout(500);

  const monthItem = frame.locator(`.slicerItemContainer[title="${mes}"][aria-level="2"]`);
  await monthItem.locator(".expandButton").click();
  await page.waitForTimeout(500);
  await debugShot(page, downloadDir, "03a-filtro-mes-expandido");

  const weekItem = frame.locator(`.slicerItemContainer[title="${semana}"][aria-level="3"]`);
  await weekItem.locator(".slicerCheckbox").click();
  await page.waitForTimeout(1500);
  await debugShot(page, downloadDir, "03-filtro-semana");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

async function debugShot(page, dir, name) {
  try {
    await page.screenshot({ path: `${dir}/debug-${name}.png` });
  } catch {
    // no bloquear el flujo por un screenshot fallido
  }
}
