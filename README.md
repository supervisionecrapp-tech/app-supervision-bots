# app-supervision-bots

Bots de automatización para App Supervisión — descargan reportes desde
portales de terceros y los cargan directo a Supabase, sin pasar por el
admin-panel manual.

- **[red-sync](./red-sync)** — Red (NARTD, hoy; ABI/VSR pendientes) desde
  el portal Datawalt (Dichter Neira Analytics).
- **[presentismo-sync](./presentismo-sync)** — Marcaciones de Presentismo
  WM desde Power BI Service (bi.frax.cl / app.powerbi.com).
- **[teamcore-sync](./teamcore-sync)** — Teamcore Usabilidad desde el
  portal propio de Teamcore (cocacolaembonor.cl.teamcore.net).

Los tres loguean cada corrida (éxito o error) en la tabla `bot_runs` de
Supabase — el admin-panel.html tiene un calendario que lee de ahí para
ver de un vistazo si el bot corrió bien, sin entrar a GitHub Actions.

## Setup (una vez)

En `Settings → Secrets and variables → Actions` de este repo:

- `DATAWALT_USER` / `DATAWALT_PASS` — credenciales del portal Datawalt (red-sync).
- `FRAX_USER` / `FRAX_PASS` — credenciales de Microsoft/Azure AD para
  bi.frax.cl (presentismo-sync).
- `TEAMCORE_USER` / `TEAMCORE_PASS` — credenciales del portal de Teamcore
  (teamcore-sync).
- `SUPABASE_SERVICE_ROLE_KEY` — desde el dashboard de Supabase
  (Project Settings → API → `service_role`/`sb_secret_...`). Da acceso
  total, tratarla como una contraseña. Compartida por los tres bots.

## red-sync

Corre vía [`.github/workflows/red-sync.yml`](./.github/workflows/red-sync.yml):
**todos los días 11am Chile** (semana actual, las 3 categorías NARTD+ABI+VSR en
paralelo), y los **martes además** recarga la semana anterior completa
(reemplaza lo ya cargado). También soporta `workflow_dispatch` manual — el
dropdown "categoria" limita esa corrida a una sola categoría (default NARTD);
para probar las 3 a mano hay que correr "Run workflow" tres veces, una por
categoría.

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
cada 2 horas de 9:00 a 23:00 Chile (día actual), más una corrida especial
a las 7:00 Chile que carga el día ANTERIOR completo. También soporta
`workflow_dispatch` manual con una fecha específica.

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

## teamcore-sync

Corre vía [`.github/workflows/teamcore-sync.yml`](./.github/workflows/teamcore-sync.yml):
cada 2 horas de 9:00 a 23:00 Chile (mismo horario que presentismo-sync,
siempre carga el día actual — el dato es booleano por día, no hace falta
una corrida especial de "día anterior"). También soporta
`workflow_dispatch` manual con una fecha específica.

A diferencia de los otros dos, el portal de Teamcore **no es Power BI**
— es una app Django propia con login usuario/contraseña normal y CSRF
estándar de Django, así que el bot **no usa Playwright**: todo el flujo
(login, pedir la descarga vía POST AJAX a `/corex/solicitud_descarga`,
sondear `/corex/downloads` hasta que la fila quede "Completado", bajar
el archivo) se hace con `fetch` + un cookie jar manual en
`teamcore-sync/src/scrape.mjs`. El link final de descarga apunta directo
a un bucket S3 público, sin necesidad de reenviar cookies de sesión.

Descarga el reporte "Detalles de productos" (`reporte=DETALLE` en el
form), que es el que trae la hoja "Toma detalles" con las columnas
`Código Local`/`Fecha` que espera `teamcore_usabilidad_registros` — mismo
mapeo que la sección "Teamcore — Usabilidad" de `admin-panel.html`.

**Ojo**: el mismo reporte (mismo rango de fechas) lo pide también otro
proceso ajeno a este repo, con mucha frecuencia (cada 30-60 min todo el
día) — la tabla de `/corex/downloads` no tiene ningún id que distinga
"esta solicitud es la nuestra", así que el bot asume que la primera fila
que matchea tipo+rango es la suya. En el peor caso de carrera agarra la
fila del otro proceso en vez de la propia, pero para el mismo rango de
fechas el contenido es el mismo dato fuente, así que no cambia el
resultado.

## Correr local (para debuggear)

```bash
cd red-sync   # o presentismo-sync / teamcore-sync
npm install
npx playwright install chromium   # no aplica a teamcore-sync, no usa Playwright
# red-sync:
DATAWALT_USER=... DATAWALT_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run sync
# presentismo-sync:
FRAX_USER=... FRAX_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run sync
# teamcore-sync:
TEAMCORE_USER=... TEAMCORE_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run sync
```
