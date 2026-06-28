import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PERSONA_ID,
  PERSONA_OPTIONS,
  resolvePersonaOption,
} from './personas.js';

test('persona options expose the four commercial roles', () => {
  assert.equal(PERSONA_OPTIONS.length, 4);
  assert.deepEqual(
    new Set(PERSONA_OPTIONS.map((persona) => persona.id)),
    new Set(['creator', 'companion', 'coach', 'private']),
  );
});

test('unknown persona ids resolve to the default persona', () => {
  assert.equal(resolvePersonaOption('missing').id, DEFAULT_PERSONA_ID);
  assert.equal(resolvePersonaOption(undefined).id, DEFAULT_PERSONA_ID);
});
