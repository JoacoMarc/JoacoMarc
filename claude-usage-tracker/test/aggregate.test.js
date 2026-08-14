#!/usr/bin/env node
/** Tests de la consolidación y la fusión monotónica. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { collect, mergeMonotonic } from '../src/aggregate.js';
import { recordFromLine } from '../src/parse.js';

const bucket = (over = {}) => ({
  hour: '2026-08-14T13',
  project: 'demo',
  model: 'claude-opus-5',
  tier: 'standard',
  effort: 'high',
  sidechain: false,
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
  webSearch: 0,
  webFetch: 0,
  messages: 0,
  ...over,
});

test('los buckets de archivos distintos se suman', () => {
  const cache = {
    files: {
      a: { buckets: { k: bucket({ output: 100, messages: 1 }) } },
      b: { buckets: { k: bucket({ output: 50, messages: 2 }) } },
    },
  };
  const { buckets } = collect(cache);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].output, 150);
  assert.equal(buckets[0].messages, 3);
});

test('la fusión monotónica no deja bajar un contador', () => {
  // Simula que Claude Code borró el log de origen: el parseo nuevo ve menos tokens
  // que los ya exportados. El mes viejo tiene que sobrevivir igual.
  const previous = { buckets: [bucket({ output: 5000, messages: 40 })], sessions: [], accounts: [] };
  const fresh = { buckets: [bucket({ output: 12, messages: 1 })], sessions: [], accounts: [] };

  const merged = mergeMonotonic(previous, fresh);
  assert.equal(merged.buckets.length, 1);
  assert.equal(merged.buckets[0].output, 5000);
  assert.equal(merged.buckets[0].messages, 40);
});

test('la fusión suma buckets nuevos sin tocar los viejos', () => {
  const previous = { buckets: [bucket({ hour: '2026-07-01T10', output: 90 })], sessions: [], accounts: [] };
  const fresh = { buckets: [bucket({ hour: '2026-08-14T13', output: 30 })], sessions: [], accounts: [] };

  const merged = mergeMonotonic(previous, fresh);
  assert.equal(merged.buckets.length, 2);
  assert.equal(merged.buckets.reduce((s, b) => s + b.output, 0), 120);
});

test('ante sesiones duplicadas gana la que vio más mensajes', () => {
  const base = { id: 's1', startedAt: '2026-08-14T13:00:00Z', messages: 3, costUsd: 1 };
  const merged = mergeMonotonic(
    { buckets: [], sessions: [{ ...base, messages: 9, costUsd: 4 }], accounts: [] },
    { buckets: [], sessions: [base], accounts: [] },
  );
  assert.equal(merged.sessions.length, 1);
  assert.equal(merged.sessions[0].messages, 9);
});

test('una línea de assistant se normaliza con el desglose de cache por TTL', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-14T13:51:09.304Z',
    cwd: '/home/user/MiProyecto',
    sessionId: 'abc',
    isSidechain: false,
    effort: 'high',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 46183,
        cache_creation: { ephemeral_1h_input_tokens: 46183, ephemeral_5m_input_tokens: 0 },
        output_tokens: 730,
        output_tokens_details: { thinking_tokens: 491 },
        service_tier: 'standard',
      },
    },
  });

  const rec = recordFromLine(line);
  assert.equal(rec.project, 'MiProyecto');
  assert.equal(rec.cacheWrite1h, 46183);
  assert.equal(rec.cacheWrite5m, 0);
  assert.equal(rec.thinking, 491);
});

test('las rutas de Windows dan el mismo nombre de proyecto que las de Mac', () => {
  const make = (cwd) =>
    recordFromLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-14T13:00:00.000Z',
        cwd,
        message: { id: 'm', model: 'claude-opus-5', usage: { output_tokens: 1 } },
      }),
    ).project;

  assert.equal(make('C:\\Users\\joaco\\dev\\MiProyecto'), 'MiProyecto');
  assert.equal(make('/Users/joaco/dev/MiProyecto'), 'MiProyecto');
});

test('las líneas que no son de assistant se ignoran', () => {
  assert.equal(recordFromLine(JSON.stringify({ type: 'user', message: { content: 'hola' } })), null);
  assert.equal(recordFromLine('no es json'), null);
});
