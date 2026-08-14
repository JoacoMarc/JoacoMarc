/**
 * Índice de los archivos de datos.
 *
 * Un host estático no puede listar un directorio, así que la app necesita saber de
 * antemano qué archivos por máquina existen. Este índice se genera al vuelo cuando
 * servís en local y se escribe a disco cuando armás el build para deployar — misma
 * forma en los dos casos, así que la app usa un solo camino de código.
 *
 * No se commitea: si cada máquina lo escribiera, sería el único archivo que las dos
 * tocan y el primer conflicto de merge del repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadPlan } from './config.js';

export function buildManifest() {
  let files = [];
  try {
    files = fs
      .readdirSync(DATA_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .sort();
  } catch {
    // Sin datos todavía: la app muestra el estado vacío con instrucciones.
  }

  return {
    generatedAt: new Date().toISOString(),
    plan: loadPlan(),
    machines: files.map((file) => ({ file })),
  };
}
