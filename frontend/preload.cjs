// preload.cjs - 在隔离上下文下向前端暴露安全的 IPC API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  // 切换点击穿透：ignore=true 时鼠标穿过窗口（可点桌面），false 时窗口可交互
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', ignore),
  setRoaming: (enabled) => ipcRenderer.send('pet:set-roaming', enabled),
  // 切换活力档位（quiet/standby/roaming/lively），由 main process 应用到漫游行为
  setVitalityMode: (mode) => ipcRenderer.send('pet:set-vitality-mode', mode),
  setRoamingPaused: (reason, paused) => ipcRenderer.send('pet:set-roaming-paused', reason, paused),
  onMovementState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:movement-state', listener);
    return () => ipcRenderer.removeListener('pet:movement-state', listener);
  },
  // 监听 main process 广播的活力档位变化（启动恢复 + 用户切换都会触发）
  onVitalityMode: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('pet:vitality-mode-changed', listener);
    return () => ipcRenderer.removeListener('pet:vitality-mode-changed', listener);
  },
});
