// frontend/src/idleActions.js
// 待机微动作定义与选择。纯函数，可被 Node 测试直接 import。
//
// 微动作用一组 PinkFox 参数的「目标值 + 持续时间」描述，
// useIdleAnimations 在微动作激活期间把这些参数平滑插值到目标，
// 结束后归零。让角色在静止时也不单调（歪头/看远方/轻摆/眯眼等）。

// 每个微动作：name 标识，params 是 { 参数Id: 目标值 }，duration 是毫秒。
export const IDLE_MICRO_ACTIONS = [
  {
    name: 'tilt-head',
    duration: 1800,
    params: { HeadAngleZ: 10 },
  },
  {
    name: 'look-away',
    duration: 2200,
    params: { HeadAngleX: 16, HeadAngleY: -6 },
  },
  {
    name: 'sway-body',
    duration: 2000,
    params: { ParamBodyAngleZ: 7, ParamAngleZ: 3 },
  },
  {
    name: 'squint',
    duration: 1400,
    params: { EyeSquint: 0.8 },
  },
  {
    name: 'look-up',
    duration: 1800,
    params: { HeadAngleY: -10 },
  },
  {
    name: 'lean',
    duration: 2000,
    params: { ParamBodyAngleX: 5, HeadAngleZ: -6 },
  },
];

// 选择下一个微动作：均匀随机，但不立即重复上一个。
// random: 注入随机函数（测试用），默认 Math.random。
export function pickIdleMicroAction(lastName, random = Math.random) {
  const pool = IDLE_MICRO_ACTIONS;
  if (!lastName) return pool[Math.floor(random() * pool.length)];
  // 过滤掉与上次同名的，避免连续重复；若只剩一个就允许重复。
  const filtered = pool.filter((a) => a.name !== lastName);
  const choices = filtered.length ? filtered : pool;
  return choices[Math.floor(random() * choices.length)];
}

// 下一次微动作的等待间隔（毫秒）。8~20s 之间随机。
export function nextMicroActionDelay(random = Math.random) {
  return 8000 + Math.floor(random() * 12000);
}

// 微动作涉及的所有参数键（用于结束时统一归零）。
export const MICRO_ACTION_PARAM_KEYS = Array.from(
  new Set(IDLE_MICRO_ACTIONS.flatMap((a) => Object.keys(a.params))),
);
