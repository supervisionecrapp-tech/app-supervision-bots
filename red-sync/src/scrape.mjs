import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { firstIsoWeekOfMonth } from "./isoWeek.mjs";

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
  // Report IDs confirmados el 2026-08-13 (home del portal → cada tarjeta
  // de reporte). Layout/coordenadas de RED>Detalle NO verificadas en
  // estos dos todavía — probablemente calcen porque parecen la misma
  // plantilla de reporte que NARTD, pero no asumir sin probar primero.
  ABI: "https://dichter-neira.datawalt.app/report/750",
  VSR: "https://dichter-neira.datawalt.app/report/754",
};

// Coordenadas calibradas a mano el 2026-08-13 contra el reporte NARTD
// (id 736), pestaña Detalle, con el viewport de arriba. Puntos de fallo
// más probables si algo se rompe: el reporte cambió de layout, o Datawalt
// actualizó la versión de Power BI Embedded.
const COORDS = {
  sidebarRed: { x: 136, y: 442 },
  tabDetalle: { x: 449, y: 147 },
  // La barra del visual tiene 7 íconos: ↑ (1347) ↓ (1374) ↓↓ (1401)
  // ⤋ (1430) ☰ (1466) ⧉ (1492) ⋯ (1522), todos en y≈587.
  // OJO: el "↓" simple NO baja de nivel — es el toggle de modo drill de
  // Power BI (se clickeó 4 veces en una corrida real y quedó todo en
  // nivel Planta, encendiendo/apagando el modo). El que baja la tabla
  // entera un nivel es el "↓↓" doble ("Ir al siguiente nivel de la
  // jerarquía"), que además reemplaza el nivel en vez de anidarlo — por
  // eso el export final trae solo la columna "Sala".
  drillDownArrow: { x: 1401, y: 587 },
  exportMenuButton: { x: 1518, y: 585 },
  exportarDatosItem: { x: 1596, y: 606 },
  exportarConfirmButton: { x: 1157, y: 745 },
};

// Árbol de filtro Año>Mes>Semana, calibrado en vivo el 2026-08-13 contra
// una sesión recién logueada (viewport 1568 de la herramienta de browser,
// escalado ×SCALE a los 1920 reales del bot). Secuencia verificada a mano:
//  1. Abrir el dropdown.
//  2. El estado default de una sesión nueva viene con el AÑO actual ya
//     marcado (ni "todo" ni "nada") — un click en "Seleccionar todo" lo
//     COMPLETA a todo marcado; hace falta un SEGUNDO click para vaciarlo
//     del todo y partir limpio. Contraintuitivo pero así se comporta.
//  3. Expandir el año (chevron) → aparecen los meses 1..mes-actual.
//  4. Expandir el mes buscado (chevron) → aparecen sus semanas.
//  5. Marcar el checkbox de la semana buscada.
// Las semanas se agrupan bajo el mes de SU LUNES, no el del día 1 del
// mes (ver firstIsoWeekOfMonth en isoWeek.mjs) — por eso agosto 2026
// arranca en la semana 32, no la 31.
const SCALE = 1920 / 1568;
const scaled = (x, y) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) });
const WEEK_FILTER = {
  dropdown: scaled(1505, 131),
  selectAll: scaled(1379, 155),
  yearChevron: scaled(1360, 174),
  monthChevronX: Math.round(1381 * SCALE),
  weekCheckboxX: Math.round(1428 * SCALE),
  // Fila del mes N dentro del árbol ya expandido (año 2026 primero).
  monthRowY: (mes) => Math.round((174 + mes * 19) * SCALE),
  // Fila de la semana `weekIndex`-ésima (0-based) dentro del mes ya
  // expandido.
  weekRowY: (mes, weekIndex) => Math.round((174 + mes * 19 + 17 + weekIndex * 19) * SCALE),
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
    // esperarlo con un selector real. 4s alcanzaba en local pero en el
    // runner de GitHub Actions todavía estaba mostrando el spinner de
    // carga a los 4s (visto en debug-01-report-loaded de la corrida real)
    // — el click de "RED" se perdía en el vacío mientras cargaba. 10s dio
    // margen de sobra en esa misma corrida.
    await page.waitForTimeout(10000);

    await debugShot(page, downloadDir, "01-report-loaded");

    // Cada navegación dentro del reporte vuelve a renderizar todo el canvas
    // desde cero — en el runner eso tarda bastante más que en local (se vio
    // el panel todavía en blanco 1.5s después de entrar a RED). Estas
    // esperas son generosas a propósito: el costo de esperar de más es
    // trivial comparado con una corrida entera perdida por clickear antes
    // de tiempo, que además falla de forma silenciosa.
    await page.mouse.click(COORDS.sidebarRed.x, COORDS.sidebarRed.y);
    await page.waitForTimeout(8000);
    await page.mouse.click(COORDS.tabDetalle.x, COORDS.tabDetalle.y);
    await page.waitForTimeout(8000);
    await debugShot(page, downloadDir, "02-red-detalle");

    await selectWeek(page, { anio, mes, semana }, downloadDir);

    // Cada drill-down re-consulta el dataset y repinta la tabla entera.
    // Se deja un screenshot por nivel: si el bot termina exportando el
    // nivel equivocado (Planta en vez de Sala), estas capturas dicen
    // exactamente en qué paso se perdió el click.
    for (let i = 0; i < DRILL_DOWN_STEPS; i++) {
      // Hover primero: la barra de herramientas del visual (donde vive la
      // flecha) solo aparece cuando el mouse está sobre la tabla.
      await page.mouse.move(COORDS.drillDownArrow.x, COORDS.drillDownArrow.y);
      await page.waitForTimeout(500);
      await page.mouse.click(COORDS.drillDownArrow.x, COORDS.drillDownArrow.y);
      await page.waitForTimeout(4000);
      await debugShot(page, downloadDir, `04-drill-${i + 1}`);
    }

    await page.mouse.move(COORDS.exportMenuButton.x, COORDS.exportMenuButton.y);
    await page.waitForTimeout(500);
    await page.mouse.click(COORDS.exportMenuButton.x, COORDS.exportMenuButton.y);
    await page.waitForTimeout(1500);
    await debugShot(page, downloadDir, "05a-menu-abierto");
    await page.mouse.click(COORDS.exportarDatosItem.x, COORDS.exportarDatosItem.y);
    await page.waitForTimeout(2500);
    await debugShot(page, downloadDir, "05-dialogo-exportar");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.mouse.click(COORDS.exportarConfirmButton.x, COORDS.exportarConfirmButton.y),
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

// Ver el comentario largo junto a WEEK_FILTER más arriba para la
// secuencia completa y por qué el doble click en "Seleccionar todo" es
// necesario. Best-effort: probado en vivo solo para (2026, 8, 33) — el
// screenshot "03-filtro-semana" de cada corrida es la forma de confirmar
// que efectivamente marcó la semana correcta antes de confiar en el dato.
async function selectWeek(page, { anio, mes, semana }, downloadDir) {
  await page.mouse.click(WEEK_FILTER.dropdown.x, WEEK_FILTER.dropdown.y);
  await page.waitForTimeout(1000);

  await page.mouse.click(WEEK_FILTER.selectAll.x, WEEK_FILTER.selectAll.y);
  await page.waitForTimeout(500);
  await page.mouse.click(WEEK_FILTER.selectAll.x, WEEK_FILTER.selectAll.y);
  await page.waitForTimeout(500);

  await page.mouse.click(WEEK_FILTER.yearChevron.x, WEEK_FILTER.yearChevron.y);
  await page.waitForTimeout(500);

  const monthY = WEEK_FILTER.monthRowY(mes);
  await page.mouse.click(WEEK_FILTER.monthChevronX, monthY);
  await page.waitForTimeout(500);

  const weekIndex = semana - firstIsoWeekOfMonth(anio, mes);
  const weekY = WEEK_FILTER.weekRowY(mes, weekIndex);
  await debugShot(page, downloadDir, "03a-filtro-mes-expandido");
  await page.mouse.click(WEEK_FILTER.weekCheckboxX, weekY);
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
