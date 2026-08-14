/** Carga de configuración y rutas del repo. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const CACHE_DIR = path.join(REPO_ROOT, '.cache');

const DEFAULTS = {
  /** Alias de esta máquina. `null` usa el hostname. Define el nombre del archivo de datos. */
  machine: null,
  /**
   * Cuenta que querés trackear (email o UUID). Si está seteada y no coincide con la
   * logueada, el exportador avisa antes de mezclar consumo de otra cuenta.
   */
  trackAccount: null,
  /** Si es `true`, el email de la cuenta se guarda en los datos exportados. */
  includeEmail: false,
  /** Directorio de logs. `null` usa `~/.claude/projects`. */
  logRoot: null,
  port: 4000,
};

/**
 * El plan vive en `plan.json`, versionado y compartido por todas las máquinas — a
 * diferencia de `config.json`, que es por máquina y no se commitea. Esa separación es la
 * que permite que el build estático conozca el costo del asiento sin depender de la
 * config local de nadie.
 */
const DEFAULT_PLAN = { label: 'Plan', seatCostUsd: 0 };

export function loadPlan() {
  return { ...DEFAULT_PLAN, ...(readJson(path.join(REPO_ROOT, 'plan.json')) ?? {}) };
}

export function loadConfig() {
  const user = readJson(path.join(REPO_ROOT, 'config.json')) ?? {};
  const config = { ...DEFAULTS, ...user };
  config.machine ||= os.hostname();
  config.plan = loadPlan();
  return config;
}

/** Nombre de archivo seguro y estable para una máquina. */
export function machineSlug(machine) {
  return String(machine)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'maquina';
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Escritura atómica: si el proceso muere a mitad, el archivo previo queda intacto.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
