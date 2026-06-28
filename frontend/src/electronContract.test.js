import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const electronSource = readFileSync(new URL('../electron-main.cjs', import.meta.url), 'utf8');
const viteSource = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
const backendProcessSource = readFileSync(new URL('../backendProcess.cjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('packaged Electron app does not depend on the Vite dev server', () => {
  assert.equal(electronSource.includes('app.isPackaged'), true);
  assert.equal(electronSource.includes("win.loadFile(path.join(__dirname, 'dist', 'index.html'))"), true);
  assert.equal(viteSource.includes("base: './'"), true);
});

test('Electron renderer runs in a sandbox', () => {
  assert.equal(electronSource.includes('sandbox: true'), true);
  assert.equal(electronSource.includes('contextIsolation: true'), true);
  assert.equal(electronSource.includes('nodeIntegration: false'), true);
  assert.equal(electronSource.includes('OutOfBlinkCors'), false);
  assert.equal(electronSource.includes("typeof ignore === 'boolean'"), true);
});

test('Electron explicitly allows microphone permission only for app pages', () => {
  assert.equal(electronSource.includes('setPermissionRequestHandler'), true);
  assert.equal(electronSource.includes("permission === 'media'"), true);
  assert.equal(electronSource.includes('requestingOrigin.startsWith'), true);
  assert.equal(electronSource.includes("callback(permission === 'media' && isAllowedAppOrigin"), true);
});

test('desktop roaming stays in the main process behind a narrow IPC bridge', () => {
  assert.equal(electronSource.includes('screen.getDisplayMatching(bounds).workArea'), true);
  assert.equal(electronSource.includes('win.setPosition(Math.round(x), Math.round(y))'), true);
  // 活力档位从持久态恢复：优先 saved.vitalityMode，旧状态文件回退迁移为 'roaming' 或默认 standby
  assert.equal(electronSource.includes('setVitalityMode(initialMode)'), true);
  assert.equal(electronSource.includes('saved.vitalityMode'), true);
  assert.equal(electronSource.includes("saved.roamingEnabled ? 'roaming' : null"), true);
  assert.equal(electronSource.includes("new Set(['auth'])"), true);
  assert.equal(electronSource.includes("label: '桌面漫游'"), true);
  assert.equal(electronSource.includes('clearInterval(roamingTimer)'), true);
  assert.equal(electronSource.includes("setRoamingPaused('user-dragging', true)"), true);
  assert.equal(preloadSource.includes("'pet:set-roaming-paused'"), true);
  assert.equal(preloadSource.includes('setRoamingPaused:'), true);
  assert.equal(preloadSource.includes('setVitalityMode:'), true);
  assert.equal(preloadSource.includes('onMovementState:'), true);
  assert.equal(preloadSource.includes('onVitalityMode:'), true);
  assert.equal(preloadSource.includes('removeListener'), true);
  assert.equal(preloadSource.includes("ipcRenderer.send('pet:set-roaming'"), true);
  assert.equal(preloadSource.includes("ipcRenderer.send('pet:set-roaming-paused'"), true);
  assert.equal(preloadSource.includes("ipcRenderer.send('pet:set-vitality-mode'"), true);
  assert.equal(preloadSource.includes('ipcRenderer,'), false);
});

test('desktop shell has product metadata instead of Vite defaults', () => {
  assert.equal(indexSource.includes('<html lang="zh-CN">'), true);
  assert.equal(indexSource.includes('<title>Neuro</title>'), true);
  assert.equal(indexSource.includes('vite.svg'), false);
  assert.equal(electronSource.includes("tray.setToolTip('Neuro')"), true);
  assert.equal(electronSource.includes("'models', 'PinkFox', 'icon.png'"), true);
  assert.equal(electronSource.includes("'build', 'icon.ico'"), false);
  assert.equal(electronSource.includes('icon: getIconPath()'), true);
});

test('packaged app bundles and starts the local Python backend', () => {
  assert.equal(electronSource.includes("require('./backendProcess.cjs')"), true);
  assert.equal(electronSource.includes('backendProcess = startBackend({ app })'), true);
  assert.equal(electronSource.includes('stopBackend(backendProcess)'), true);
  assert.equal(backendProcessSource.includes("path.join(resourcesPath, 'backend')"), true);
  assert.equal(backendProcessSource.includes('NEURO_ENV_FILE'), true);
  assert.equal(backendProcessSource.includes('windowsHide: true'), true);
  assert.equal(backendProcessSource.includes("'backend.log'"), true);
  assert.equal(packageJson.scripts['backend:dist'].includes('build-backend.ps1'), true);
  assert.equal(packageJson.scripts.dist.startsWith('npm run backend:dist &&'), true);
  assert.deepEqual(packageJson.build.extraResources[0].from, 'build/backend');
});
