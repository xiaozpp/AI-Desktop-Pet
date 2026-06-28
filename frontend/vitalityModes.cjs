// vitalityModes.cjs - 活力档位定义（main process 内部使用）。
//
// 设计目标：让桌宠不再只有「漫游开/关」二态，而是按档位调整走动、停留、
// （第二闭环）主动搭话频率。档位是纯行为预设，不含养成数值、喂食或金币，
// 符合 AGENTS.md 第 9 条「未明确要求时不新增虚假桌宠玩法」。
//
// 模式名（quiet/standby/roaming/lively）是跨层契约：
//   - main process 据此配置 roaming 开关、速度范围、停留时长
//   - renderer 据此调整 idle 微动作间隔（各自维护一份同名映射）
//   - backend 据此调整主动搭话冷却（第二闭环）
//
// 纯数据 + 纯函数，不依赖 Electron，可被 Node 测试直接 require。

// 各档位参数：
//   roaming        : 是否开启桌面漫游
//   walkSpeed      : [min, max] px/s，漫游速度范围
//   idleSeconds    : [min, max] 到达目标后停留秒数
//   microInterval  : [min, max] ms，renderer 侧微动作间隔（renderer 侧用）
//   chatCooldown   : [min, max] s，后端主动搭话冷却（第二闭环用，0,0=关闭）
const VITALITY_MODES = {
  quiet: {
    label: '安静',
    roaming: false,
    walkSpeed: [0, 0],
    idleSeconds: [0, 0],
    microInterval: [30000, 60000],
    chatCooldown: [0, 0],
  },
  standby: {
    label: '待机',
    roaming: false,
    walkSpeed: [0, 0],
    idleSeconds: [0, 0],
    microInterval: [8000, 20000],
    chatCooldown: [0, 0],
  },
  roaming: {
    label: '漫游',
    roaming: true,
    walkSpeed: [85, 120],
    idleSeconds: [2, 8],
    microInterval: [8000, 20000],
    chatCooldown: [180, 360],
  },
  lively: {
    label: '活泼',
    roaming: true,
    walkSpeed: [110, 150],
    idleSeconds: [1, 4],
    microInterval: [4000, 10000],
    chatCooldown: [60, 180],
  },
};

const DEFAULT_MODE = 'standby';

// 合法模式名集合。
const MODE_NAMES = Object.keys(VITALITY_MODES);

// 取模式对象；未知/空值回落 standby（默认档），保证调用方永远拿到合法配置。
function getMode(name) {
  if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(VITALITY_MODES, name)) {
    return { name, ...VITALITY_MODES[name] };
  }
  return { name: DEFAULT_MODE, ...VITALITY_MODES[DEFAULT_MODE] };
}

function isValidMode(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(VITALITY_MODES, name);
}

// 在 [min, max] 内取随机值；random 注入便于测试。
function pickInRange(range, random = Math.random) {
  if (!Array.isArray(range) || range.length < 2) return 0;
  const [lo, hi] = range;
  if (lo === hi) return lo;
  return lo + random() * (hi - lo);
}

module.exports = {
  VITALITY_MODES,
  DEFAULT_MODE,
  MODE_NAMES,
  getMode,
  isValidMode,
  pickInRange,
};
