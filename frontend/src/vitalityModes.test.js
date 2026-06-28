import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VITALITY_MODES,
  DEFAULT_MODE,
  MODE_NAMES,
  getMode,
  isValidMode,
  pickInRange,
} from '../vitalityModes.cjs';

test('四个活力档位齐全且名字是跨层契约', () => {
  assert.deepEqual(MODE_NAMES, ['quiet', 'standby', 'roaming', 'lively']);
  assert.equal(DEFAULT_MODE, 'standby');
});

test('每个模式都有必需字段且类型正确', () => {
  for (const name of MODE_NAMES) {
    const m = VITALITY_MODES[name];
    assert.equal(typeof m.roaming, 'boolean', `${name}.roaming 应为布尔`);
    assert.ok(Array.isArray(m.walkSpeed) && m.walkSpeed.length === 2, `${name}.walkSpeed 应为 [min,max]`);
    assert.ok(Array.isArray(m.idleSeconds) && m.idleSeconds.length === 2, `${name}.idleSeconds 应为 [min,max]`);
    assert.ok(Array.isArray(m.microInterval) && m.microInterval.length === 2, `${name}.microInterval 应为 [min,max]`);
    assert.ok(Array.isArray(m.chatCooldown) && m.chatCooldown.length === 2, `${name}.chatCooldown 应为 [min,max]`);
  }
});

test('quiet/standby 不漫游，roaming/lively 漫游', () => {
  assert.equal(VITALITY_MODES.quiet.roaming, false);
  assert.equal(VITALITY_MODES.standby.roaming, false);
  assert.equal(VITALITY_MODES.roaming.roaming, true);
  assert.equal(VITALITY_MODES.lively.roaming, true);
});

test('非漫游档 walkSpeed 为 [0,0]，避免误触发移动', () => {
  assert.deepEqual(VITALITY_MODES.quiet.walkSpeed, [0, 0]);
  assert.deepEqual(VITALITY_MODES.standby.walkSpeed, [0, 0]);
});

test('getMode 返回带 name 的模式对象', () => {
  const m = getMode('lively');
  assert.equal(m.name, 'lively');
  assert.equal(m.roaming, true);
  assert.equal(m.label, '活泼');
});

test('getMode 对未知/空值回落 standby（调用方永远拿到合法配置）', () => {
  assert.equal(getMode('unknown').name, 'standby');
  assert.equal(getMode(null).name, 'standby');
  assert.equal(getMode(undefined).name, 'standby');
  assert.equal(getMode('').name, 'standby');
  assert.equal(getMode(123).name, 'standby');
});

test('isValidMode 区分合法与非法模式名', () => {
  for (const name of MODE_NAMES) assert.equal(isValidMode(name), true);
  assert.equal(isValidMode('nope'), false);
  assert.equal(isValidMode(null), false);
  assert.equal(isValidMode(123), false);
});

test('pickInRange 在闭区间内取值，注入 random 便于测试', () => {
  assert.equal(pickInRange([5, 5], () => 0), 5);
  assert.equal(pickInRange([10, 20], () => 0), 10);
  assert.equal(pickInRange([10, 20], () => 1), 20);
  assert.equal(pickInRange([10, 20], () => 0.5), 15);
});

test('pickInRange 对非法输入返回 0 而非抛错', () => {
  assert.equal(pickInRange(null), 0);
  assert.equal(pickInRange([]), 0);
  assert.equal(pickInRange([5]), 0);
});

test('安静档微动作最稀疏，活泼档最频繁（活力梯度成立）', () => {
  assert.ok(VITALITY_MODES.quiet.microInterval[0] > VITALITY_MODES.standby.microInterval[0]);
  assert.ok(VITALITY_MODES.lively.microInterval[0] < VITALITY_MODES.standby.microInterval[0]);
});

test('活泼档走速上限不低于漫游档（lively 真的更活蹦乱跳）', () => {
  assert.ok(VITALITY_MODES.lively.walkSpeed[1] >= VITALITY_MODES.roaming.walkSpeed[1]);
});

test('quiet/standby 的主动搭话冷却为 0（不主动打扰用户）', () => {
  assert.deepEqual(VITALITY_MODES.quiet.chatCooldown, [0, 0]);
  assert.deepEqual(VITALITY_MODES.standby.chatCooldown, [0, 0]);
});
