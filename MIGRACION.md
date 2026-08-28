# Migración del repo de bots a la cuenta de la app

Estado: **preparado, sin ejecutar**. Origen `StarCrushed/app-supervision-bots`
(cuenta personal), destino `supervisionecrapp-tech/app-supervision-bots`.

Motivo: las automatizaciones viven hoy en una cuenta personal. Deben quedar en
la cuenta de la app para que no dependan de una persona, y para separar el
presupuesto de minutos de Actions.

---

## 1. Alcance

| Qué | Cuánto | Notas |
|---|---|---|
| Repo | 1 (privado, 290 KB, rama `main`) | único colaborador: `StarCrushed` |
| Workflows | 15 | ver tabla en §5 |
| Secrets | 15 | **viajaron solos** en la transferencia (verificado 28/08) |
| Variables | 1 (`PRESENTISMO_RUNNER`) | referenciada pero hoy sin valor |
| Runners propios | 0 | hay que registrar uno nuevo (ver §6) |

El repo padre `app-supervision` **no tiene remote** — es solo local, no entra
en la migración. `bots/` y `mobile/` están trackeados ahí como gitlinks sin
`.gitmodules`, así que no hay ninguna URL que actualizar en el padre; el
cambio de cuenta se hace con `git remote set-url` en `bots/` y listo.

---

## 2. Decisión: transferir vs. repo nuevo

**Recomendado: transferir** (Settings → General → Danger Zone → Transfer).

- Es atómico: no existe una ventana con los dos repos corriendo los mismos
  crons a la vez. Con un repo nuevo, mientras no desactives el viejo, los dos
  escriben a la misma Supabase. La mayoría de los bots hace upsert idempotente
  y lo aguantaría, pero `venta-perdida` es una máquina de estados
  (request → collect → retry) y una corrida doble sí puede pisarse.
- Conserva el historial de commits y deja un redirect desde la URL vieja.
- El rollback es transferir de vuelta.

Alternativa (repo nuevo + push) solo si la cuenta destino es de organización y
prefieres no arrastrar el historial. En ese caso, **antes** de pushear, borra
los `schedule:` del repo viejo o desactiva sus workflows desde la UI.

Lo que **no** sobrevive a la transferencia, en cualquiera de los dos caminos:
los 15 secrets. Planifica recrearlos (§3).

---

## 3. Secrets a migrar

**Corrección (28/08): los 15 secrets SÍ sobrevivieron a la transferencia.**
Aparecen en el repo nuevo con sus timestamps originales intactos, así que no
hubo que recargar ninguno. Este apartado queda como referencia de dónde sale
cada valor, por si hay que rotarlo o recrearlo en el futuro.

Ojo si algún día hay que reponerlos: los valores **no se pueden exportar**
desde GitHub — son de solo escritura, ni la API ni la UI los devuelven. Habría
que recuperar cada uno de su fuente original, que es la columna "de dónde se
saca".

| # | Secret | De dónde se saca | Usado por |
|---|---|---|---|
| 1 | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` | **los 15 workflows** |
| 2 | `GEOVICTORIA_KEY` | Cuenta API GeoVictoria (la de asistencia, no la de SMU) | asistencia, cobertura-ausencias |
| 3 | `GEOVICTORIA_SECRET` | ídem | asistencia, cobertura-ausencias |
| 4 | `TEAMCORE_USER` | Portal Teamcore (cocacolaembonor.cl.teamcore.net) | teamcore, venta-perdida ×3 |
| 5 | `TEAMCORE_PASS` | ídem | teamcore, venta-perdida ×3 |
| 6 | `DATAWALT_USER` | Portal Datawalt (Dichter Neira Analytics) | red-sync |
| 7 | `DATAWALT_PASS` | ídem | red-sync |
| 8 | `FRAX_USER` | Portal APE2 de Frax (controltienda.com) — RUT | presentismo |
| 9 | `FRAX_PASS` | ídem — clave | presentismo |
| 10 | `FRAX_SESSION_COOKIE` | **se regenera**: `python scripts/capturar_cookie.py` | presentismo |
| 11 | `SMU_GV_USER` | GeoVictoria Externos (externos.geovictoria.com) — cuenta SMU | smu-presentismo |
| 12 | `SMU_GV_PASS` | ídem | smu-presentismo |
| 13 | `DEC_IDD_USER` | Identidad Digital (identidaddigital.acepta.com) — RUT | dec-documentos |
| 14 | `DEC_IDD_PASS` | ídem — clave | dec-documentos |
| 15 | `ONESIGNAL_REST_API_KEY` | **no generar uno nuevo**: copiar el que ya está en Supabase → Project Settings → Edge Functions → Secrets (Edge Function `send-push`) | notificaciones ×5 |

Cárgalos uno por uno. `gh secret set` sin `--body` **pide el valor por stdin
sin mostrarlo en pantalla** y no lo deja en el historial del shell — usar
siempre esa forma, nunca `--body "valor"`:

```bash
for s in SUPABASE_SERVICE_ROLE_KEY GEOVICTORIA_KEY GEOVICTORIA_SECRET TEAMCORE_USER TEAMCORE_PASS DATAWALT_USER DATAWALT_PASS FRAX_USER FRAX_PASS SMU_GV_USER SMU_GV_PASS DEC_IDD_USER DEC_IDD_PASS ONESIGNAL_REST_API_KEY; do echo "== $s"; gh secret set "$s" --repo supervisionecrapp-tech/app-supervision-bots; done
```

`FRAX_SESSION_COOKIE` queda fuera de ese loop a propósito: se regenera con el
script, que ahora imprime el comando ya apuntado al repo correcto.

> **Nota de seguridad.** `SUPABASE_SERVICE_ROLE_KEY` da acceso total a la base
> y ya figura como riesgo abierto en la auditoría del 21/08. La migración es
> el momento barato para **rotarla**: genera una nueva en Supabase, cárgala
> solo en la cuenta nueva, y revoca la vieja una vez que los bots corran
> verdes. Así la cuenta personal queda sin acceso a la base.

---

## 4. Runbook

Cada paso es verificable antes de pasar al siguiente.

**Previo (lo haces tú, no automatizable)**

1. Crear/tener lista la cuenta `supervisionecrapp-tech` en GitHub con 2FA activo.
2. Decidir el plan: Free da 2.000 min/mes en repos privados; Pro, 3.000.
   Con lo proyectado en §5 alcanza Free.

**Migración**

3. Pausar los crons en el repo viejo: Actions → cada workflow → `···` →
   *Disable workflow*. Evita corridas huérfanas durante la ventana.
4. Transferir el repo a `supervisionecrapp-tech` y aceptar desde la cuenta destino.
5. Actualizar el remote local:

   ```bash
   git -C bots remote set-url origin https://github.com/supervisionecrapp-tech/app-supervision-bots.git
   ```

6. ~~Cargar los 15 secrets.~~ **No hizo falta**: viajaron en la transferencia.
7. Verificar que no falte ninguno — debe dar 15:

   ```bash
   gh secret list --repo supervisionecrapp-tech/app-supervision-bots | wc -l
   ```

8. Reactivar los workflows y lanzar uno barato a mano para probar la cadena
   completa (`teamcore-sync`, ~1 min):

   ```bash
   gh workflow run teamcore-sync.yml --repo supervisionecrapp-tech/app-supervision-bots
   ```

9. Confirmar en Supabase que la corrida quedó registrada en `bot_runs` — es
   la prueba real de que el secret de Supabase quedó bien cargado.
10. Ir corriendo el resto a mano, de los baratos a los caros, mirando
    `bot_runs` en cada uno.

**Cierre**

11. Rotar `SUPABASE_SERVICE_ROLE_KEY` y revocar la vieja.
12. Quitar a la cuenta personal como colaboradora, o dejarla con permiso de
    lectura si quieres seguir viendo los runs.

---

## 5. Presupuesto de minutos post-migración

Frecuencias ya reducidas en este commit, con duraciones medidas sobre 588
corridas reales (13–28 ago):

| Bot | Antes | Ahora | min/mes |
|---|---|---|---|
| Asistencia | 19/día | 8/día | 410 |
| DEC Documentos | 18/día | 4/día | 305 |
| Teamcore | 8/día | *sin cambio* | 269 |
| SMU Presentismo | 18/día | 6/día | 203 |
| Notificaciones ×5 | varias | *sin cambio* | 188 |
| Cobertura | 2/día | *sin cambio* | 140 |
| Red | 1/día | *sin cambio* | 94 |
| Venta Perdida ×3 | 3/sem | *sin cambio* | 47 |
| **Subtotal en Actions** | | | **1.656** |
| Presentismo | 18/día | 6/día | 0 en runner propio · 360 en `ubuntu-latest` |

Con Presentismo en runner propio: **1.656 min/mes**, ~344 de margen sobre los
2.000. Si además las notificaciones se van a Supabase (pg_cron + Edge
Function), baja a **1.468**.

### Por qué Presentismo igual va a runner propio

Bajarlo a 6/día **no alcanza** para dejarlo en `ubuntu-latest`: 2.016 min/mes,
16 por encima del límite, y eso asumiendo que la cookie de sesión nunca
expira. No es margen, es empate.

Y la cookie sí expira. Medido sobre 167 corridas (13–28 ago):

| Período | % éxito | seg/run |
|---|---|---|
| 22–25 ago (cookie viva) | 100% (65 corridas) | ~75 |
| 27 ago (cookie vencida) | 6% (1 de 18) | 329 |
| 28 ago | 43% | 414 |

El bypass por `FRAX_SESSION_COOKIE` funciona bien y dura ~5 días, pero hay que
renovarlo a mano desde una IP de confianza (`scripts/capturar_cookie.py`) — y
cuando vence, las corridas fallidas cuestan 5 min facturados cada una en vez
de 2. Una semana de cookie vencida son ~900 min tirados.

En un runner propio con IP residencial chilena no hace falta cookie: Turnstile
emite el token solo en menos de 8s, el bot entra por el login normal, y los
minutos no se facturan. Se arregla el costo, la fragilidad y la tarea manual
semanal de una sola vez.

**Lo que sí gana la baja de frecuencia:** vuelve seguro el fallback. El
workflow cae en `ubuntu-latest` si `PRESENTISMO_RUNNER` no está seteada o el
runner está caído. A 18/día ese fallback metía 1.820 min/mes en la factura sin
avisar; a 6/día son 360, absorbibles con el margen que queda.

---

## 6. Runner propio (para Presentismo)

Registrarlo en la cuenta nueva: Settings → Actions → Runners → New self-hosted
runner. En la máquina que quede como runner hace falta un display real (o
xvfb) porque el scrape corre headful. Después, en el repo:

```bash
gh variable set PRESENTISMO_RUNNER --body self-hosted --repo supervisionecrapp-tech/app-supervision-bots
```

El workflow ya lee esa variable (`runs-on: ${{ vars.PRESENTISMO_RUNNER || 'ubuntu-latest' }}`),
así que no hay que tocar YAML. Sin la variable, sigue cayendo en `ubuntu-latest`.

---

## 7. Rollback

Hasta el paso 11 el rollback es transferir el repo de vuelta y reactivar sus
workflows: los secrets viejos siguen ahí mientras no los borres. Después de
rotar la key de Supabase ya no: habría que cargar la nueva también en el repo
viejo. Por eso la rotación va al final.

---

## 8. Notificaciones → Supabase (hecho, falta el corte)

Independiente de la mudanza de cuenta: los 5 workflows `notificaciones-*`
no scrapean nada, solo leen indicadores ya cargados y pegan a OneSignal.
Movidos a una sola Edge Function parametrizada por `tipo`.

**Ya desplegado y verificado:**

- `supabase/functions/notificaciones-sync/index.ts` — port 1:1 de las 570
  líneas de Node. Desplegada como v1, ACTIVE, `verify_jwt: true`. Los 17
  objetos de base que usa existen (verificado contra el esquema).
- Extensiones `pg_cron` 1.6.4 y `pg_net` 0.20.4 habilitadas
  (`20260828010000_notificaciones_cron_extensiones.sql`).
- `20260828020000_notificaciones_cron_jobs.sql` — los 6 jobs, escritos y con
  la sintaxis validada, **sin aplicar**.

**Mapeo de workflows a jobs** (mismos horarios UTC):

| Workflow de Actions | cron | tipo |
|---|---|---|
| notificaciones-semanal-lunes | `4 14 * * 1` | `presentismo-semanal` |
| ídem (2º paso del mismo job) | `9 14 * * 1` | `teamcore-semanal` |
| notificaciones-venta-perdida | `6 15 * * 1` | `venta-perdida-semanal` |
| notificaciones-red | `8 17 * * 2` | `red-semanal` |
| notificaciones-documentos | `9 17 * * 1-6` | `documentos-pendientes` |
| notificaciones-intradia | `13 13,15,17,19,21 * * *` | `intradia-combinado` |

El workflow de los lunes corría presentismo y teamcore en secuencia dentro
del mismo job; acá son dos jobs y teamcore va 5 min después, porque pg_net
es asíncrono y sin desfase arrancarían juntos.

### Keys: no falta ninguna

- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — Supabase
  las inyecta sola en toda Edge Function. Nada que configurar.
- `ONESIGNAL_REST_API_KEY` — ya es secret del proyecto, en uso por `send-push`
  v9 en producción. La nueva función lee el mismo nombre.

Lo único que falta no es una key nueva, es **poner el service_role en Vault**
para que pg_cron pueda autenticarse contra la Edge Function. Vault está
instalado (0.3.1) pero vacío. Se carga una vez desde el SQL Editor:

```sql
select vault.create_secret(
  '<SERVICE_ROLE_KEY>', 'service_role_key',
  'Para que pg_cron invoque Edge Functions');
```

Si después rotas la key (§3), hay que actualizar también este secret.

### Pasos del corte — COMPLETADO el 28/08

1. ~~Probar el port con `dry_run`.~~ **HECHO** — 200 OK via pg_net, 10
   destinatarios, todos con mensaje.
2. ~~Cargar el secret en Vault.~~ **HECHO** — `service_role_key`.
   Es una clave de formato nuevo (`sb_secret_...`, no un JWT) y el gateway
   de Edge Functions la acepta igual; el 401 del primer intento fue haber
   guardado el placeholder `<SERVICE_ROLE_KEY>` literal, no el formato.
3. ~~Desactivar los 5 workflows `notificaciones-*`.~~ **HECHO** — quedaron en
   `disabled_manually`; los otros 10 siguen activos. Revertir:
   `gh workflow enable <id> -R StarCrushed/app-supervision-bots`
   (ids `336534671` a `336534675`).
4. ~~Aplicar `20260828020000_notificaciones_cron_jobs.sql`.~~ **HECHO** — los
   6 jobs quedaron `active` en `cron.job`.
5. **Pendiente**: verificar la primera corrida real.

   ```sql
   select jobname, status, return_message, start_time
   from cron.job_run_details order by start_time desc limit 10;
   ```

   Y que aparezca la fila correspondiente en `bot_runs`.

Rollback: `select cron.unschedule(jobname) from cron.job where jobname like
'notif-%';` y reactivar los workflows. La Edge Function puede quedar
desplegada, es inerte si nadie la llama.


## 9. Pendientes que la migración no resuelve

- **DEC Documentos está roto**: 11 fallas de 13 corridas en la ventana medida.
  Migrarlo no lo arregla. Y ojo: sus corridas exitosas duran más que las
  fallidas (158s vs 122s), así que al arreglarlo el costo sube — la baja a
  4/día ya lo tiene en cuenta.
- **Red Sync tuvo una corrida cancelada de 6 horas.** Ya no puede repetirse:
  este commit le puso `timeout-minutes` a los 15 workflows.
- `bots/` y `mobile/` como gitlinks sin `.gitmodules` en el repo padre.
