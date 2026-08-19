import { chromium } from "playwright";

// Frax migró el portal de Presentismo de Power BI (bi.frax.cl) a un portal
// propio "APE2" servido en controltienda.com — reescrito completo el
// 2026-08-19 tras confirmar el cambio en vivo con el usuario. El dato final
// es el mismo (marcaciones de entrada/salida por persona/local), pero login
// y export son mucho más simples que con Power BI: login propio (empresa
// RUT + clave, sin Azure AD) y un botón "Exportar Excel" que dispara una
// descarga GET directa (exportar_detalle_xlsx.php), sin diálogos ni
// overlays intermedios.
export const VIEWPORT = { width: 1440, height: 900 };

const BASE_URL = "https://www.controltienda.com/proveedor_server";

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

export async function scrapePresentismoExport({ fecha, datawaltUser, datawaltPass, downloadDir }) {
  const fechaStr = toISODate(fecha);

  // controltienda.com está detrás de Cloudflare y le muestra un desafío
  // JS ("Verifica que tú eres un ser humano") a cualquier tráfico
  // automatizado. Probado en vivo el 2026-08-19:
  //  - headless (bundled Chromium de Playwright): nunca resuelve el
  //    desafío, se queda pegado indefinidamente.
  //  - headed con Xvfb en GitHub Actions (IP de datacenter): escala a un
  //    checkbox de Cloudflare Turnstile que no se puede ni se debe
  //    resolver por automatización.
  //  - headed con channel:"chrome" (el Chrome real instalado, no el
  //    Chromium embebido) desde esta IP residencial: el desafío se
  //    resuelve solo en ~10s, sin checkbox. Por eso se usan ambas cosas
  //    a la vez — el Chrome del sistema, no headless — y por eso este
  //    bot corre localmente (Programador de tareas de Windows, ver
  //    presentismo-sync/run-local.ps1) en vez de en GitHub Actions.
  // --window-position lo saca de la pantalla visible para no interrumpir
  // al usuario; sigue siendo un Chrome real y visible para Cloudflare,
  // solo fuera del área del monitor.
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: ["--window-position=-2400,0"],
  });
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE_URL}/login.php`);
    await debugShot(page, downloadDir, "00-login-page");

    // El formulario trae un campo señuelo (#usuario_v2 — width/height 0 vía
    // CSS pero no display:none, autocomplete="username") además del real
    // (#usuario, autocomplete="organization") — un honeypot anti-bot
    // confirmado inspeccionando el DOM en vivo. Como llenamos por selector
    // específico y no "todos los input visibles/de texto", nunca lo
    // tocamos, igual que haría un usuario real.
    await page.fill("#usuario", datawaltUser);
    await page.fill("#clave", datawaltPass);
    await page.click("button.btn-login");

    // Timeout largo: el desafío de Cloudflare mencionado arriba puede
    // tardar hasta ~20s en resolverse solo antes de redirigir.
    await page.waitForURL(/index\.php/, { timeout: 45000 });
    await debugShot(page, downloadDir, "01-logged-in");

    // Aviso de "cuenta con pago pendiente" — no está claro si aparece
    // siempre o depende del estado de la cuenta, por eso timeout corto y
    // sin bloquear el flujo si no sale.
    const cerrarImpago = page.locator("#btnCerrarImpago");
    if (await cerrarImpago.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cerrarImpago.click();
      await page.waitForTimeout(300);
    }

    await page.goto(`${BASE_URL}/reportes/`);
    await page.waitForSelector("#btn-export-detalle", { timeout: 20000 });
    await debugShot(page, downloadDir, "02-reportes-loaded");

    // Los filtros de fecha son inputs type=date nativos (value YYYY-MM-DD)
    // — a diferencia de Power BI, no hay overlay de calendario que cerrar
    // ni hace falta escribir en un orden particular.
    await page.fill("#f-fi", fechaStr);
    await page.fill("#f-ff", fechaStr);
    await page.click("#btn-aplicar");

    // La tabla "Detalle de marcas" se recarga vía AJAX (DataTables server-side,
    // api_detalle.php) — no hay un selector confiable de "listo", se espera
    // un tiempo fijo igual que se hacía con el canvas de Power BI.
    await page.waitForTimeout(3000);
    await debugShot(page, downloadDir, "03-fecha-filtrada");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#btn-export-detalle"),
    ]);

    const filePath = `${downloadDir}/presentismo-${fechaStr}.xlsx`;
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
