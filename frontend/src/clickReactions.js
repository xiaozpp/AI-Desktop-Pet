// frontend/src/clickReactions.js
// 点击角色的反应动作池。纯函数，可被 Node 测试直接 import。
//
// 每个反应：name 标识，params 是 { 参数Id: 目标值 }，duration 毫秒，
// weight 是相对权重（稀有反应权重低）。Live2DModel 的 hit handler 选取后
// 在 duration 内把参数插值到目标再归零。

export const CLICK_REACTIONS = [
  { name: 'surprise', duration: 1200, weight: 3, params: { HeadAngleZ: 12, ParamBrowLY: 0.8, ParamBrowRY: 0.8 } },
  { name: 'tongue', duration: 1400, weight: 3, params: { key2: 1 } }, // 吐舌
  { name: 'squint-smile', duration: 1500, weight: 3, params: { EyeSquint: 0.9, ParamEyeLSmile: 1, ParamEyeRSmile: 1 } },
  { name: 'hop', duration: 1000, weight: 2, params: { PositionY: -8 } }, // 轻跳
  { name: 'tilt', duration: 1300, weight: 3, params: { HeadAngleZ: -10, ParamBodyAngleZ: 4 } },
  // 稀有：哭（原 Kuku 眼泪动画语义）。
  { name: 'cry', duration: 2000, weight: 1, params: { key4: 1 } },
];

// 按权重随机选一个反应。random 注入便于测试。
export function pickClickReaction(random = Math.random) {
  const total = CLICK_REACTIONS.reduce((sum, r) => sum + r.weight, 0);
  let roll = random() * total;
  for (const r of CLICK_REACTIONS) {
    roll -= r.weight;
    if (roll <= 0) return r;
  }
  return CLICK_REACTIONS[0];
}

// 反应涉及的所有参数键。
export const CLICK_REACTION_PARAM_KEYS = Array.from(
  new Set(CLICK_REACTIONS.flatMap((r) => Object.keys(r.params))),
);
