import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./hooks/useNeuroSocket.js', import.meta.url), 'utf8');

test('socket reconnects after an unexpected close', () => {
  assert.equal(source.includes('RECONNECT_DELAY_MS = 2000'), true);
  assert.equal(source.includes('setTimeout'), true);
  assert.equal(source.includes('clearTimeout'), true);
  assert.equal(source.includes('[1008, 4001].includes(event.code)'), true);
});
