import assert from 'node:assert/strict';
import test from 'node:test';
import roaming from '../roaming.cjs';

test('roaming clamps the window to the current display bottom edge', () => {
  assert.deepEqual(
    roaming.clampToWorkArea(
      { x: 1900, y: 900, width: 300, height: 420 },
      { x: 1920, y: 0, width: 1280, height: 1000 },
    ),
    { x: 1920, y: 580 },
  );
});

test('roaming target is inside the display and moves at least 80 pixels when possible', () => {
  const target = roaming.chooseTargetX(500, { x: 0, width: 1920 }, 300, () => 0);
  assert.equal(target >= 0 && target <= 1620, true);
  assert.equal(Math.abs(target - 500) >= 80, true);
});

test('PinkFox registers a motion whose curve parameters exist in its display info', async () => {
  const { readFile } = await import('node:fs/promises');
  const base = new URL('../public/models/PinkFox/', import.meta.url);
  const model = JSON.parse(await readFile(new URL('PinkFox.model3.json', base), 'utf8'));
  const display = JSON.parse(await readFile(new URL('PinkFox.cdi3.json', base), 'utf8'));
  const registered = Object.values(model.FileReferences.Motions).flat().map(({ File }) => File);
  assert.equal(registered.includes('kuku.motion3.json'), true);
  assert.equal(registered.includes('walk.motion3.json'), true);
  const motions = await Promise.all(registered.map(async (file) => JSON.parse(await readFile(new URL(file, base), 'utf8'))));
  const ids = new Set(display.Parameters.map(({ Id }) => Id));
  const missing = motions.flatMap((motion) => motion.Curves.map(({ Id }) => Id).filter((id) => !ids.has(id)));
  assert.deepEqual(missing, []);
});

test('PinkFox Walk motion is looped and covers the runtime patrol gait parameters', async () => {
  const { readFile } = await import('node:fs/promises');
  const { WALK_PARAM_KEYS } = await import('./walkCycle.js');
  const base = new URL('../public/models/PinkFox/', import.meta.url);
  const model = JSON.parse(await readFile(new URL('PinkFox.model3.json', base), 'utf8'));
  const motion = JSON.parse(await readFile(new URL('walk.motion3.json', base), 'utf8'));
  assert.equal(model.FileReferences.Motions.Walk[0].File, 'walk.motion3.json');
  assert.equal(motion.Meta.Loop, true);
  assert.equal(motion.Meta.Duration, 0.8);
  const curveIds = motion.Curves.map(({ Id }) => Id);
  assert.deepEqual(WALK_PARAM_KEYS.filter((id) => !curveIds.includes(id)), []);
  for (const curve of motion.Curves) {
    assert.equal(curve.Target, 'Parameter');
    assert.equal(curve.Segments[0], 0);
    assert.equal(curve.Segments.at(-2), 0.8);
  }
});

test('Kuku motion remains registered for non-walk reactions', async () => {
  const { readFile } = await import('node:fs/promises');
  const base = new URL('../public/models/PinkFox/', import.meta.url);
  const model = JSON.parse(await readFile(new URL('PinkFox.model3.json', base), 'utf8'));
  const motion = JSON.parse(await readFile(new URL('kuku.motion3.json', base), 'utf8'));
  assert.equal(model.FileReferences.Motions.Kuku[0].File, 'kuku.motion3.json');
  assert.equal(motion.Meta.Loop, true);
});

test('PinkFox exposes the parameters used by the temporary patrol gait', async () => {
  const { readFile } = await import('node:fs/promises');
  const { WALK_PARAM_KEYS } = await import('./walkCycle.js');
  const display = JSON.parse(await readFile(new URL('../public/models/PinkFox/PinkFox.cdi3.json', import.meta.url), 'utf8'));
  const ids = new Set(display.Parameters.map(({ Id }) => Id));
  assert.deepEqual(WALK_PARAM_KEYS.filter((id) => !ids.has(id)), []);
});

// === 多显示器与断屏恢复 ===

const DISPLAYS = [
  { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, // 主屏
  { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1000 } }, // 右侧副屏
];

test('displayIdFor picks the display whose workArea contains the window center', () => {
  assert.equal(roaming.displayIdFor({ x: 100, y: 500, width: 300, height: 420 }, DISPLAYS), 1);
  assert.equal(roaming.displayIdFor({ x: 2200, y: 400, width: 300, height: 420 }, DISPLAYS), 2);
});

test('displayIdFor falls back by overlap when the window center is off-screen', () => {
  // 窗口中心在两屏之间的缝隙外，按重叠面积挑屏。
  const id = roaming.displayIdFor({ x: 1850, y: 400, width: 300, height: 420 }, DISPLAYS);
  assert.equal(id === 1 || id === 2, true);
});

test('resolveStartupBounds clamps saved bounds onto the remembered display', () => {
  const resolved = roaming.resolveStartupBounds(
    { x: 2200, y: 560, width: 300, height: 420, displayId: 2 },
    DISPLAYS,
  );
  assert.equal(resolved.displayId, 2);
  // 落在副屏 workArea 底部、合法 x 范围内。
  assert.equal(resolved.x >= 1920 && resolved.x <= 1920 + 1280 - 300, true);
  assert.equal(resolved.y, 0 + 1000 - 420);
});

test('resolveStartupBounds falls back to primary display when the saved display is gone', () => {
  // 模拟拔掉副屏：displays 里只剩主屏，但 saved 记的是副屏 id=2。
  const onlyPrimary = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  const resolved = roaming.resolveStartupBounds(
    { x: 2200, y: 560, width: 300, height: 420, displayId: 2 },
    onlyPrimary,
  );
  // 退回主屏，坐标合法，不会停在屏幕外。
  assert.equal(resolved.displayId, 1);
  assert.equal(resolved.x >= 0 && resolved.x <= 1920 - 300, true);
  assert.equal(resolved.y, 1040 - 420);
});

test('resolveStartupBounds returns a safe fallback when there is no saved state', () => {
  const resolved = roaming.resolveStartupBounds(null, DISPLAYS, { windowWidth: 300, windowHeight: 420 });
  assert.equal(resolved.displayId, 1);
  assert.equal(resolved.x, 1920 - 300 - 20);
  assert.equal(resolved.y, 1040 - 420 - 20);
});
