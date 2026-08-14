#!/usr/bin/env node
/**
 * Tests del cálculo de costo. Sin framework: `node --test test/pricing.test.js`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { costOfBucket, normalizeModel, ratesFor } from '../src/pricing.js';

test('caso real: opus-5 con escritura de cache de 1 hora', () => {
  // Primer registro de la sesión que originó este repo:
  //   input=2, cacheWrite1h=46183, cacheRead=0, output=730
  // A USD 5/25 por MTok, con multiplicador 2× para el cache de 1 h:
  //   (2×5 + 46183×5×2 + 730×25) / 1e6 = 0.48009
  const c = costOfBucket({
    model: 'claude-opus-5',
    date: '2026-08-14',
    tier: 'standard',
    input: 2,
    cacheWrite1h: 46183,
    output: 730,
  });
  assert.equal(c.total.toFixed(5), '0.48009');
  assert.equal(c.unknownModel, false);
});

test('los dos TTL de cache tienen precio distinto', () => {
  const base = { model: 'claude-opus-5', date: '2026-08-14', output: 0 };
  const w5 = costOfBucket({ ...base, cacheWrite5m: 1e6 });
  const w1h = costOfBucket({ ...base, cacheWrite1h: 1e6 });
  // 1,25× vs 2× sobre USD 5 el MTok.
  assert.equal(w5.total.toFixed(2), '6.25');
  assert.equal(w1h.total.toFixed(2), '10.00');
});

test('la lectura de cache cuesta 0,1× el input', () => {
  const c = costOfBucket({ model: 'claude-opus-5', date: '2026-08-14', cacheRead: 1e6 });
  assert.equal(c.total.toFixed(2), '0.50');
});

test('el precio promocional de sonnet 5 vence el 31/08/2026', () => {
  assert.deepEqual(ratesFor('claude-sonnet-5', '2026-08-31'), { to: '2026-08-31', input: 2, output: 10 });
  assert.deepEqual(ratesFor('claude-sonnet-5', '2026-09-01'), { from: '2026-09-01', input: 3, output: 15 });
});

test('el tier fast de opus 5 cuesta el doble', () => {
  const args = { model: 'claude-opus-5', date: '2026-08-14', output: 1e6 };
  assert.equal(costOfBucket({ ...args, tier: 'standard' }).total.toFixed(2), '25.00');
  assert.equal(costOfBucket({ ...args, tier: 'fast' }).total.toFixed(2), '50.00');
});

test('un tier sin tarifa propia cae a standard en vez de marcarse desconocido', () => {
  const c = costOfBucket({ model: 'claude-sonnet-5', date: '2026-08-14', tier: 'fast', output: 1e6 });
  assert.equal(c.unknownModel, false);
  assert.equal(c.total.toFixed(2), '10.00');
});

test('el sufijo de fecha del model id se normaliza', () => {
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.ok(ratesFor('claude-haiku-4-5-20251001', '2026-08-14'));
});

test('un modelo desconocido se marca en vez de contarse como gratis', () => {
  const c = costOfBucket({ model: 'claude-inventado-9', date: '2026-08-14', output: 1e6 });
  assert.equal(c.unknownModel, true);
  assert.equal(c.total, 0);
});

test('los mensajes sintéticos no se facturan', () => {
  const c = costOfBucket({ model: '<synthetic>', date: '2026-08-14', output: 1e6 });
  assert.equal(c.total, 0);
  assert.equal(c.unknownModel, false);
});

test('las búsquedas web se cobran a USD 10 el millar', () => {
  const c = costOfBucket({ model: 'claude-opus-5', date: '2026-08-14', webSearch: 100 });
  assert.equal(c.total.toFixed(2), '1.00');
});

test('el ahorro de cache puede ser negativo si escribís mucho y leés poco', () => {
  // Sólo escritura: sin cache habría costado 1×, con cache costó 2×. Ahorro negativo.
  const c = costOfBucket({ model: 'claude-opus-5', date: '2026-08-14', cacheWrite1h: 1e6 });
  assert.ok(c.withoutCache < c.total, 'escribir sin leer tiene que salir más caro');

  // Con lecturas suficientes, el cache conviene.
  const d = costOfBucket({
    model: 'claude-opus-5',
    date: '2026-08-14',
    cacheWrite1h: 1e6,
    cacheRead: 20e6,
  });
  assert.ok(d.withoutCache > d.total, 'leer mucho del cache tiene que ahorrar');
});
