import assert from 'node:assert/strict';
import test from 'node:test';
import {
  walkParams,
  walkStageTransform,
  walkCadence,
  feet,
  footLift,
  bobHeight,
  hipShift,
  WALK_PARAM_KEYS,
  WALK_AMPLITUDES,
} from './walkCycle.js';

const TAU = Math.PI * 2;

test('footLift stays in [0,1] and is zero during the stance half-cycle', () => {
  // 抬起半周期 [0,π) 为正，支撑半周期 [π,2π) 为 0（max(0, sin)）。
  for (let i = 0; i < 24; i += 1) {
    const phase = (i / 24) * TAU;
    const lift = footLift(phase);
    assert.equal(lift >= 0 && lift <= 1, true);
    if (phase > Math.PI) assert.equal(lift, 0, `stance should be flat at phase ${phase}`);
  }
  assert.equal(Math.abs(footLift(Math.PI / 2) - 1) < 1e-9, true);
});

test('hipShift swings left/right symmetrically across the cycle', () => {
  // 重心左右偏移应在 +1 与 -1 之间对称。
  assert.equal(Math.abs(hipShift(Math.PI / 2) - 1) < 1e-9, true);
  assert.equal(Math.abs(hipShift(3 * Math.PI / 2) + 1) < 1e-9, true);
  assert.equal(Math.abs(hipShift(0)) < 1e-9, true);
});

test('a full walk cycle keeps both feet alternately lifting (never both fully up)', () => {
  // 在一个周期内采样，任意时刻左右脚不会同时处于"最高抬起"。
  for (let i = 0; i < 24; i += 1) {
    const phase = (i / 24) * TAU;
    const { left, right } = feet(phase);
    assert.equal(left >= 0 && left <= 1, true);
    assert.equal(right >= 0 && right <= 1, true);
    // 不会两只脚同时接近最高（否则就是双脚离地，不符合走路）。
    assert.equal(left + right <= 1.05, true, `both feet up at phase ${phase}: ${left},${right}`);
  }
});

test('left and right feet are half a cycle out of phase', () => {
  // 左脚最高点出现在前半周期，右脚出现在后半周期。
  let leftPeakPhase = -1;
  let rightPeakPhase = -1;
  for (let i = 0; i < 1000; i += 1) {
    const phase = (i / 1000) * TAU;
    const { left, right } = feet(phase);
    if (left > 0.999) leftPeakPhase = leftPeakPhase < 0 ? phase : leftPeakPhase;
    if (right > 0.999) rightPeakPhase = rightPeakPhase < 0 ? phase : rightPeakPhase;
  }
  assert.equal(leftPeakPhase >= 0 && rightPeakPhase >= 0, true);
  assert.equal(Math.abs((rightPeakPhase - leftPeakPhase) - Math.PI) < 0.2, true);
});

test('bob height peaks when a foot is at its highest', () => {
  // 抬脚顶点（相位 π/2、3π/2）时身体最高（bobHeight≈1），脚着地时身体最低（≈0）。
  assert.equal(bobHeight(0) < 1e-9, true);
  assert.equal(Math.abs(bobHeight(Math.PI / 2) - 1) < 1e-9, true);
  assert.equal(bobHeight(Math.PI) < 1e-9, true);
});

test('walkParams produces all expected PinkFox parameter keys', () => {
  const params = walkParams(0, 'right');
  for (const key of WALK_PARAM_KEYS) {
    assert.equal(key in params, true, `missing param key: ${key}`);
  }
});

test('walkParams mirrors horizontally when facing left', () => {
  // 朝左时重心/扭转/头部摆动方向应与朝右相反（facing=-1）。
  const right = walkParams(Math.PI / 4, 'right');
  const left = walkParams(Math.PI / 4, 'left');
  // HipAngleX 方向相反。
  assert.equal(right.HipAngleX === -left.HipAngleX, true);
  assert.equal(right.HipAngleX2 === -left.HipAngleX2, true);
  assert.equal(right.ParamBodyAngleY === -left.ParamBodyAngleY, true);
  assert.equal(right.ParamAngleX === -left.ParamAngleX, true);
  assert.equal(right.ParamBodyAngleZ === -left.ParamBodyAngleZ, true);
  // 垂直起伏与朝向无关，应相同。
  assert.equal(right.PositionY, left.PositionY);
});

test('walkParams at ground phase keeps feet flat and body centered', () => {
  // phase=0：两脚都在着地点（footLift≈0），身体在最低点。用近似容忍浮点误差。
  const params = walkParams(0, 'right');
  assert.equal(params.ParamBodyFeetL < 1e-9, true);
  assert.equal(params.ParamBodyFeetR < 1e-9, true);
  assert.equal(Math.abs(params.PositionY) < 1e-9, true);
  assert.equal(Math.abs(params.HipAngleX) < 1e-9, true);
});

test('walkParams drives visible non-translation cues', () => {
  const quarter = walkParams(Math.PI / 2, 'right');
  assert.equal(quarter.ParamBodyFeetL > 0.9, true);
  assert.equal(Math.abs(quarter.ShoulderZ) > 1, true);
  assert.equal(quarter.Param34 > 0 || quarter.Param38 > 0, true);
  assert.equal(Math.abs(quarter.SkirtX1) > 1, true);
  assert.equal(Math.abs(quarter.Param_Angle_Rotation_1_ArtMesh199) > 3, true);
});

test('walkStageTransform adds a small body bounce and rock', () => {
  assert.deepEqual(walkStageTransform(0), { y: -0, rotation: 0 });
  const lifted = walkStageTransform(Math.PI / 2);
  assert.equal(lifted.y < -3, true);
  assert.equal(lifted.rotation > 0.01, true);
});

test('amplitudes are modest to avoid grotesque motion', () => {
  // 走路幅度不应过大：起伏不超过 5px，扭转不超过 10°。
  assert.equal(WALK_AMPLITUDES.bob <= 5, true);
  assert.equal(WALK_AMPLITUDES.hipX <= 10, true);
  assert.equal(WALK_AMPLITUDES.bodyAngleX <= 4, true);
  assert.equal(WALK_AMPLITUDES.bodyAngleY <= 4, true);
  assert.equal(WALK_AMPLITUDES.bodyAngleZ <= 8, true);
  assert.equal(WALK_AMPLITUDES.headAngleZ <= 5, true);
  assert.equal(WALK_AMPLITUDES.stageBob <= 6, true);
  assert.equal(WALK_AMPLITUDES.stageRock <= 0.03, true);
});

test('walk cadence rises with speed without becoming a frantic shuffle', () => {
  assert.equal(walkCadence(60) < walkCadence(110), true);
  assert.equal(walkCadence(110) < walkCadence(150), true);
  assert.equal(walkCadence(0), walkCadence(60));
  assert.equal(walkCadence(300), walkCadence(150));
  assert.equal(walkCadence(110) >= 1.4 && walkCadence(110) <= 1.7, true);
});
