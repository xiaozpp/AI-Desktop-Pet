import assert from 'node:assert/strict';
import test from 'node:test';
import { rmsVolume, volumeToMouth, smoothMouth } from './lipSync.js';

test('rmsVolume is 0 for silence (all samples at center 128)', () => {
  const silence = new Uint8Array(256).fill(128);
  assert.equal(rmsVolume(silence), 0);
});

test('rmsVolume rises with louder signal', () => {
  const quiet = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) quiet[i] = 128 + Math.round(10 * Math.sin(i));
  const loud = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) loud[i] = 128 + Math.round(100 * Math.sin(i));
  assert.equal(rmsVolume(quiet) < rmsVolume(loud), true);
  assert.equal(rmsVolume(quiet) >= 0 && rmsVolume(loud) <= 1, true);
});

test('rmsVolume handles empty input safely', () => {
  assert.equal(rmsVolume(null), 0);
  assert.equal(rmsVolume([]), 0);
});

test('volumeToMouth maps 0 to closed and boosts quiet volumes', () => {
  assert.equal(volumeToMouth(0), 0);
  // 幂增强：小音量也应产生可见嘴动。
  assert.equal(volumeToMouth(0.2) > 0.2, true);
  // 上限钳到 1。
  assert.equal(volumeToMouth(1), 1);
  assert.equal(volumeToMouth(1.5), 1);
  assert.equal(volumeToMouth(-1), 0);
});

test('volumeToMouth is monotonic (louder => wider mouth)', () => {
  let prev = -1;
  for (let i = 0; i <= 10; i += 1) {
    const m = volumeToMouth(i / 10);
    assert.equal(m >= prev, true);
    prev = m;
  }
});

test('smoothMouth converges toward target and never overshoots wildly', () => {
  let m = 0;
  for (let i = 0; i < 50; i += 1) m = smoothMouth(m, 1, 0.35);
  assert.equal(Math.abs(m - 1) < 0.01, true);
  // 不超过目标太多（一阶低通本质上不会越过目标）。
  let m2 = 0;
  for (let i = 0; i < 10; i += 1) m2 = smoothMouth(m2, 0.8, 0.5);
  assert.equal(m2 <= 0.8 + 1e-9, true);
});

test('smoothMouth treats invalid prev as 0', () => {
  assert.equal(smoothMouth(NaN, 0.5, 0.5), 0.25);
  assert.equal(smoothMouth(undefined, 0.4, 0.5), 0.2);
});
