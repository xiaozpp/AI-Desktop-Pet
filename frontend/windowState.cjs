// windowState.cjs - 窗口位置 + 漫游开关的持久化（main process 内部使用）。
// 落到 Electron userData 目录下的 window-state.json，renderer 不参与，
// 符合"BrowserWindow 位置只能由 main process 修改"的边界。
const fs = require('fs');
const path = require('path');

const STATE_FILENAME = 'window-state.json';

function statePath(userDataDir) {
  return path.join(userDataDir, STATE_FILENAME);
}

// state 形状：{ x, y, width, height, roamingEnabled, displayId, vitalityMode }
// vitalityMode 为字符串模式名（quiet/standby/roaming/lively）；缺失或非法时为 null，
// 由 main process 经 getMode() 兜底为默认 standby，windowState 本身不依赖 vitalityModes 模块。
function loadWindowState(userDataDir) {
  if (!userDataDir) return null;
  const file = statePath(userDataDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // 文件不存在或不可读：无持久态，返回 null 让调用方走默认位置。
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 坏 JSON：当作无持久态，不抛错（启动不应被损坏的状态文件卡住）。
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return normalizeWindowState(parsed);
}

// 把任意输入归一化成合法 state；非法字段剔除，保留可用的。
function normalizeWindowState(input) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    x: num(input.x),
    y: num(input.y),
    width: num(input.width),
    height: num(input.height),
    roamingEnabled: input.roamingEnabled === true,
    displayId: input.displayId != null ? input.displayId : null,
    vitalityMode: typeof input.vitalityMode === 'string' ? input.vitalityMode : null,
  };
}

// 原子写：先写 .tmp 再 rename，避免崩溃留下半截文件。
function saveWindowState(userDataDir, state) {
  if (!userDataDir) return;
  const file = statePath(userDataDir);
  const normalized = normalizeWindowState(state || {});
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    // 持久化失败不应阻断退出流程；清理残留 tmp。
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  STATE_FILENAME,
  statePath,
  loadWindowState,
  saveWindowState,
  normalizeWindowState,
};
