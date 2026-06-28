import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IDLE_MICRO_ACTIONS,
  pickIdleMicroAction,
  nextMicroActionDelay,
  MICRO_ACTION_PARAM_KEYS,
} from './idleActions.js';

test('there are at least four distinct idle micro-actions', () => {
  const names = new Set(IDLE_MICRO_ACTIONS.map((a) => a.name));
  assert.equal(names.size >= 4, true);
  assert.equal(IDLE_MICRO_ACTIONS.length >= 4, true);
});

test('every micro-action has a name, positive duration and non-empty params', () => {
  for (const a of IDLE_MICRO_ACTIONS) {
    assert.equal(typeof a.name === 'string' && a.name.length > 0, true);
    assert.equal(a.duration > 0, true);
    assert.equal(Object.keys(a.params).length > 0, true);
  }
});

test('pickIdleMicroAction never returns the same action twice in a row when alternatives exist', () => {
  let lastName = null;
  for (let i = 0; i < 50; i += 1) {
    const next = pickIdleMicroAction(lastName, Math.random);
    if (lastName) {
      // 至少有别的选项时不应连续重复（pickIdleMicroAction 接收 name 字符串）。
      assert.equal(next.name !== lastName, true);
    }
    lastName = next.name;
  }
});

test('pickIdleMicroAction is deterministic with a fixed random source', () => {
  // random 永远返回 0 → 总选第一个（或过滤后第一个）
  const a = pickIdleMicroAction(null, () => 0);
  const b = pickIdleMicroAction(null, () => 0);
  assert.equal(a.name, b.name);
});

test('nextMicroActionDelay is between 8 and 20 seconds', () => {
  for (let i = 0; i < 20; i += 1) {
    const d = nextMicroActionDelay(() => i / 20);
    assert.equal(d >= 8000 && d <= 20000, true);
  }
});

test('MICRO_ACTION_PARAM_KEYS is a de-duplicated set covering all action params', () => {
  const allKeys = IDLE_MICRO_ACTIONS.flatMap((a) => Object.keys(a.params));
  for (const k of allKeys) {
    assert.equal(MICRO_ACTION_PARAM_KEYS.includes(k), true);
  }
  // 去重：长度等于 unique 数
  assert.equal(MICRO_ACTION_PARAM_KEYS.length, new Set(allKeys).size);
});
