/**
 * Consolidación de los buckets por archivo en el agregado final, y fusión monotónica
 * contra lo que ya estaba exportado.
 */

import { bucketKey } from './parse.js';
import { costOfBucket } from './pricing.js';

const COUNTERS = [
  'input',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheRead',
  'output',
  'thinking',
  'webSearch',
  'webFetch',
  'messages',
];

/**
 * Aplana el cache por archivo en listas de buckets y de sesiones.
 *
 * Cada archivo `.jsonl` es una sesión, así que sus buckets ya vienen deduplicados por
 * `message.id` desde el parser. Acá sólo se suman entre archivos.
 */
export function collect(cache) {
  const buckets = new Map();
  const sessions = [];
  const accounts = new Map();

  for (const entry of Object.values(cache.files ?? {})) {
    if (entry.account?.uuid) {
      accounts.set(entry.account.uuid, entry.account);
    }

    for (const [key, b] of Object.entries(entry.buckets ?? {})) {
      const target = buckets.get(key);
      if (!target) {
        buckets.set(key, { ...b });
        continue;
      }
      for (const c of COUNTERS) target[c] += b[c] ?? 0;
    }

    if (entry.session?.id) {
      const s = entry.session;
      const cost = costOfBucket({
        ...s,
        date: s.startedAt?.slice(0, 10),
        model: s.models?.[0],
        tier: 'standard',
      });
      sessions.push({
        id: s.id,
        project: s.project,
        entrypoint: s.entrypoint,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        models: s.models,
        account: entry.account?.uuid ?? null,
        ...Object.fromEntries(COUNTERS.map((c) => [c, s[c] ?? 0])),
        costUsd: round(cost.total, 6),
      });
    }
  }

  return {
    buckets: [...buckets.values()].sort((a, b) => (a.hour < b.hour ? -1 : 1)),
    sessions: sessions.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)),
    accounts: [...accounts.values()],
  };
}

/**
 * Fusión monotónica contra el archivo ya exportado.
 *
 * Los contadores de tokens sólo pueden crecer: un mismo bucket nunca va a tener menos
 * tokens de los que ya tenía. Entonces se toma el máximo por contador en lugar de
 * sobrescribir. Eso hace que un mes ya exportado sobreviva aunque Claude Code haya
 * borrado los logs de origen — que es exactamente lo que hace su limpieza automática.
 */
export function mergeMonotonic(previous, fresh) {
  const byKey = new Map();

  for (const b of previous?.buckets ?? []) byKey.set(bucketKey(b), { ...b });

  for (const b of fresh.buckets) {
    const key = bucketKey(b);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...b });
      continue;
    }
    for (const c of COUNTERS) prev[c] = Math.max(prev[c] ?? 0, b[c] ?? 0);
  }

  const sessions = new Map();
  for (const s of previous?.sessions ?? []) sessions.set(s.id, s);
  for (const s of fresh.sessions) {
    const prev = sessions.get(s.id);
    // Ante duplicado gana el que tenga más mensajes: es el que vio la sesión completa.
    if (!prev || (s.messages ?? 0) >= (prev.messages ?? 0)) sessions.set(s.id, s);
  }

  const accounts = new Map();
  for (const a of previous?.accounts ?? []) if (a?.uuid) accounts.set(a.uuid, a);
  for (const a of fresh.accounts) if (a?.uuid) accounts.set(a.uuid, a);

  return {
    buckets: [...byKey.values()].sort((a, b) => (a.hour < b.hour ? -1 : 1)),
    sessions: [...sessions.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)),
    accounts: [...accounts.values()],
  };
}

/** Totales rápidos, para el resumen que imprime el exportador por consola. */
export function summarize(buckets) {
  let cost = 0;
  let withoutCache = 0;
  let tokens = 0;
  const unknown = new Set();

  for (const b of buckets) {
    const c = costOfBucket(b);
    cost += c.total;
    withoutCache += c.withoutCache;
    tokens += b.input + b.cacheWrite5m + b.cacheWrite1h + b.cacheRead + b.output;
    if (c.unknownModel) unknown.add(b.model);
  }

  return { cost, withoutCache, tokens, unknownModels: [...unknown] };
}

function round(n, decimals) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
