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

  // controltienda.com está detrás de Cloudflare y bloquea Chromium
  // headless por completo (se queda atascado en la pantalla "Performing
  // security verification", nunca resuelve el challenge JS) — confirmado
  // en pruebas reales el 2026-08-19. headless:false lo pasa como lo pasa
  // cualquier navegador real; en CI (sin sesión gráfica) esto corre bajo
  // Xvfb (ver .github/workflows/presentismo-sync.yml).
  const browser = await chromium.launch({ headless: false });
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

    await page.waitForURL(/index\.php/, { timeout: 20000 });
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
