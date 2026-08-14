/**
 * Tabla de precios de la API de Claude y cálculo de costo.
 *
 * Todos los precios están expresados en dólares por millón de tokens (MTok).
 *
 * Dos detalles que la mayoría de los trackers pasa por alto y que acá sí se modelan:
 *
 *   1. La escritura de cache tiene DOS precios distintos según el TTL: 1,25× el precio
 *      de input para el cache de 5 minutos y 2× para el de 1 hora. Los logs de Claude
 *      Code traen el desglose separado, así que se puede calcular bien.
 *   2. Los precios tienen vigencia por fecha. Sonnet 5 está en precio promocional hasta
 *      el 31/08/2026. Se aplica el precio vigente al día del registro, no el de hoy.
 */

/** Multiplicadores sobre el precio de input del modelo. */
export const CACHE_MULTIPLIERS = {
  write5m: 1.25,
  write1h: 2,
  read: 0.1,
};

/** Las búsquedas web se facturan a USD 10 por cada 1000 requests. */
export const WEB_SEARCH_COST_PER_REQUEST = 10 / 1000;

/**
 * Precio por MTok, por modelo.
 *
 * Cada modelo tiene una lista de períodos. `from`/`to` son fechas ISO inclusive; si
 * faltan, el período no tiene límite por ese lado. `tier` por defecto es "standard".
 */
const PRICES = {
  'claude-opus-5': [
    { input: 5, output: 25 },
    { tier: 'fast', input: 10, output: 50 },
  ],
  'claude-opus-4-8': [
    { input: 5, output: 25 },
    { tier: 'fast', input: 10, output: 50 },
  ],
  'claude-opus-4-7': [{ input: 5, output: 25 }],
  'claude-opus-4-6': [{ input: 5, output: 25 }],
  'claude-opus-4-5': [{ input: 5, output: 25 }],
  'claude-opus-4-1': [{ input: 15, output: 75 }],
  'claude-opus-4-0': [{ input: 15, output: 75 }],

  'claude-sonnet-5': [
    // Precio promocional de lanzamiento, vigente hasta fin de agosto de 2026.
    { to: '2026-08-31', input: 2, output: 10 },
    { from: '2026-09-01', input: 3, output: 15 },
  ],
  'claude-sonnet-4-6': [{ input: 3, output: 15 }],
  'claude-sonnet-4-5': [{ input: 3, output: 15 }],
  'claude-sonnet-4-0': [{ input: 3, output: 15 }],

  'claude-haiku-4-5': [{ input: 1, output: 5 }],
  'claude-3-5-haiku': [{ input: 0.8, output: 4 }],
  'claude-3-haiku': [{ input: 0.25, output: 1.25 }],

  'claude-fable-5': [{ input: 10, output: 50 }],
  'claude-mythos-5': [{ input: 10, output: 50 }],
};

/**
 * Normaliza el identificador de modelo que aparece en los logs.
 *
 * Los logs pueden traer el alias (`claude-haiku-4-5`) o el ID completo con sufijo de
 * fecha (`claude-haiku-4-5-20251001`). Se prueba primero el match exacto y después se
 * saca el sufijo de 8 dígitos.
 */
export function normalizeModel(model) {
  if (!model || typeof model !== 'string') return null;
  const id = model.trim().toLowerCase();
  if (PRICES[id]) return id;
  const withoutDate = id.replace(/-\d{8}$/, '');
  if (PRICES[withoutDate]) return withoutDate;
  return id;
}

/**
 * Los modelos sintéticos (`<synthetic>`) son mensajes que Claude Code genera localmente
 * — errores, avisos de interrupción — y no se facturan.
 */
export function isSynthetic(model) {
  return typeof model === 'string' && model.startsWith('<');
}

/**
 * Devuelve `{ input, output }` en USD por MTok para un modelo, fecha y tier dados,
 * o `null` si el modelo no está en la tabla.
 *
 * @param {string} model
 * @param {string} date  Fecha ISO `YYYY-MM-DD` del registro.
 * @param {string} [tier] `standard` (por defecto) o `fast`.
 */
export function ratesFor(model, date, tier = 'standard') {
  const id = normalizeModel(model);
  const periods = PRICES[id];
  if (!periods) return null;

  const day = String(date).slice(0, 10);
  const wanted = tier === 'fast' ? 'fast' : 'standard';

  const match = (t) =>
    periods.find((p) => {
      if ((p.tier || 'standard') !== t) return false;
      if (p.from && day < p.from) return false;
      if (p.to && day > p.to) return false;
      return true;
    });

  // Si se pidió `fast` pero el modelo no lo tiene tarifado, se cae a `standard` en vez
  // de reportar el modelo como desconocido: el consumo existió igual.
  return match(wanted) || (wanted === 'fast' ? match('standard') : null) || null;
}

/**
 * Calcula el costo de un bucket de tokens.
 *
 * Devuelve el total y el desglose por concepto, más dos campos que la UI necesita:
 *
 *   `unknownModel` — el modelo no está en la tabla de precios. El costo se reporta como
 *   0 pero marcado, para que la interfaz avise en vez de subestimar en silencio.
 *
 *   `withoutCache` — cuánto habría costado si no existiera el prompt caching, es decir
 *   si cada token escrito o leído de cache se hubiera facturado como input normal a 1×.
 *   El ahorro (`withoutCache - total`) puede ser negativo si escribís mucho cache y lo
 *   leés poco, que es exactamente el caso que conviene detectar.
 */
export function costOfBucket(bucket) {
  const {
    model,
    hour = '',
    date = hour.slice(0, 10),
    tier = 'standard',
    input = 0,
    cacheWrite5m = 0,
    cacheWrite1h = 0,
    cacheRead = 0,
    output = 0,
    webSearch = 0,
  } = bucket;

  const webSearchCost = webSearch * WEB_SEARCH_COST_PER_REQUEST;

  if (isSynthetic(model)) {
    return zeroCost({ webSearchCost });
  }

  const rates = ratesFor(model, date, tier);
  if (!rates) {
    return { ...zeroCost({ webSearchCost }), unknownModel: true };
  }

  const perToken = rates.input / 1e6;
  const inputCost = input * perToken;
  const cacheWriteCost =
    cacheWrite5m * perToken * CACHE_MULTIPLIERS.write5m +
    cacheWrite1h * perToken * CACHE_MULTIPLIERS.write1h;
  const cacheReadCost = cacheRead * perToken * CACHE_MULTIPLIERS.read;
  const outputCost = (output * rates.output) / 1e6;

  const total = inputCost + cacheWriteCost + cacheReadCost + outputCost + webSearchCost;

  // Contrafáctico: sin cache, todo lo escrito y leído habría sido input normal a 1×.
  const cachedTokens = cacheWrite5m + cacheWrite1h + cacheRead;
  const withoutCache =
    inputCost + cachedTokens * perToken + outputCost + webSearchCost;

  return {
    total,
    input: inputCost,
    cacheWrite: cacheWriteCost,
    cacheRead: cacheReadCost,
    output: outputCost,
    webSearch: webSearchCost,
    withoutCache,
    unknownModel: false,
  };
}

function zeroCost({ webSearchCost = 0 } = {}) {
  return {
    total: webSearchCost,
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    webSearch: webSearchCost,
    withoutCache: webSearchCost,
    unknownModel: false,
  };
}

/** Lista de modelos tarifados, para que la UI pueda avisar qué conoce. */
export function knownModels() {
  return Object.keys(PRICES);
}
