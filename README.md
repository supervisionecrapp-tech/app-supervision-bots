# app-supervision-bots

Bots de automatización para App Supervisión — descargan reportes desde
portales de terceros y los cargan directo a Supabase, sin pasar por el
admin-panel manual.

- **[red-sync](./red-sync)** — Red (NARTD, hoy; ABI/VSR pendientes) desde
  el portal Datawalt (Dichter Neira Analytics).
- **[teamcore-sync](./teamcore-sync)** — Teamcore Usabilidad desde el
  portal propio de Teamcore (cocacolaembonor.cl.teamcore.net).
- **[venta-perdida-sync](./venta-perdida-sync)** — Teamcore Venta Perdida
  desde el "Descargador" de consultas guardadas del mismo portal
  (cocacolaembonor.cl.teamcore.net/core/dashboard/#/v2), reemplazando la
  carga manual de CSV en admin-panel.html.
- **[notificaciones-sync](./notificaciones-sync)** — no scrapea nada: lee
  los indicadores ya cargados por los bots de arriba y le manda un push
  personalizado por OneSignal a cada supervisor/coordinador/admin (resumen
  semanal de Presentismo/Teamcore/Red/Venta Perdida, avance intradía de
  Presentismo+Teamcore, y recordatorio de documentos pendientes).
- **[presentismo-sync](./presentismo-sync)** — Presentismo WM (marcaciones
  entrada/salida) desde el portal APE2 de Frax
  (controltienda.com/proveedor_server). Reemplaza la carga manual de Excel
  en admin-panel.html (sección "Presentismo WM — Marcaciones").
- **[smu-presentismo-sync](./smu-presentismo-sync)** — Presentismo SMU
  (reporte de accesos Ingreso/Salida, sin lógica de horas) desde el portal
  "GeoVictoria Externos" (externos.geovictoria.com/Reports) — cuenta GV
  propia de SMU, distinta de la que usa asistencia-sync por API. Reemplaza
  la carga manual de Excel en panel-cliente.html (sección "Presentismo SMU
  — Reporte de Accesos").

Todos loguean cada corrida (éxito o error) en la tabla `bot_runs` de
Supabase — el admin-panel.html tiene un calendario que lee de ahí para
ver de un vistazo si el bot corrió bien, sin entrar a GitHub Actions.

## Setup (una vez)

En `Settings → Secrets and variables → Actions` de este repo:

- `DATAWALT_USER` / `DATAWALT_PASS` — credenciales del portal Datawalt (red-sync).
- `TEAMCORE_USER` / `TEAMCORE_PASS` — credenciales del portal de Teamcore
  (teamcore-sync, venta-perdida-sync — mismo portal, mismo login).
- `FRAX_USER` / `FRAX_PASS` — credenciales (RUT + clave) del portal APE2 de
  Frax (presentismo-sync).
- `SMU_GV_USER` / `SMU_GV_PASS` — credenciales del portal "GeoVictoria
  Externos" de SMU (externos.geovictoria.com), cuenta propia de SMU — no
  confundir con `GEOVICTORIA_KEY`/`GEOVICTORIA_SECRET` de asistencia-sync,
  que es otra cuenta GV y usa API en vez de login web (smu-presentismo-sync).
- `SUPABASE_SERVICE_ROLE_KEY` — desde el dashboard de Supabase
  (Project Settings → API → `service_role`/`sb_secret_...`). Da acceso
  total, tratarla como una contraseña. Compartida por todos los bots.
- `ONESIGNAL_REST_API_KEY` — solo para `notificaciones-sync`. Mismo valor
  que ya está cargado como secret del proyecto Supabase para la Edge
  Function `send-push` (Project Settings → Edge Functions → Secrets) —
  copiar ese mismo valor acá, no generar uno nuevo.

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

## teamcore-sync

Corre vía [`.github/workflows/teamcore-sync.yml`](./.github/workflows/teamcore-sync.yml):
cada 2 horas de 9:00 a 23:00 Chile, siempre carga el día actual — el dato
es booleano por día, no hace falta una corrida especial de "día
anterior". También soporta `workflow_dispatch` manual con una fecha
específica.

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

## smu-presentismo-sync

Corre vía [`.github/workflows/smu-presentismo-sync.yml`](./.github/workflows/smu-presentismo-sync.yml):
cada 2 horas de 9:00 a 23:00 Chile, siempre carga el día actual — mismo
horario que teamcore-sync. También soporta `workflow_dispatch` manual con
una fecha específica.

El portal "GeoVictoria Externos" de SMU (externos.geovictoria.com) es una
app ASP.NET MVC con login usuario/contraseña por formulario (sin token
anti-forgery) y sesión por cookie — no usa Playwright, todo con `fetch` +
cookie jar manual en `smu-presentismo-sync/src/scrape.mjs`, mismo patrón
que teamcore-sync. A pesar del nombre de dominio, esta es una cuenta
GeoVictoria **distinta** de la que usa `asistencia-sync` por API
(`customerapi.geovictoria.com`) — acá no hay API disponible, solo el
reporte web.

Descarga el reporte "Accesos" (`reportType=Access` en el form) vía
`POST /Reports/AccessExcel`, hoja "Reporte Documentos" con columnas
Rut/Nombre/Acceso(Ingreso|Salida)/Fecha/Local — sin hora, a diferencia de
Presentismo WM. "Presentismo" acá es visitas realizadas (¿pasó esa persona
por la sala ese día?) contra una cantidad de visitas objetivo configurada
a mano en panel-cliente.html (`presentismo_smu_objetivo`, con vigencias),
no horas trabajadas. Cruza por `salas.codigo_cadena` (scoped a holding
SMU) contra el prefijo numérico de la columna Local (ej.
"982 - TEMUCO ALEMANIA" → código "982").

**Sin verificar todavía**: el body exacto de `/Reports/AccessExcel` se
armó a partir de un "Copy as cURL" de un request real generado desde el
navegador del usuario (no se tocó ninguna credencial para conseguirlo),
pero la primera corrida real del bot es la que confirma que el endpoint
devuelve el .xlsx directo y no un flujo de dos pasos como teamcore-sync
(pedido + polling) — si falla con "no devolvió un .xlsx", revisar de
nuevo el flujo real del portal.

## venta-perdida-sync

Corre en **dos fases separadas** (dos workflows), porque a diferencia de
`descarga_excel` (el reporte "DETALLE" que usa teamcore-sync, que resuelve
en segundos) el reporte de Venta Perdida vive en un sistema de "consultas
guardadas" con una cola de proceso lenta y muy intermitente en el portal
— confirmado interactivamente: la misma consulta puede tardar hasta
~45 min o más en pasar de "En cola" a "Exitoso". Un solo workflow
esperando ese tiempo es frágil, así que se separó:

- [`venta-perdida-request.yml`](./.github/workflows/venta-perdida-request.yml) —
  lunes/miércoles/viernes 08:00 Chile. Pide la descarga en el portal
  (`npm run request`) y sale sin esperar el resultado.
- [`venta-perdida-collect.yml`](./.github/workflows/venta-perdida-collect.yml) —
  mismos días, 10:00 Chile (2h después). Busca la descarga pedida antes,
  espera a que quede lista, la baja y la sube a Supabase (`npm run collect`).
- [`venta-perdida-retry.yml`](./.github/workflows/venta-perdida-retry.yml) —
  mismos días, 15:00 Chile (3h después de collect). Si el collect de hoy
  ya quedó success no hace nada; si no, reintenta desde donde haya
  quedado — ver el detalle del reintento más abajo.

Las fases no comparten estado entre sí vía GitHub Actions (no hay ningún
id ni archivo que pasar de una corrida a otra): el nombre que se le pone
a la consulta en Teamcore es **determinístico** (`bot-vp-<año>w<semana>-<fecha
de hoy>`), así que "collect" recalcula el mismo nombre y lo busca por
nombre exacto en `/corex/descargador/jobs/downloads/` — a diferencia del
reporte DETALLE de teamcore-sync (que no tiene ningún id propio y asume
"la primera fila que matchea"), acá el nombre elegido por nosotros ya es
único de por sí. "retry" sí lee estado — pero de `bot_runs` en Supabase,
no de GitHub Actions (ver más abajo).

**Semana pedida — fija por día** (`targetWeekForToday()` en
`src/scrape.mjs`): **lunes pide SOLO la semana ISO anterior** (ya
cerrada, siempre con datos completos); **miércoles y viernes piden SOLO
la semana actual** (para levantar la carga parcial de la semana en curso
a mitad y fin de semana). Ya no hay fallback automático probando la otra
semana dentro de la misma corrida — si el portal estima "0 Bytes" (sin
datos cargados todavía en el sistema origen, confirmado interactivamente
que pasa con la semana ISO recién empezada) la corrida falla y queda para
que "retry" la reintente más tarde, en vez de silenciosamente traer la
semana equivocada.

**Reintento** (`runRetry()` en `src/sync.mjs`): mira los `bot_runs` de
HOY (Chile) para `venta-perdida-sync`. Si ya hay un `collect` exitoso, no
hace nada. Si no, busca el último `request:<jobName>` exitoso de hoy — si
existe, reintenta SOLO la descarga/carga para ese mismo job (no le vuelve
a pedir al portal el mismo reporte). Si tampoco hay una solicitud
exitosa, repite el flujo completo (request + collect) para la semana que
le tocaba a hoy según `targetWeekForToday()`. Las corridas de retry
quedan en `bot_runs` con categoría `retry:collect` o `retry:request:...`
para distinguirlas de las normales.

Confirmado inspeccionando el portal real (Network tab, no adivinado): el
"Descargador" es una API REST propia bajo `/corex/descargador/` (mismo
backend Django/misma sesión de login que usa teamcore-sync, solo que bajo
otra app) — no hace falta Playwright. El archivo final es una URL firmada
de Google Cloud Storage (7 días de validez), descargable sin cookies,
mismo patrón que el bucket S3 de teamcore-sync. Ver los comentarios en
`venta-perdida-sync/src/scrape.mjs` para el detalle de cada endpoint.

El CSV descargado tiene el mismo formato "ORIGINAL" que ya esperaba la
carga manual de admin-panel.html (sección "Teamcore — Venta Perdida") —
`venta-perdida-sync/src/upload.mjs` reutiliza exactamente esa misma
lógica de cruce/recálculo, portada a Node.

**Reemplazo completo por semana + retención de 5 semanas**: antes de
insertar, se borra lo que ya hubiera para el mismo (año, semana) — una
rectificación no hace upsert-y-listo, porque si un producto salió del
archivo nuevo (dejó de tener venta perdida, se descontinuó) un upsert
dejaría la fila vieja como huérfana. Después de cargar, se recorta el
histórico a las últimas 5 semanas distintas cargadas (`VP_RETENCION_SEMANAS`
en `upload.mjs`) — al pasar de 5, se borra la más antigua en cada corrida
nueva, para que la tabla no crezca sin límite. `admin-panel.html` (carga
manual) implementa exactamente el mismo criterio, por separado.

**Sin verificar todavía contra una corrida real completa** — se confirmó
el contrato de la API (preQuery/create/polling/descarga) interactuando
con el portal real, pero la primera corrida automática de punta a punta
(incluida la carga a Supabase) no se ha visto terminar todavía porque el
job de prueba tardaba demasiado para esperarlo en esa sesión. Revisar
`bot_runs` (`bot = 'venta-perdida-sync'`) después de la primera corrida
real (lunes, miércoles o viernes).

## notificaciones-sync

No scrapea ningún portal — lee lo que los otros cuatro bots ya subieron a
Supabase y manda push personalizados por OneSignal (misma API que ya usa la
Edge Function `send-push`, ver `notificaciones-sync/src/onesignal.mjs`).
Corre vía cinco workflows separados, uno por grupo de horario (mismo patrón
de "una fase, un workflow" que `venta-perdida-sync`):

- [`notificaciones-semanal-lunes.yml`](./.github/workflows/notificaciones-semanal-lunes.yml) —
  lunes 10:00 Chile: resumen semanal de Presentismo y Teamcore.
- [`notificaciones-venta-perdida.yml`](./.github/workflows/notificaciones-venta-perdida.yml) —
  lunes 11:00 Chile (después de que `venta-perdida-collect` termine a las
  10:00): resumen semanal de Venta Perdida.
- [`notificaciones-red.yml`](./.github/workflows/notificaciones-red.yml) —
  martes 13:00 Chile: resultados de Red por categoría (NARTD/ABI/VSR).
- [`notificaciones-intradia.yml`](./.github/workflows/notificaciones-intradia.yml) —
  9:10/11:10/13:10/15:10/17:10 Chile (10 min después de cada corrida de
  `teamcore-sync` dentro de esa ventana): avance del día combinado de
  Presentismo + Teamcore.
- [`notificaciones-documentos.yml`](./.github/workflows/notificaciones-documentos.yml) —
  lunes/miércoles/viernes 12:00 Chile: cantidad de documentos pendientes de
  mercaderistas por supervisor.

Destinatarios: todo `profiles` activo con `auth_user_id` (sin eso no hay
`external_id` que targetear en OneSignal — se completa cuando la persona
entra a la app). Supervisor/coordinador reciben el dato acotado a sus
propias salas (`salas.supervisor_id`/`coordinador_id`); admin recibe el
mismo texto pero calculado sobre todas las salas. Si a alguien no le aplica
el indicador (ej. no tiene salas WM para Presentismo, o no le cargaron
Venta Perdida esa semana) simplemente no se le manda esa notificación
puntual, sin error.

Las fórmulas replican exactamente las que ya usa
`mobile/src/hooks/useLobby.ts` (Presentismo/Teamcore/Venta Perdida) y
`mobile/src/db/localQueries.ts` (`getRedPromedios`), recalculadas
server-side para "semana pasada" en vez de "hoy/mes actual" — ver los
comentarios en cada `src/metrics/*.mjs` para el detalle de cada una.

## presentismo-sync

Corre vía [`presentismo-sync.yml`](./.github/workflows/presentismo-sync.yml):
**diario 10:00 Chile**. Filtra el portal APE2 con "desde" = día anterior y
"hasta" = hoy (sin tocar ese campo, a pedido explícito), descarga el Excel
de la tabla "Detalle de marcas" y lo sube a `presentismo_registros` —
mismo mapeo de columnas (`LOCAL`/`RUT PERSONA`/`ENTRADA`/`SALIDA`/etc.,
descartando `FORMATO=SBA`) que ya usaba la carga manual de
admin-panel.html. También soporta `workflow_dispatch` con una fecha
específica (`fecha`, opcional — queda en el campo "hasta"; "desde" sigue
siendo el día anterior a esa).

**A diferencia de los otros bots, usa Python + [Scrapling](https://github.com/D4Vinci/Scrapling)
en vez de Node/Playwright.** Motivo: este mismo bot existió antes en
Node/Playwright (ver git log — "Eliminar presentismo-sync") y se eliminó
porque controltienda.com está detrás de Cloudflare y bloqueaba con un
checkbox Turnstile irresoluble a Chromium headless y a Chrome headed
corriendo desde la IP de datacenter de GitHub Actions (solo funcionaba con
Chrome real desde una IP residencial). `StealthyFetcher` de Scrapling
(navegador Camoufox) con `solve_cloudflare=True` automatiza
específicamente el resuelto de Turnstile, algo que Playwright liso no
hacía — pero **sigue sin garantía**: si el portal escala a un challenge
que Camoufox tampoco resuelve, la corrida falla igual (con 3 reintentos
con espera creciente, igual que los demás bots) y hay que revisar
`bot_runs` (`bot = 'presentismo-sync'`). Si vuelve a fallar de forma
sistemática, el fallback ya probado es la carga semi-manual de
admin-panel.html (sección "Presentismo WM — Marcaciones"), que sigue
intacta y no depende de este bot.

Selectores DOM confirmados contra el portal real en la versión Node
anterior (no adivinados): login por `#usuario`/`#clave` (con honeypot
`#usuario_v2` a evitar), filtros de fecha `#f-fi`/`#f-ff` (inputs
`type=date` nativos), botón "Exportar Excel" `#btn-export-detalle`. Ver
los comentarios en `presentismo-sync/src/scrape.py` para el detalle.

## Correr local (para debuggear)

```bash
cd red-sync   # o teamcore-sync / venta-perdida-sync / notificaciones-sync
npm install
npx playwright install chromium   # no aplica a teamcore-sync, venta-perdida-sync ni notificaciones-sync, no usan Playwright
# red-sync:
DATAWALT_USER=... DATAWALT_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run sync
# teamcore-sync:
TEAMCORE_USER=... TEAMCORE_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run sync
# notificaciones-sync (tipo ∈ presentismo-semanal | teamcore-semanal | red-semanal | venta-perdida-semanal | documentos-pendientes | intradia-combinado):
SUPABASE_SERVICE_ROLE_KEY=... ONESIGNAL_REST_API_KEY=... npm run start -- presentismo-semanal
# venta-perdida-sync (correr "request" y esperar antes de "collect"; "retry" es
# el mismo flujo de recuperación que corre el workflow de retry):
TEAMCORE_USER=... TEAMCORE_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run request
TEAMCORE_USER=... TEAMCORE_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run collect
TEAMCORE_USER=... TEAMCORE_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run retry

# presentismo-sync (Python, no Node — ver la sección de arriba):
cd presentismo-sync
pip install -r requirements.txt
scrapling install
FRAX_USER=... FRAX_PASS=... SUPABASE_SERVICE_ROLE_KEY=... python src/sync.py
```
