// frontend/src/apiConfig.js
// 统一管理后端 API 地址。打包版默认连接 Electron 自动启动的本地后端。

const STORAGE_KEY = 'neuro_backend_url';

// 本地后端默认值。保留 localStorage 覆盖能力，方便开发/排障时临时连远程服务。
const DEV_DEFAULT = 'http://127.0.0.1:8000';

/** 读取已保存的后端地址，没有则返回 DEV_DEFAULT。 */
export function getBackendUrl() {
  if (globalThis.location?.protocol === 'file:') return DEV_DEFAULT;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch {
    // localStorage 不可用时回退默认值
  }
  return DEV_DEFAULT;
}

/** 保存后端地址到 localStorage。 */
export function setBackendUrl(url) {
  if (typeof url !== 'string') return;
  const trimmed = url.trim().replace(/\/+$/, ''); // 去尾部斜杠，避免 //path
  if (trimmed) {
    try {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      // localStorage 不可用时静默失败（如隐私模式）
    }
  }
}

/** HTTP API 基址（如 http://127.0.0.1:8000 或 https://neuro.aipanni.com）。 */
export function getApiBaseUrl() {
  return getBackendUrl();
}

/** WebSocket 基址。自动把 http(s):// 转成 ws(s)://，附加 /ws。 */
export function getWsBaseUrl() {
  const base = getBackendUrl();
  return base.replace(/^http/, 'ws') + '/ws';
}
