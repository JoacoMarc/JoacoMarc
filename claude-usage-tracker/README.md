# claude-usage-tracker

Cuántos tokens consumís en Claude Code y cuánto costaría eso por API, consolidado entre
varias máquinas en una sola vista.

Cada máquina lee sus propios logs locales, los agrega y commitea **sólo números** a este
repo. La web app junta los archivos de todas las máquinas y te muestra el total con
filtros por proyecto, modelo, máquina y período.

---

## Qué se sincroniza y qué no

Los logs de Claude Code (`~/.claude/projects/*.jsonl`) tienen **el texto completo de tus
prompts y de las respuestas**. Este repo no los toca: lo único que se commitea es
`data/<máquina>.json`, que son filas de contadores.

```json
{ "hour": "2026-08-14T13", "project": "mi-proyecto", "model": "claude-opus-5",
  "tier": "standard", "input": 15, "cacheRead": 2110410, "output": 13986, "messages": 8 }
```

Sin prompts, sin respuestas, sin rutas completas — sólo el nombre del proyecto. El
`.gitignore` además bloquea `*.jsonl` y `.claude/` como red de contención por si alguna
vez copiás un log al repo por error.

Aun así, hacé el repo **privado**: los nombres de tus proyectos y tus horarios de trabajo
son información tuya.

---

## Instalación en cada máquina

Los tres pasos son iguales en Mac y en Windows. Node 18 o superior.

**1. Clonar e instalar**

```bash
git clone <url-del-repo> claude-usage-tracker
cd claude-usage-tracker
npm install
```

**2. Configurar**

Hay dos archivos de configuración, y la separación importa:

**`config.json`** — por máquina, **no se commitea**. Copiá `config.example.json`:

```json
{
  "machine": "joaco-mac",
  "trackAccount": "tu-cuenta@ejemplo.com"
}
```

| Campo | Para qué |
|---|---|
| `machine` | Alias de esta máquina. Define el nombre del archivo de datos, así que **poné uno distinto en cada una** (`joaco-mac`, `joaco-pc`). Si lo dejás en `null` usa el hostname. |
| `trackAccount` | La cuenta que querés trackear (email o UUID). Si no coincide con la logueada, el exportador avisa. |
| `includeEmail` | Si es `true`, el email se guarda en los datos exportados. Por defecto sólo el UUID. |
| `logRoot` | Directorio de logs. `null` usa `~/.claude/projects`. |

**`plan.json`** — compartido, **sí se commitea**:

```json
{ "label": "Teams Pro", "seatCostUsd": 30 }
```

`seatCostUsd` es lo que pagás por asiento al mes; sacalo de la factura. Va acá y no en
`config.json` porque el break-even tiene que ser el mismo en las dos máquinas, y porque
el build estático necesita el dato sin depender de la config local de nadie.

**3. Primera corrida**

```bash
npm run export
```

Deberías ver el resumen con tokens y costo. Después:

```bash
npm run serve     # http://localhost:4000
```

---

## Que se actualice solo

El evento `Stop` de Claude Code corre al terminar cada turno. Enganchando el hook ahí, el
tracker se mantiene al día sin que hagas nada.

Agregá esto a `~/.claude/settings.json` (en Windows,
`C:\Users\<vos>\.claude\settings.json`). Si el archivo ya tiene un bloque `hooks`, sumá la
entrada `Stop` adentro en vez de reemplazarlo.

**Mac / Linux**

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "/ruta/absoluta/a/claude-usage-tracker/hooks/track-usage.sh" }
      ]}
    ]
  }
}
```

Dale permiso de ejecución una vez: `chmod +x hooks/track-usage.sh`

**Windows**

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\ruta\\a\\claude-usage-tracker\\hooks\\track-usage.ps1" }
      ]}
    ]
  }
}
```

El hook **no consume tokens**: es Node leyendo archivos, nunca llama a la API. Tampoco
escribe nada a stdout — si lo hiciera, ese texto podría inyectarse al contexto de tu
sesión y ahí sí te costaría tokens en cada turno. Todo lo que tiene para decir va a
`hooks/track-usage.log`.

Si preferís no tocar la config de Claude Code, corré `npm run sync` a mano o agendalo una
vez por día con `launchd` (Mac) o Task Scheduler (Windows).

Para desactivar el push automático del hook: `TRACKER_PUSH=0`.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run export` | Parsea los logs locales y escribe `data/<máquina>.json` |
| `npm run export -- --dry-run` | Muestra el resumen sin escribir nada |
| `npm run sync` | Export + commit + push (best-effort: sin red no falla) |
| `npm run serve` | Levanta la web app en `localhost:4000` |
| `npm run build` | Arma `dist/`, el sitio estático para deployar |
| `npm test` | Tests del cálculo de costo, la fusión y la retención |

---

## Verla sin levantar nada en local

`npm run build` genera `dist/`: HTML, CSS, JS y los JSON de datos. Sin backend — cualquier
host estático sirve, y las rutas son las mismas que sirve `serve.js`, así que lo que ves
en local es idéntico a lo deployado.

> **GitHub Pages no sirve acá.** Aunque el repo sea privado, el sitio publicado es
> **público** — las Pages con control de acceso son sólo Enterprise. Publicarías los
> nombres de tus proyectos y tus horarios de trabajo.

**Cloudflare Pages + Access** es la opción recomendada: gratis hasta 50 usuarios, pide
login antes de mostrar nada, y redeploya solo con cada push.

1. Cloudflare Pages → *Connect to Git* → este repo.
2. Build command `npm run build`, output directory `dist`.
3. Zero Trust → Access → Applications → agregá el dominio del proyecto con una policy
   que permita sólo tu email.

El paso 3 no es opcional: sin Access, la URL queda pública para cualquiera que la tenga.

Alternativas: Netlify con password protection, o Vercel con Deployment Protection (plan
Pro). En cualquiera, la config de build es la misma.

Como el deploy sale del repo, la web se actualiza sola: el hook pushea al terminar cada
turno y el host redeploya con ese push.

---

## Cómo se calcula el costo

Precios de la API en dólares por millón de tokens, en `src/pricing.js`. Tres detalles que
hacen la diferencia entre un número aproximado y uno confiable:

**La escritura de cache tiene dos precios.** 1,25× el input para el TTL de 5 minutos y 2×
para el de 1 hora. Los logs traen el desglose separado, así que se calcula bien en vez de
promediar. La lectura de cache va a 0,1×.

**Los precios tienen vigencia.** Sonnet 5 está en promoción hasta el 31/08/2026. Se aplica
el precio que regía el día del registro, no el de hoy.

**Se deduplica por `message.id`.** Claude Code escribe una línea por bloque de contenido
—thinking, tool_use, text— y las tres repiten el `usage` completo del mensaje. Sin
deduplicar, el costo sale inflado hasta al triple.

Si aparece un modelo que no está en la tabla, su consumo se cuenta en los tokens pero como
USD 0, y la interfaz te avisa arriba de todo en vez de subestimar en silencio.

### Si estás en un plan con tarifa plana

El costo que ves **no es lo que pagás** — es cuánto habría salido por API. El valor está
en el break-even: la tarjeta "Mes actual vs plan" te dice si la suscripción rinde. El
color se decide por la proyección de fin de mes, no por lo consumido hasta hoy.

---

## Detalles que conviene saber

**Los logs no guardan la cuenta.** Ni email ni ID: eso está sólo en `~/.claude.json`, y es
la cuenta logueada ahora, no un histórico. Por eso el exportador estampa cada archivo con
la cuenta vigente **la primera vez que lo procesa** y no la vuelve a tocar. Si cambiás de
cuenta en una máquina, lo ya registrado conserva la atribución correcta.

**Los meses viejos sobreviven.** Claude Code borra logs con el tiempo. El export fusiona
de forma monotónica —toma el máximo por fila en vez de sobrescribir— así que un mes ya
commiteado no se pierde aunque desaparezca el log de origen. El repo termina valiendo más
que los logs.

**El heatmap usa hora local.** Cada máquina agrega con su propio huso, así que las horas
quedan bien en origen aunque viajes.

**Un archivo por máquina.** Nadie escribe el archivo de otro, así que no hay conflictos de
merge.

---

## Lo que no cubre

Sesiones de claude.ai en el navegador y sesiones en contenedores remotos: no dejan log
local en tus máquinas y quedan fuera de cualquier tracker basado en archivos.
