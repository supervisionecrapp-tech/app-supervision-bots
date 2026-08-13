# app-supervision-bots

Bots de automatización para App Supervisión — descargan reportes desde
portales de terceros y los cargan directo a Supabase, sin pasar por el
admin-panel manual.

- **[red-sync](./red-sync)** — Red (NARTD, hoy; ABI/VSR pendientes) desde
  el portal Datawalt (Dichter Neira Analytics).
- **[presentismo-sync](./presentismo-sync)** — Marcaciones de Presentismo
  WM desde Power BI Service (bi.frax.com / app.powerbi.com).

Ambos loguean cada corrida (éxito o error) en la tabla `bot_runs` de
Supabase — el admin-panel.html tiene un calendario que lee de ahí para
ver de un vistazo si el bot corrió bien, sin entrar a GitHub Actions.

## Setup (una vez)

En `Settings → Secrets and variables → Actions` de este repo:

- `DATAWALT_USER` / `DATAWALT_PASS` — credenciales del portal Datawalt (red-sync).
- `FRAX_USER` / `FRAX_PASS` — credenciales de Microsoft/Azure AD para
  bi.frax.com (presentismo-sync).
- `SUPABASE_SERVICE_ROLE_KEY` — desde el dashboard de Supabase
  (Project Settings → API → `service_role`/`sb_secret_...`). Da acceso
  total, tratarla como una contraseña. Compartida por los dos bots.

## red-sync

Corre vía [`.github/workflows/red-sync.yml`](./.github/workflows/red-sync.yml):
martes/jueves/domingo 10am Chile (semana actual), y los **martes además**
recarga la semana anterior completa (reemplaza lo ya cargado). También
soporta `workflow_dispatch` manual con categoría/año/mes/semana específicos.

El reporte vive en un `<iframe src="app.powerbi.com">` dentro de Datawalt
(Power BI Embedded, cross-origin) — el bot usa `page.frameLocator()` para
apuntar adentro con selectores DOM reales (`data-testid`,
`.slicerItemContainer[title][aria-level]`), confirmados inspeccionando el
HTML real, no adivinados. Quedan dos clicks por coordenada a propósito
(el ítem "RED" del menú y la pestaña "Detalle") porque son shapes de
Power BI sin texto ni atributo que los distinga — no hay selector real
posible ahí. Ver los comentarios en `red-sync/src/scrape.mjs` para el
detalle de cada selector y por qué.

**Pendiente**: report IDs y columnas de ABI/VSR sin verificar contra un
archivo real todavía (`red-sync/src/scrape.mjs` y `redColumns.mjs`).

## presentismo-sync

Corre vía [`.github/workflows/presentismo-sync.yml`](./.github/workflows/presentismo-sync.yml):
diario, 10am Chile, siempre la fecha de hoy (o una fecha específica vía
`workflow_dispatch`).

A diferencia de Datawalt, acá es Power BI Service real (no embebido) con
login de Microsoft/Azure AD — sin MFA en la cuenta usada, así que el
login se automatiza con los IDs estándar de Microsoft (`#i0116`/`#i0118`/
`#idSIButton9`). El filtro de fecha es un `<input>` de texto real
(`aria-label` empieza con "Fecha de inicio"/"Fecha de finalización",
formato `M/d/yyyy`) — mucho más simple que el árbol de checkboxes de
Red. El resto (exportar datos) usa los mismos `data-testid` que red-sync
porque es el mismo motor Power BI.

**Sin verificar todavía**: una corrida real completa de punta a punta
(se armó en base a la exploración interactiva + un export manual de
prueba, que sí confirmó la hoja "Export" y las columnas). Revisar el
artifact `debug-screenshots-presentismo` de la primera corrida real.

## Correr local (para debuggear)

```bash
cd red-sync   # o presentismo-sync
npm install
npx playwright install chromium
# red-sync:
DATAWALT_USER=... DATAWALT_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run sync
# presentismo-sync:
FRAX_USER=... FRAX_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run sync
```
