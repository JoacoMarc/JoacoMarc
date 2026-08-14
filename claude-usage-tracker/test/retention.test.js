#!/usr/bin/env node
/**
 * Test de integración de la retención.
 *
 * Reproduce el escenario que hace que este repo valga más que los logs: Claude Code
 * borra los `.jsonl` viejos, y el agregado ya exportado tiene que sobrevivir igual.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collect, mergeMonotonic, summarize } from '../src/aggregate.js';
import { parseAll } from '../src/parse.js';

function fakeLogLine(id, output) {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-02T15:20:00.000Z',
    cwd: '/home/joaco/proyecto-viejo',
    sessionId: 'sesion-julio',
    isSidechain: false,
    effort: 'high',
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 500000,
        cache_creation_input_tokens: 20000,
        cache_creation: { ephemeral_1h_input_tokens: 20000, ephemeral_5m_input_tokens: 0 },
        output_tokens: output,
        output_tokens_details: { thinking_tokens: 100 },
        service_tier: 'standard',
      },
    },
  })}\n`;
}

test('un mes ya exportado sobrevive a que se borre el log de origen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'));
  const projectDir = path.join(root, '-home-joaco-proyecto-viejo');
  fs.mkdirSync(projectDir, { recursive: true });
  const logFile = path.join(projectDir, 'sesion-julio.jsonl');

  try {
    fs.writeFileSync(logFile, fakeLogLine('msg_a', 1000) + fakeLogLine('msg_b', 2000));

    // Primera exportación, con el log presente.
    const first = parseAll({ root, cache: { version: 1, files: {} }, account: null });
    const exported = mergeMonotonic(null, collect(first.cache));
    const before = summarize(exported.buckets);

    assert.equal(before.tokens > 0, true);
    assert.equal(exported.buckets.length, 1);

    // Claude Code limpia el log y también se pierde el cache del parser (máquina nueva,
    // clon fresco del repo, lo que sea).
    fs.rmSync(logFile);
    const second = parseAll({ root, cache: { version: 1, files: {} }, account: null });
    const fresh = collect(second.cache);
    assert.equal(fresh.buckets.length, 0, 'sin el log, el parseo nuevo no ve nada');

    // La fusión contra lo ya exportado tiene que conservar el mes.
    const merged = mergeMonotonic(exported, fresh);
    const after = summarize(merged.buckets);

    assert.equal(after.tokens, before.tokens);
    assert.equal(after.cost.toFixed(6), before.cost.toFixed(6));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('el parseo incremental no vuelve a contar lo ya leído', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'));
  const projectDir = path.join(root, '-home-joaco-proyecto');
  fs.mkdirSync(projectDir, { recursive: true });
  const logFile = path.join(projectDir, 'sesion.jsonl');

  try {
    fs.writeFileSync(logFile, fakeLogLine('msg_a', 1000));
    const cache = { version: 1, files: {} };

    parseAll({ root, cache, account: null });
    const afterFirst = summarize(collect(cache).buckets).tokens;

    // Corre de nuevo sin que el archivo haya cambiado: no debe sumar nada.
    parseAll({ root, cache, account: null });
    assert.equal(summarize(collect(cache).buckets).tokens, afterFirst);

    // Ahora sí llega un mensaje nuevo: sólo se leen los bytes agregados.
    fs.appendFileSync(logFile, fakeLogLine('msg_b', 2000));
    const run = parseAll({ root, cache, account: null });
    assert.equal(run.stats.newRecords, 1, 'sólo el registro nuevo se procesa');
    assert.equal(summarize(collect(cache).buckets).tokens > afterFirst, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una línea a medio escribir se ignora hasta estar completa', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'));
  const projectDir = path.join(root, '-home-joaco-proyecto');
  fs.mkdirSync(projectDir, { recursive: true });
  const logFile = path.join(projectDir, 'sesion.jsonl');

  try {
    const complete = fakeLogLine('msg_a', 1000);
    const partial = fakeLogLine('msg_b', 2000).slice(0, 60); // sin cerrar ni newline
    fs.writeFileSync(logFile, complete + partial);

    const cache = { version: 1, files: {} };
    const run = parseAll({ root, cache, account: null });
    assert.equal(run.stats.newRecords, 1, 'sólo se procesa la línea completa');

    // Cuando la sesión termina de escribirla, se procesa sin duplicar la anterior.
    fs.writeFileSync(logFile, complete + fakeLogLine('msg_b', 2000));
    const run2 = parseAll({ root, cache, account: null });
    assert.equal(run2.stats.newRecords, 1);
    assert.equal(collect(cache).buckets[0].messages, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
