import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getBackendUrl } from './apiConfig.js';

const mainPageSource = readFileSync(new URL('./pages/MainPage.jsx', import.meta.url), 'utf8');
const memoryPanelSource = readFileSync(new URL('./components/MemoryPanel.jsx', import.meta.url), 'utf8');
const apiConfigSource = readFileSync(new URL('./apiConfig.js', import.meta.url), 'utf8');

test('apiConfig centralizes backend url and defaults to the local packaged backend', () => {
  // apiConfig.js 存在且导出统一接口
  assert.equal(apiConfigSource.includes('export function getApiBaseUrl'), true);
  assert.equal(apiConfigSource.includes('export function getWsBaseUrl'), true);
  assert.equal(apiConfigSource.includes('export function getBackendUrl'), true);
  assert.equal(apiConfigSource.includes('export function setBackendUrl'), true);
  // WebSocket 基址自动 http→ws 转换（让 https 后端自动走 wss）
  assert.equal(apiConfigSource.includes("replace(/^http/, 'ws')"), true);
  // 本地后端是打包版和开发版的默认值；WebSocket 地址仍由 http 自动转换。
  assert.equal(apiConfigSource.includes("'http://127.0.0.1:8000'"), true); // DEV_DEFAULT 允许
  assert.equal(apiConfigSource.includes("'ws://127.0.0.1:8000/ws'"), false);
});

test('packaged file pages ignore a stale remote backend override', () => {
  const originalLocation = globalThis.location;
  const originalLocalStorage = globalThis.localStorage;
  globalThis.location = { protocol: 'file:' };
  globalThis.localStorage = { getItem: () => 'https://www.aipanni.com' };

  try {
    assert.equal(getBackendUrl(), 'http://127.0.0.1:8000');
  } finally {
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});

test('MainPage and MemoryPanel use apiConfig instead of hardcoded localhost', () => {
  assert.equal(mainPageSource.includes("from '../apiConfig'"), true);
  assert.equal(mainPageSource.includes('getApiBaseUrl()'), true);
  assert.equal(mainPageSource.includes('getWsBaseUrl()'), true);
  assert.equal(memoryPanelSource.includes("from '../apiConfig'"), true);
  assert.equal(memoryPanelSource.includes('getApiBaseUrl()'), true);
  // 不应再有硬编码的 localhost（除了注释里的说明）
  assert.equal(mainPageSource.includes("'http://127.0.0.1:8000'"), false);
  assert.equal(mainPageSource.includes("'ws://127.0.0.1:8000/ws'"), false);
  assert.equal(memoryPanelSource.includes("'http://127.0.0.1:8000'"), false);
});

test('packaged exe no longer asks friends for a backend url on first launch', () => {
  assert.equal(apiConfigSource.includes('neuro_backend_url'), true);
  assert.equal(mainPageSource.includes('backendConfigured'), false);
  assert.equal(mainPageSource.includes('handleSaveBackendUrl'), false);
  assert.equal(mainPageSource.includes('backendUrlInput'), false);
  assert.equal(mainPageSource.includes('填写 Neuro 后端地址'), false);
  assert.equal(mainPageSource.includes('window.location.reload()'), false);
});
