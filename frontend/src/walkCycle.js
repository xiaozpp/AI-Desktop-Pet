// frontend/src/walkCycle.js
// 纯函数：把"步态相位"映射成 PinkFox 身体参数值。
// 不依赖 React / PixiJS，可被 Node 测试直接 import。
// ponytail: walk.motion3.json 是同一组曲线的素材版；runtime 仍按速度重放这些参数，避免脚步和窗口位移脱节。
//
// 设计：一个完整步态周期 = phase ∈ [0, 2π)。
//   - 两只脚反相迈步（左脚着地时右脚抬起，反之亦然）。
//   - 身体上下起伏：脚离地的瞬间最高（钟形）。
//   - 重心 HipAngleX 左右交替：迈左脚时重心右移。
//   - 身体轻微扭转 ParamBodyAngleZ 跟随重心。
//   - 头部 ParamAngleZ 轻微左右摆，增加自然感。
//
// 参数 ID 取自 PinkFox.cdi3.json 已确认存在的参数（见 docs 第 5 节）。

// 步态参数幅度（度 / 归一化值）。集中在这里，便于调参与测试。
export const WALK_AMPLITUDES = {
  bob: 3.2,          // PositionY 上下起伏（px 量级，负值=向上）
  hipX: 5.5,         // HipAngleX 重心左右（度）
  hipX2: 2.2,        // HipAngleX2 轻微补偿，让脚底少滑
  bodyAngleX: 2.4,   // ParamBodyAngleX 前后小幅俯仰
  bodyAngleY: 2.0,   // ParamBodyAngleY 行进方向上的前倾
  bodyAngleZ: 3.6,   // ParamBodyAngleZ 上身扭转（度）
  headAngleX: 2.4,   // ParamAngleX 视线朝行进方向
  headAngleY: 1.4,   // ParamAngleY 随步态轻点头
  headAngleZ: 2.6,   // ParamAngleZ 头部左右摆（度）
  arm: 0.85,          // 手臂前后摆动
  skirt: 2.8,         // 裙摆随步态摆动
  tail: 5.5,          // 尾巴反向摆动
  stageBob: 4.5,      // Pixi 层垂直弹跳，弥补 rig 没有膝盖/脚踝
  stageRock: 0.018,   // Pixi 层轻微左右摇摆（弧度）
};

export function walkCadence(speed = 0) {
  const clamped = Math.min(Math.max(speed, 60), 150);
  return 1.05 + (clamped - 60) / 90 * 0.85;
}

// 单只脚的"抬起量"：0=完全着地，1=最高抬起。
// 相位约定：phase∈[0,π) 时左脚摆动相（抬起），右脚支撑；[π,2π) 反之。
// 用 sin 的正半轴让抬脚平滑（中段最高），着地半周期为 0。
// 注意：脚的抬起只用半周期，所以不能简单取 phase mod π——那样左右脚会同时抬起。
export function footLift(phase) {
  return Math.max(0, Math.sin(phase)); // [0,1]：着地半周期=0，中段最高=1
}

// 给定相位，返回左右脚各自的抬起量（半周期错开，真正反相）。
export function feet(phase) {
  return { left: footLift(phase), right: footLift(phase + Math.PI) };
}

// 身体上下起伏：任意一只脚处于摆动相中段时身体被顶到最高。
// 用 |sin(phase)| 的钟形：phase=π/2（左脚最高）和 phase=3π/2（右脚最高）时身体最高。
export function bobHeight(phase) {
  return Math.abs(Math.sin(phase)); // [0,1]
}

// 重心左右偏移：正弦，与抬左脚同步（抬左脚→重心压右脚）。
export function hipShift(phase) {
  return Math.sin(phase); // [-1,1]
}

// 把相位映射成 PinkFox 参数 { id: value } 字典（已乘上幅度）。
// direction: 'left' | 'right' —— 朝向决定头部/上身的整体偏转方向基准。
export function walkParams(phase, direction = 'right') {
  const facing = direction === 'left' ? -1 : 1;
  const bob = bobHeight(phase);
  const hip = hipShift(phase);
  const { left, right } = feet(phase);
  const contact = 1 - bob;
  const travelLean = facing * (0.7 + bob * 0.3);
  const armSwing = Math.sin(phase + Math.PI) * WALK_AMPLITUDES.arm;
  const skirtSwing = hip * WALK_AMPLITUDES.skirt * facing;

  return {
    // 向上为负（PinkFox 中 PositionY 负方向是上移），抬脚顶点身体最高。
    PositionY: -bob * WALK_AMPLITUDES.bob,
    // 重心：sin(phase)>0（抬左脚）时重心压向右（正值朝右）。
    HipAngleX: hip * WALK_AMPLITUDES.hipX * facing,
    HipAngleX2: -hip * WALK_AMPLITUDES.hipX2 * facing,
    ParamBodyAngleX: Math.sin(phase * 2) * WALK_AMPLITUDES.bodyAngleX,
    ParamBodyAngleY: travelLean * WALK_AMPLITUDES.bodyAngleY,
    // 上身跟随重心轻扭。
    ParamBodyAngleZ: hip * WALK_AMPLITUDES.bodyAngleZ * facing,
    ParamAngleX: travelLean * WALK_AMPLITUDES.headAngleX,
    ParamAngleY: -contact * WALK_AMPLITUDES.headAngleY,
    // 头部轻摆，幅度更小。
    ParamAngleZ: hip * WALK_AMPLITUDES.headAngleZ * facing,
    // 并腿/迈步：抬起的那只脚值高（PinkFox 的 ParamBodyFeetL/R 是并腿参数，
    // 用抬脚量驱动，模拟抬腿离地）。左脚抬起时左值大。
    ParamBodyFeetL: left,
    ParamBodyFeetR: right,
    ShoulderZ: -hip * 1.8 * facing,
    Param33: Math.max(0, armSwing),
    Param34: Math.max(0, -armSwing),
    Param37: Math.max(0, -armSwing),
    Param38: Math.max(0, armSwing),
    SkirtX1: skirtSwing,
    SkirtX2: skirtSwing * 0.72,
    SkirtX3: skirtSwing * 0.46,
    SkirtL1: left * 0.55,
    SkirtL2: left * 0.38,
    SkirtR1: right * 0.55,
    SkirtR2: right * 0.38,
    Param_Angle_Rotation_1_ArtMesh199: -hip * WALK_AMPLITUDES.tail * facing,
    Param_Angle_Rotation_2_ArtMesh199: -hip * WALK_AMPLITUDES.tail * 0.82 * facing,
    Param_Angle_Rotation_3_ArtMesh199: -hip * WALK_AMPLITUDES.tail * 0.64 * facing,
  };
}

export function walkStageTransform(phase) {
  return {
    y: -bobHeight(phase) * WALK_AMPLITUDES.stageBob,
    rotation: hipShift(phase) * WALK_AMPLITUDES.stageRock,
  };
}

// 停止走路时应归零的参数键（确保残留动作被清除）。
export const WALK_PARAM_KEYS = [
  'PositionY',
  'HipAngleX',
  'HipAngleX2',
  'ParamBodyAngleX',
  'ParamBodyAngleY',
  'ParamBodyAngleZ',
  'ParamAngleX',
  'ParamAngleY',
  'ParamAngleZ',
  'ParamBodyFeetL',
  'ParamBodyFeetR',
  'ShoulderZ',
  'Param33',
  'Param34',
  'Param37',
  'Param38',
  'SkirtX1',
  'SkirtX2',
  'SkirtX3',
  'SkirtL1',
  'SkirtL2',
  'SkirtR1',
  'SkirtR2',
  'Param_Angle_Rotation_1_ArtMesh199',
  'Param_Angle_Rotation_2_ArtMesh199',
  'Param_Angle_Rotation_3_ArtMesh199',
];
