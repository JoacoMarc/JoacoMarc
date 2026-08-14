#!/usr/bin/env node
/**
 * Servidor local de la web app. Sin dependencias fuera de `node:http`.
 *
 *   GET /                 → la interfaz
 *   GET /data/index.json  → índice de máquinas + plan (se genera al vuelo)
 *   GET /data/*.json      → los datos de cada máquina
 *   GET /src/*.js         → módulos compartidos con el front (la tabla de precios vive
 *                           en un solo lugar y la usan el exportador y la UI)
 *
 * Sirve exactamente las mismas rutas que produce `npm run build`, así que lo que ves en
 * local es lo mismo que vas a ver deployado.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DATA_DIR, REPO_ROOT, loadConfig } from './config.js';
import { buildManifest } from './manifest.js';

const WEB_DIR = path.join(REPO_ROOT, 'web');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const VENDOR_DIR = path.join(REPO_ROOT, 'node_modules', 'chart.js', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveFile(res, file) {
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  });
}

/** Resuelve una ruta dentro de un directorio permitido, bloqueando path traversal. */
function safeJoin(rootDir, urlPath) {
  const resolved = path.resolve(rootDir, `.${urlPath}`);
  return resolved.startsWith(rootDir) ? resolved : null;
}

const config = loadConfig();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  // El índice se genera en cada request en vez de leerse de disco: así ves una máquina
  // nueva apenas llega por git, sin reiniciar el servidor.
  if (pathname === '/data/index.json') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-cache' });
    res.end(JSON.stringify(buildManifest()));
    return;
  }

  if (pathname.startsWith('/data/')) {
    const file = safeJoin(DATA_DIR, pathname.slice('/data'.length));
    if (file) return serveFile(res, file);
  }

  if (pathname.startsWith('/src/')) {
    const file = safeJoin(SRC_DIR, pathname.slice('/src'.length));
    if (file) return serveFile(res, file);
  }

  // Chart.js se sirve desde node_modules en vez de copiarse al repo: así `npm update`
  // alcanza para actualizarlo y no hay un archivo vendorizado que se quede viejo.
  if (pathname.startsWith('/vendor/')) {
    const file = safeJoin(VENDOR_DIR, pathname.slice('/vendor'.length));
    if (file) return serveFile(res, file);
  }

  const file = safeJoin(WEB_DIR, pathname === '/' ? '/index.html' : pathname);
  if (!file) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Prohibido');
    return;
  }
  serveFile(res, file);
});

const port = Number(process.env.PORT) || config.port || 4000;
server.listen(port, '127.0.0.1', () => {
  console.log(`Tracker en http://localhost:${port}`);
});
