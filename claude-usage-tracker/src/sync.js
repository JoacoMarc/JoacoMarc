#!/usr/bin/env node
/**
 * Exporta y sincroniza con el repo remoto.
 *
 * Best-effort a propósito: si no hay red, el export local ya quedó guardado y el push
 * sale la próxima vez. Nunca termina con error por un problema de conectividad, porque
 * lo llama el hook que corre al final de cada turno.
 */

import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './config.js';
import { runExport } from './export.js';

function git(...args) {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' }).trim(),
    };
  } catch (err) {
    return { ok: false, out: (err.stderr || err.stdout || err.message).toString().trim() };
  }
}

runExport();

const status = git('status', '--porcelain', '--', 'data/');
if (!status.ok) {
  console.log('\nNo es un repo git; se omite la sincronización.');
  process.exit(0);
}

if (!status.out) {
  console.log('\nSin cambios para sincronizar.');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
git('add', '--', 'data/');
const commit = git('commit', '-m', `datos: ${stamp}`);
console.log(commit.ok ? `\nCommit hecho: datos ${stamp}` : `\nNo se pudo commitear: ${commit.out}`);

// El rebase con autostash evita conflictos cuando la otra máquina pusheó primero. Como
// cada máquina escribe sólo su propio archivo, no hay solapamiento real.
const pull = git('pull', '--rebase', '--autostash');
if (!pull.ok) console.log(`Aviso: no se pudo traer del remoto (${firstLine(pull.out)})`);

const push = git('push');
console.log(
  push.ok
    ? 'Push hecho.'
    : `Aviso: no se pudo pushear (${firstLine(push.out)}). Queda para la próxima corrida.`,
);

function firstLine(text) {
  return String(text).split('\n')[0];
}
