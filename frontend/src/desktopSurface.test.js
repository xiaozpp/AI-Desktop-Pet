import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainPageSource = readFileSync(new URL('./pages/MainPage.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('./components/Sidebar.jsx', import.meta.url), 'utf8');
const inputAreaSource = readFileSync(new URL('./components/Chat/InputArea.jsx', import.meta.url), 'utf8');
const appCssSource = readFileSync(new URL('./App.css', import.meta.url), 'utf8');
const memoryPanelSource = readFileSync(new URL('./components/MemoryPanel.jsx', import.meta.url), 'utf8');
const live2dModelSource = readFileSync(new URL('./components/Live2D/Live2DModel.jsx', import.meta.url), 'utf8');

test('packaged app loads the Live2D model relative to dist/index.html', () => {
  assert.equal(live2dModelSource.includes("Live2DModel.from('./models/PinkFox/PinkFox.model3.json')"), true);
  assert.equal(live2dModelSource.includes("Live2DModel.from('/models/PinkFox/PinkFox.model3.json')"), false);
});

test('desktop surface does not expose fake pet mechanics', () => {
  const forbiddenSurfaceTerms = [
    'PetStatusBar',
    'PET_STATE',
    'pet_state',
    'PET_ACTION',
    'handlePetAction',
    '喂食',
    '玩耍',
  ];

  for (const term of forbiddenSurfaceTerms) {
    assert.equal(
      mainPageSource.includes(term),
      false,
      `MainPage should not expose fake mechanic: ${term}`,
    );
  }
});

test('upload control only advertises supported media', () => {
  assert.equal(inputAreaSource.includes('image/*,audio/*'), true);
  for (const fakeType of ['.pdf', '.doc', '.docx', '\u4e0a\u4f20\u6587\u6863']) {
    assert.equal(inputAreaSource.includes(fakeType), false);
  }
  assert.equal(mainPageSource.includes('[\u4e0a\u4f20\u4e86\u6587\u4ef6:'), false);
  assert.equal(mainPageSource.includes('image_mime: mimeType'), true);
  assert.equal(mainPageSource.includes('file.size > 5 * 1024 * 1024'), true);
});

test('desktop surface keeps the real product controls', () => {
  assert.equal(mainPageSource.includes('PersonaSwitcher'), true);
  assert.equal(mainPageSource.includes('CodeStatusBar'), true);
  assert.equal(mainPageSource.includes('\u672c\u6b21\u5bf9\u8bdd'), true);
  assert.equal(sidebarSource.includes('\u672c\u6b21\u5bf9\u8bdd'), true);
  assert.equal(`${mainPageSource}${sidebarSource}`.includes('\u804a\u5929\u8bb0\u5f55'), false);
  for (const label of ['\u5df2\u8fde\u63a5', '\u8fde\u63a5\u4e2d', '\u672a\u8fde\u63a5']) {
    assert.equal(mainPageSource.includes(label), true);
  }
  assert.equal(mainPageSource.includes('>{connectionStatus}<'), false);
  assert.equal(mainPageSource.includes('/verify?token='), false);
  assert.equal(mainPageSource.includes('Authorization: `Bearer ${parsed.token}`'), true);
});

test('wake voice microphone failures are visible to the user', () => {
  assert.equal(mainPageSource.includes('window.alert'), true);
  assert.equal(mainPageSource.includes('麦克风不可用'), true);
});

test('desktop patrol mode hides controls while the character is walking', () => {
  assert.equal(mainPageSource.includes("patrolMode = isWalking && !panelOpen && !sidebarOpen"), true);
  assert.equal(mainPageSource.includes("patrol-mode"), true);
  assert.equal(appCssSource.includes('.app.patrol-mode .live2d-main'), true);
  assert.equal(appCssSource.includes('.app.patrol-mode .chat-input-container'), true);
});

test('vitality mode switcher uses the contracted mode names and stays clear of pet-mechanic terms', () => {
  // 活力档位切换器存在
  assert.equal(mainPageSource.includes('VITALITY_MODES'), true);
  assert.equal(mainPageSource.includes('vitality-switcher'), true);
  assert.equal(mainPageSource.includes('handleVitalityChange'), true);
  assert.equal(appCssSource.includes('.vitality-btn'), true);
  // 四个模式名是跨层契约，必须都在
  for (const name of ['quiet', 'standby', 'roaming', 'lively']) {
    assert.equal(mainPageSource.includes(`${name}:`), true, `MainPage 应包含模式名 ${name}`);
  }
  // 活力档位是行为预设，不能引入养成数值/喂食/金币等虚假玩法（AGENTS.md 第 9 条）
  for (const forbidden of ['pet_state', 'PET_STATE', 'PetStatusBar', '喂食', '玩耍', '金币', '饥饿', '经验值']) {
    assert.equal(mainPageSource.includes(forbidden), false, `活力模式不应出现养成词：${forbidden}`);
  }
});

test('memory panel is wired into the control dock and pauses roaming while open', () => {
  // MainPage 引入并挂载 MemoryPanel
  assert.equal(mainPageSource.includes("import MemoryPanel from '../components/MemoryPanel'"), true);
  assert.equal(mainPageSource.includes('memoryPanelOpen'), true);
  assert.equal(mainPageSource.includes('<MemoryPanel'), true);
  // 控制坞有记忆入口按钮
  assert.equal(mainPageSource.includes('memory-toggle'), true);
  assert.equal(mainPageSource.includes('🧠 记忆'), true);
  // 面板打开时暂停漫游（与控制坞展开共用 panel-open 暂停原因）
  assert.equal(mainPageSource.includes("panelOpen || memoryPanelOpen"), true);
});

test('memory panel calls backend memory API with token auth and guards destructive ops', () => {
  // 调用后端契约路由（与 backend/main.py 一致）
  assert.equal(memoryPanelSource.includes('/memory/facts'), true);
  assert.equal(memoryPanelSource.includes('/memory/episodes'), true);
  assert.equal(memoryPanelSource.includes('/memory/episodes/'), true);
  assert.equal(memoryPanelSource.includes('/memory/export'), true);
  assert.equal(memoryPanelSource.includes('/memory/all?confirm=yes'), true);
  // 带 token 鉴权（从 localStorage 取，与 MainPage 一致）
  assert.equal(memoryPanelSource.includes('Authorization: `Bearer'), true);
  assert.equal(memoryPanelSource.includes('desktop_pet_auth'), true);
  // 删除单条有二次确认（防误触）
  assert.equal(memoryPanelSource.includes("window.confirm"), true);
  // 清空全部有二次确认按钮态（confirmClear）
  assert.equal(memoryPanelSource.includes('confirmClear'), true);
  assert.equal(memoryPanelSource.includes('再次点击确认清空'), true);
  // 不接受外部传入的任意文件名/路径（onClose 是唯一外部控制）
  assert.equal(memoryPanelSource.includes('window.prompt'), false);
});
