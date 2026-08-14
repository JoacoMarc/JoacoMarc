#!/usr/bin/env node
/**
 * Parsea los logs locales de Claude Code y escribe `data/<máquina>.json`.
 *
 * Es idempotente: deduplica por `message.id` y fusiona de forma monotónica contra lo ya
 * exportado, así que correrlo cientos de veces por día no cambia el resultado. Por eso
 * se puede colgar del hook `Stop` sin cuidado.
 *
 * Uso:
 *   node src/export.js            escribe data/<máquina>.json
 *   node src/export.js --dry-run  muestra el resumen sin escribir nada
 */

import path from 'node:path';
import { collect, mergeMonotonic, summarize } from './aggregate.js';
import { CACHE_DIR, DATA_DIR, loadConfig, machineSlug, readJson, writeJson } from './config.js';
import { defaultLogRoot, parseAll, readAccount } from './parse.js';

const SCHEMA_VERSION = 1;

export function runExport({ dryRun = false, quiet = false } = {}) {
  const config = loadConfig();
  const root = config.logRoot ?? defaultLogRoot();
  const slug = machineSlug(config.machine);
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const account = readAccount();
  const warnings = [];

  if (config.trackAccount && account) {
    const matches =
      config.trackAccount === account.uuid ||
      config.trackAccount.toLowerCase() === (account.email ?? '').toLowerCase();
    if (!matches) {
      warnings.push(
        `La cuenta logueada (${account.email ?? account.uuid}) no es la que configuraste ` +
          `en trackAccount (${config.trackAccount}). Los archivos nuevos se van a estampar ` +
          `con la cuenta logueada.`,
      );
    }
  }
  if (!account) {
    warnings.push('No se pudo leer la cuenta desde ~/.claude.json; los datos quedan sin atribuir.');
  }

  // El cache guarda offset y buckets por archivo, así que sólo se releen los bytes nuevos.
  const cacheFile = path.join(CACHE_DIR, `${slug}.parse-state.json`);
  const cache = readJson(cacheFile, { version: 1, files: {} });

  const stampAccount = account
    ? { uuid: account.uuid, email: config.includeEmail ? account.email : null }
    : null;

  const { stats } = parseAll({ root, cache, account: stampAccount });
  const fresh = collect(cache);

  const dataFile = path.join(DATA_DIR, `${slug}.json`);
  const previous = readJson(dataFile);
  const merged = mergeMonotonic(previous?.buckets ? previous : null, fresh);

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    machine: config.machine,
    updatedAt: new Date().toISOString(),
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    accounts: merged.accounts,
    buckets: merged.buckets,
    sessions: merged.sessions,
  };

  const totals = summarize(merged.buckets);

  if (!dryRun) {
    writeJson(cacheFile, cache);
    writeJson(dataFile, payload);
  }

  log(`Máquina        ${config.machine}  →  data/${slug}.json`);
  log(`Cuenta         ${account?.email ?? account?.uuid ?? 'desconocida'}`);
  log(`Logs           ${stats.files} archivos (${stats.changed} con cambios)`);
  log(`Registros      ${stats.newRecords} nuevos, ${stats.skippedDuplicates} duplicados omitidos`);
  log(`Agregado       ${merged.buckets.length} buckets, ${merged.sessions.length} sesiones`);
  log(`Tokens         ${totals.tokens.toLocaleString('es-AR')}`);
  log(`Costo estimado USD ${totals.cost.toFixed(2)}`);
  log(`Ahorro cache   USD ${(totals.withoutCache - totals.cost).toFixed(2)}`);
  if (totals.unknownModels.length) {
    log(`Modelos sin precio: ${totals.unknownModels.join(', ')} (contados como 0)`);
  }
  for (const w of warnings) log(`Aviso: ${w}`);
  if (dryRun) log('\n(--dry-run: no se escribió nada)');

  return { payload, totals, stats, warnings };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  runExport({ dryRun: process.argv.includes('--dry-run') });
}
