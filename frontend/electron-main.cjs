const { app, BrowserWindow, screen, Tray, Menu, ipcMain, nativeImage, session } = require('electron');
const path = require('path');
const { TICK_MS, clampToWorkArea, chooseTargetX, displayIdFor, resolveStartupBounds } = require('./roaming.cjs');
const { loadWindowState, saveWindowState } = require('./windowState.cjs');
const { getMode, pickInRange } = require('./vitalityModes.cjs');
const { startBackend, stopBackend } = require('./backendProcess.cjs');

// 【核心修复 1】禁用硬件加速，否则 Windows 上透明窗口会变黑
app.disableHardwareAcceleration();

// 【核心修复 2】允许延迟创建，防止黑屏闪烁
let win = null;
let tray = null;
let backendProcess = null;
let roamingEnabled = false;
let roamingTimer = null;
let roamingTargetX = null;
let roamingDirection = 'right';
let roamingSpeed = 110;
let idleUntil = 0;
let ignoreMoveEventsUntil = 0;
let dragResumeTimer = null;
// 活力档位：quiet/standby/roaming/lively。权威源在 main process，
// renderer 经 IPC pet:set-vitality-mode 切换，模式驱动 roaming 开关与速度/停留参数。
// 默认 standby（原地待机，不漫游），符合 AGENTS.md「漫游默认关闭」。
let vitalityMode = getMode(null);
// 记录窗口当前所在显示器 id。显示器变化（拔副屏/dpi 变化/拖到副屏）时，
// 清掉旧目标重新选，并 clamp 到新显示器 workArea，避免窗口停在屏幕外。
let currentDisplayId = null;
const ALLOWED_PAUSE_REASONS = new Set(['auth', 'panel-open', 'typing', 'thinking', 'speaking', 'recording']);
// 登录前即使用户上次开启了漫游，也先停住；renderer 验证通过后解除。
const pauseReasons = new Set(['auth']);

function isAllowedAppOrigin(requestingOrigin) {
  return (
    requestingOrigin.startsWith('file://') ||
    requestingOrigin.startsWith('http://localhost:5173') ||
    requestingOrigin.startsWith('http://127.0.0.1:5173')
  );
}

function setupMediaPermissions() {
  // setPermissionRequestHandler：首次请求权限时触发（异步回调）。
  // setPermissionCheckHandler：每次同步检查权限状态时触发（getUserMedia 会先查它）。
  // Electron 28+ 必须同时设置两个，否则 getUserMedia 会被其中缺失的那个拒绝。
  //
  // 注意：getUserMedia 触发的 media 权限请求里 details.requestingOrigin 经常是空字符串，
  // 必须改用 webContents.getURL() 取真实页面地址，否则永远判 false。
  const urlOf = (webContents, details) => {
    try {
      return webContents?.getURL?.() || details?.requestingOrigin || '';
    } catch {
      return details?.requestingOrigin || '';
    }
  };
  const allowedPermission = (permission, url) => {
    // Electron 28+ 废弃了 'media'，改用独立的 'microphone' / 'camera'。两者都要兼容。
    return (
      permission === 'media' || permission === 'microphone' || permission === 'camera'
    ) && isAllowedAppOrigin(url);
  };

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = urlOf(webContents, details);
    const allowed = allowedPermission(permission, url);
    console.log(`[权限-请求] ${permission} | url: ${url} | 允许: ${allowed}`);
    callback(allowed);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const url = urlOf(webContents, { requestingOrigin }) || requestingOrigin || '';
    const allowed = allowedPermission(permission, url);
    if (permission === 'media' || permission === 'microphone' || permission === 'camera') {
      console.log(`[权限-检查] ${permission} | url: ${url} | 允许: ${allowed}`);
    }
    return allowed;
  });
}

function sendMovementState(phase, speed = 0) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:movement-state', { phase, direction: roamingDirection, speed });
  }
}

function stopRoaming() {
  if (roamingTimer) clearInterval(roamingTimer);
  roamingTimer = null;
  roamingTargetX = null;
  sendMovementState(roamingEnabled ? 'paused' : 'disabled');
}

function setRoamingPaused(reason, paused) {
  if (!ALLOWED_PAUSE_REASONS.has(reason) && reason !== 'user-dragging') return;
  if (paused) pauseReasons.add(reason);
  else pauseReasons.delete(reason);
  if (pauseReasons.size) stopRoaming();
  else if (roamingEnabled) startRoaming();
}

function moveWindow(x, y) {
  ignoreMoveEventsUntil = Date.now() + 100;
  win.setPosition(Math.round(x), Math.round(y));
}

function roamingTick() {
  if (!win || win.isDestroyed() || !win.isVisible() || pauseReasons.size) return;
  const bounds = win.getBounds();
  // 用 getDisplayMatching 找窗口所在显示器；拔副屏后会自然回到主屏，这是断屏恢复的关键。
  const matching = screen.getDisplayMatching(bounds);
  const workArea = matching.workArea;
  const clamped = clampToWorkArea(bounds, workArea);
  if (bounds.y !== clamped.y || bounds.x !== clamped.x) moveWindow(clamped.x, clamped.y);

  // 显示器变化（拔副屏 / 拖到副屏 / dpi 变化）：清旧目标重选，并同步朝向。
  if (matching.id !== currentDisplayId) {
    currentDisplayId = matching.id;
    roamingTargetX = null;
  }

  const now = Date.now();
  if (now < idleUntil) {
    sendMovementState('idle');
    return;
  }
  if (roamingTargetX === null) {
    roamingTargetX = chooseTargetX(clamped.x, workArea, bounds.width);
    roamingDirection = roamingTargetX < clamped.x ? 'left' : 'right';
    roamingSpeed = pickInRange(vitalityMode.walkSpeed);
  }

  const distance = roamingTargetX - clamped.x;
  if (Math.abs(distance) <= 3) {
    moveWindow(roamingTargetX, clamped.y);
    roamingTargetX = null;
    idleUntil = now + pickInRange(vitalityMode.idleSeconds) * 1000;
    sendMovementState('idle');
    return;
  }

  const step = Math.sign(distance) * Math.min(Math.abs(distance), roamingSpeed * TICK_MS / 1000);
  moveWindow(clamped.x + step, clamped.y);
  sendMovementState('walking', Math.round(roamingSpeed));
}

function startRoaming() {
  if (!roamingEnabled || pauseReasons.size || roamingTimer) return;
  idleUntil = Date.now() + 1000;
  roamingTimer = setInterval(roamingTick, TICK_MS);
  sendMovementState('idle');
}

// 切换活力档位：权威入口。根据模式 roaming 字段开/关漫游，速度与停留时长
// 由 roamingTick 从 vitalityMode 读取。renderer 经 IPC 调用，托盘 checkbox 也委托到这里。
function setVitalityMode(name) {
  vitalityMode = getMode(name);
  roamingEnabled = vitalityMode.roaming;
  if (roamingEnabled) startRoaming();
  else stopRoaming();
  // 广播模式名给 renderer，使其同步 UI 显示与 idle 微动作间隔。
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send('pet:vitality-mode-changed', vitalityMode.name);
  }
  persistWindowState();
}

function setRoaming(enabled) {
  // 托盘「桌面漫游」checkbox 的快捷切换：勾选=roaming 档，取消=standby 档。
  setVitalityMode(enabled ? 'roaming' : 'standby');
}

// 把当前窗口 bounds + 漫游开关 + 显示器 id 写到 userData。
// 不在每 tick 调用（避免频繁 IO）；只在状态变化时和退出时写。
function persistWindowState() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  saveWindowState(app.getPath('userData'), {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    roamingEnabled,
    displayId: currentDisplayId,
    vitalityMode: vitalityMode.name,
  });
}

function getIconPath() {
  return path.join(
    __dirname,
    app.isPackaged ? 'dist' : 'public',
    'models', 'PinkFox', 'icon.png',
  );
}

function createWindow(startBounds) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 300,              // 缩小：从 450→300，少占桌面
    height: 420,             // 从 650→420
    // 启动位置：优先用持久化并经 resolveStartupBounds clamp 过的位置（含断屏回退）；
    // 没有持久态时退回主屏右下角。
    x: startBounds && Number.isFinite(startBounds.x) ? startBounds.x : width - 320,
    y: startBounds && Number.isFinite(startBounds.y) ? startBounds.y : height - 440,

    // 【核心修复 3】窗口属性配置
    frame: false,             // 无边框
    transparent: true,        // 开启透明
    backgroundColor: '#00000000', // 关键！ARGB格式，前两位00代表完全透明
    alwaysOnTop: true,        // 置顶
    hasShadow: false,         // 去掉系统阴影
    resizable: true,          // 允许调整大小
    skipTaskbar: false,       // 仍显示在任务栏（可改 true 隐藏）
    icon: getIconPath(),

    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,   // 安全：隔离上下文
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    }
  });

  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  } else {
    win.loadURL('http://localhost:5173');
  }

  // 开发模式：把渲染进程的 console 日志转发到主进程终端，方便在 npm start 终端看到 🎤 日志。
  // 同时可按需打开 DevTools（默认注释，避免遮挡透明小窗口）。
  if (!app.isPackaged) {
    win.webContents.on('console-message', (_event, _level, message, _line, _sourceId) => {
      console.log(`[renderer] ${message}`);
    });
    // 调试时取消下行注释可打开 DevTools：
    // win.webContents.openDevTools({ mode: 'detach' });
  }

  // 点击穿透策略：默认【不穿透】。
  // 窗口视觉透明（transparent + #00000000），但鼠标始终可交互、可拖动。
  // 想让桌宠"不挡桌面"时，用托盘菜单的"开启点击穿透"切换。
  // 之前默认开启穿透会导致 drag 区域收不到鼠标事件、窗口拖不动。

  // 关闭按钮 → 缩到托盘而非退出
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('move', () => {
    if (Date.now() < ignoreMoveEventsUntil || !roamingEnabled) return;
    clearTimeout(dragResumeTimer);
    setRoamingPaused('user-dragging', true);
    // 用户停止拖动 15s 后恢复漫游，并在此时持久化新位置（拖动期间不写，避免频繁 IO）。
    dragResumeTimer = setTimeout(() => {
      setRoamingPaused('user-dragging', false);
      persistWindowState();
    }, 15000);
  });
}

// === 托盘菜单 ===
function createTray() {
  // 用一个 1x1 透明图标兜底（没有图标资源时）；有 icon.ico 可替换
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(getIconPath()).resize({ width: 32, height: 32 });
    if (trayIcon.isEmpty()) throw new Error('no icon');
  } catch {
    // 兜底：空图标（Windows 会显示默认）
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('Neuro');

  // 穿透状态（菜单可切换）
  let clickThrough = false;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏桌宠',
      click: () => {
        if (win.isVisible()) win.hide();
        else win.show();
      }
    },
    {
      label: '桌面漫游',
      type: 'checkbox',
      checked: vitalityMode.roaming,
      click: (item) => setRoaming(item.checked)
    },
    {
      label: '开启点击穿透（桌宠不挡桌面）',
      type: 'checkbox',
      checked: false,
      click: (item) => {
        clickThrough = item.checked;
        if (win) win.setIgnoreMouseEvents(clickThrough, { forward: true });
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);

  // 双击托盘图标 → 切换显示
  tray.on('double-click', () => {
    if (win.isVisible()) win.hide();
    else win.show();
  });
}

// === IPC：前端控制点击穿透 ===
// 前端在桌宠区域 mouseenter → 关闭穿透（可交互）；mouseleave → 开启穿透
ipcMain.on('pet:set-ignore-mouse', (_event, ignore) => {
  if (win && typeof ignore === 'boolean') {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

// 这里的延时是为了让 GPU 状态稳定后再创建窗口
app.whenReady().then(() => {
  backendProcess = startBackend({ app });
  setupMediaPermissions();

  // 1. 读取持久化的窗口位置/漫游开关，经 resolveStartupBounds clamp 到当前可用显示器。
  //    断屏后（saved.displayId 不存在）会自动退回主屏右下，窗口不会消失。
  const saved = loadWindowState(app.getPath('userData'));
  const startBounds = resolveStartupBounds(saved, screen.getAllDisplays(), {
    windowWidth: 300,
    windowHeight: 420,
  });
  currentDisplayId = startBounds.displayId;

  createWindow(startBounds);

  // 2. 恢复活力档位：优先 saved.vitalityMode；旧状态文件没有该字段时，
  //    若旧 roamingEnabled=true 迁移为 'roaming'，否则默认 standby。
  //    setVitalityMode 内部会按模式开/关漫游并持久化。登录前 pauseReasons 含 'auth'，
  //    即便模式为 roaming 也会被拦住，直到 renderer 验证通过后解除。
  createTray();
  const initialMode = (saved && saved.vitalityMode)
    ? saved.vitalityMode
    : (saved && saved.roamingEnabled ? 'roaming' : null);
  setVitalityMode(initialMode);

  // 3. 显示器分辨率/dpi 变化时重新 clamp，并把窗口拉回当前显示器工作区底部。
  screen.on('display-metrics-changed', () => {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const point = clampToWorkArea(bounds, screen.getDisplayMatching(bounds).workArea);
    moveWindow(point.x, point.y);
    persistWindowState();
  });
});

ipcMain.on('pet:set-roaming', (_event, enabled) => setRoaming(enabled));
ipcMain.on('pet:set-vitality-mode', (_event, name) => {
  if (typeof name === 'string') setVitalityMode(name);
});
ipcMain.on('pet:set-roaming-paused', (_event, reason, paused) => {
  if (typeof reason === 'string' && typeof paused === 'boolean') setRoamingPaused(reason, paused);
});

// Mac 上关闭窗口后保持激活；其他平台托盘已接管关闭行为
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 不直接 quit，托盘菜单的"退出"才真正退出
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  // 先持久化（保留 roamingEnabled 真值），再停止漫游和清零，否则用户开关会被丢。
  persistWindowState();
  roamingEnabled = false;
  stopRoaming();
  clearTimeout(dragResumeTimer);
  stopBackend(backendProcess);
});
