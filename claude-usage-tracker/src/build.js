#!/usr/bin/env node
/**
 * Arma `dist/`: el sitio estático listo para deployar.
 *
 * No hace falta servidor — es HTML, CSS, JS y los JSON de datos. Sirve para Cloudflare
 * Pages, Netlify, Vercel o cualquier host estático.
 *
 * Ojo con dónde lo publicás: los datos incluyen los nombres de tus proyectos y tus
 * horarios. Poné el sitio detrás de autenticación (Cloudflare Access es gratis hasta 50
 * usuarios). GitHub Pages NO sirve: sobre un repo privado publica igual un sitio público.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, REPO_ROOT, writeJson } from './config.js';
import { buildManifest } from './manifest.js';

const DIST = path.join(REPO_ROOT, 'dist');
const WEB = path.join(REPO_ROOT, 'web');
const CHART = path.join(REPO_ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// La app y el exportador comparten la tabla de precios; el build la copia tal cual para
// que el sitio no dependa de node_modules ni de un bundler.
fs.cpSync(WEB, DIST, { recursive: true });
fs.mkdirSync(path.join(DIST, 'src'), { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, 'src', 'pricing.js'), path.join(DIST, 'src', 'pricing.js'));

fs.mkdirSync(path.join(DIST, 'vendor'), { recursive: true });
if (fs.existsSync(CHART)) {
  fs.copyFileSync(CHART, path.join(DIST, 'vendor', 'chart.umd.min.js'));
} else {
  console.error('Falta chart.js en node_modules. Corré `npm install` antes del build.');
  process.exit(1);
}

const manifest = buildManifest();
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
writeJson(path.join(DIST, 'data', 'index.json'), manifest);
for (const { file } of manifest.machines) {
  fs.copyFileSync(path.join(DATA_DIR, file), path.join(DIST, 'data', file));
}

console.log(`dist/ listo — ${manifest.machines.length} máquina(s): ${manifest.machines.map((m) => m.file).join(', ') || 'ninguna'}`);
