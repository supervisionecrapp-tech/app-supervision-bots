# app-supervision-bots

Bots de automatización para App Supervisión. Por ahora: **red-sync**, que
descarga el reporte de Red (NARTD/ABI/VSR) desde el portal de Datawalt
(Dichter Neira Analytics) y lo carga directo a Supabase, sin pasar por el
admin-panel manual.

## red-sync

Ver [`red-sync/`](./red-sync). Corre vía GitHub Actions
([`.github/workflows/red-sync.yml`](./.github/workflows/red-sync.yml)):

- **Diario** (cron 13:00 UTC ≈ 09:00 Chile): sincroniza la semana actual.
- **Manual** (`workflow_dispatch` en la pestaña Actions de GitHub): permite
  elegir categoría + año/mes/semana específicos.

### Setup (una vez)

En `Settings → Secrets and variables → Actions` de este repo, agregar:

- `DATAWALT_USER` / `DATAWALT_PASS` — credenciales del portal Datawalt.
- `SUPABASE_SERVICE_ROLE_KEY` — desde el dashboard de Supabase
  (Project Settings → API → `service_role`/`sb_secret_...`). Da acceso
  total, tratarla como una contraseña.

### Estado conocido / limitaciones

El reporte de Datawalt es Power BI embebido — se renderiza en
canvas/WebGL, así que el bot interactúa por **coordenadas de pantalla
fijas**, no por selectores DOM (no hay selectores DOM posibles ahí). Esto
es inherentemente más frágil que una automatización normal:

- Si Dichter Neira rediseña el reporte, las coordenadas en
  `src/scrape.mjs` (objeto `COORDS`) hay que recalibrarlas.
- **El filtro de año/mes/semana es lo menos probado.** Para la corrida
  diaria (semana actual) se confía en que el reporte ya viene con el
  año/mes actual expandido por default en el árbol de filtro, y no se
  toca. Elegir un año/mes/semana distinto al default vía
  `workflow_dispatch` probablemente NO funcione todavía tal cual —
  revisar el screenshot de debug `03-filtro-semana` de esa corrida y
  ajustar `selectWeek` en `scrape.mjs` en consecuencia.
- Cada corrida sube capturas de pantalla de cada paso como artifact de la
  Action (`debug-screenshots`) — usarlas para diagnosticar/calibrar en
  vez de adivinar.
- Las columnas del Excel de NARTD ya se verificaron contra un archivo
  real (2026-08-13). Las de VSR/ABI en `src/redColumns.mjs` **no** están
  verificadas todavía — son las que ya traía el importador viejo y
  podrían estar tan desactualizadas como lo estaba NARTD.
- Los report IDs de ABI y VSR (`REPORT_URLS` en `scrape.mjs`) todavía no
  se completaron — hay que abrir esos dos reportes en Datawalt y anotar
  el id de la URL.

### Correr local (para debuggear)

```bash
cd red-sync
npm install
npx playwright install chromium
DATAWALT_USER=... DATAWALT_PASS=... SUPABASE_SERVICE_ROLE_KEY=... npm run sync
```
