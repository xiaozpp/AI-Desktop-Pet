import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadWindowState,
  saveWindowState,
  normalizeWindowState,
  statePath,
  STATE_FILENAME,
} from '../windowState.cjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-windowstate-'));
}

test('loadWindowState returns null when the state file is missing', () => {
  const dir = tmpDir();
  assert.equal(loadWindowState(dir), null);
});

test('save then load round-trips the window state', () => {
  const dir = tmpDir();
  const state = { x: 123, y: 456, width: 300, height: 420, roamingEnabled: true, displayId: 2 };
  saveWindowState(dir, state);
  const loaded = loadWindowState(dir);
  assert.deepEqual(loaded, normalizeWindowState(state));
  assert.equal(loaded.x, 123);
  assert.equal(loaded.roamingEnabled, true);
  assert.equal(loaded.displayId, 2);
});

test('loadWindowState returns null on corrupt JSON instead of throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(statePath(dir), '{ not valid json ]', 'utf8');
  assert.equal(loadWindowState(dir), null);
});

test('saveWindowState is atomic: no .tmp left after success', () => {
  const dir = tmpDir();
  saveWindowState(dir, { x: 10, y: 20 });
  assert.equal(fs.existsSync(path.join(dir, STATE_FILENAME)), true);
  assert.equal(fs.existsSync(path.join(dir, `${STATE_FILENAME}.tmp`)), false);
});

test('normalizeWindowState strips invalid fields and coerces types', () => {
  const dirty = normalizeWindowState({
    x: '50',
    y: NaN,
    width: 300,
    height: undefined,
    roamingEnabled: 1, // 非布尔 → 归一为 false（只有严格 true 才为 true）
    displayId: 'abc',
    extra: 'ignored',
  });
  assert.equal(dirty.x, null); // '50' 不是 number
  assert.equal(dirty.y, null); // NaN 不是 finite
  assert.equal(dirty.width, 300);
  assert.equal(dirty.height, null);
  assert.equal(dirty.roamingEnabled, false);
  assert.equal(dirty.displayId, 'abc'); // displayId 保留原样（允许字符串 id）
  assert.equal('extra' in dirty, false);
});

test('default roamingEnabled is false when absent', () => {
  const dir = tmpDir();
  saveWindowState(dir, { x: 0, y: 0 });
  assert.equal(loadWindowState(dir).roamingEnabled, false);
});
