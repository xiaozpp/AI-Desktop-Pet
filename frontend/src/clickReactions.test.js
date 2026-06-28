import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLICK_REACTIONS,
  pickClickReaction,
  CLICK_REACTION_PARAM_KEYS,
} from './clickReactions.js';

test('click reaction pool has multiple reactions with positive weights', () => {
  assert.equal(CLICK_REACTIONS.length >= 3, true);
  for (const r of CLICK_REACTIONS) {
    assert.equal(typeof r.name === 'string' && r.name.length > 0, true);
    assert.equal(r.weight > 0, true);
    assert.equal(r.duration > 0, true);
    assert.equal(Object.keys(r.params).length > 0, true);
  }
});

test('pickClickReaction always returns a reaction from the pool', () => {
  const names = new Set(CLICK_REACTIONS.map((r) => r.name));
  for (let i = 0; i < 50; i += 1) {
    const r = pickClickReaction(() => i / 50);
    assert.equal(names.has(r.name), true);
  }
});

test('weighted selection favors heavier reactions', () => {
  // 验证权重确实影响分布：大量采样后，权重高的出现次数 >= 权重低的。
  const counts = {};
  for (let i = 0; i < 2000; i += 1) {
    const r = pickClickReaction();
    counts[r.name] = (counts[r.name] || 0) + 1;
  }
  const maxWeight = Math.max(...CLICK_REACTIONS.map((r) => r.weight));
  const minWeight = Math.min(...CLICK_REACTIONS.map((r) => r.weight));
  const heavyName = CLICK_REACTIONS.find((r) => r.weight === maxWeight).name;
  const lightName = CLICK_REACTIONS.find((r) => r.weight === minWeight).name;
  assert.equal(counts[heavyName] > counts[lightName], true);
});

test('cry is the rarest reaction (lowest weight)', () => {
  const cry = CLICK_REACTIONS.find((r) => r.name === 'cry');
  assert.equal(!!cry, true);
  const minWeight = Math.min(...CLICK_REACTIONS.map((r) => r.weight));
  assert.equal(cry.weight, minWeight);
});

test('CLICK_REACTION_PARAM_KEYS is de-duplicated and covers all params', () => {
  const allKeys = CLICK_REACTIONS.flatMap((r) => Object.keys(r.params));
  for (const k of allKeys) {
    assert.equal(CLICK_REACTION_PARAM_KEYS.includes(k), true);
  }
  assert.equal(CLICK_REACTION_PARAM_KEYS.length, new Set(allKeys).size);
});
