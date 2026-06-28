import assert from 'node:assert/strict';
import test from 'node:test';
import backendProcess from '../backendProcess.cjs';

const {
  backendEnvPath,
  backendExecutablePath,
  backendResourceDir,
  startBackend,
  stopBackend,
} = backendProcess;

test('backend paths resolve inside electron resources', () => {
  const resourceDir = backendResourceDir('C:\\Program Files\\Neuro\\resources');
  assert.equal(resourceDir, 'C:\\Program Files\\Neuro\\resources\\backend');
  assert.equal(
    backendExecutablePath(resourceDir, 'win32'),
    'C:\\Program Files\\Neuro\\resources\\backend\\neuro-backend\\neuro-backend.exe',
  );
  assert.equal(backendEnvPath(resourceDir), 'C:\\Program Files\\Neuro\\resources\\backend\\.env');
});

test('startBackend spawns packaged backend with env file and hidden window', () => {
  let spawnCall;
  const child = {
    killed: false,
    on() {},
    kill() {
      this.killed = true;
    },
  };
  const fakeFs = {
    existsSync(filePath) {
      return filePath.endsWith('neuro-backend.exe') || filePath.endsWith('.env');
    },
    openSync() {
      return 7;
    },
    closeSync() {},
  };
  const fakeApp = {
    isPackaged: true,
    getPath(name) {
      assert.equal(name, 'userData');
      return 'C:\\Users\\friend\\AppData\\Roaming\\Neuro';
    },
  };

  const result = startBackend({
    app: fakeApp,
    env: { PATH: 'test-path' },
    fsImpl: fakeFs,
    platform: 'win32',
    resourcesPath: 'C:\\Program Files\\Neuro\\resources',
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
  });

  assert.equal(result, child);
  assert.equal(spawnCall.command.endsWith('neuro-backend.exe'), true);
  assert.deepEqual(spawnCall.args, []);
  assert.equal(spawnCall.options.windowsHide, true);
  assert.equal(spawnCall.options.env.PYTHONUTF8, '1');
  assert.equal(spawnCall.options.env.PYTHONIOENCODING, 'utf-8');
  assert.equal(spawnCall.options.env.NEURO_ENV_FILE.endsWith('backend\\.env'), true);

  stopBackend(child);
  assert.equal(child.killed, true);
});

test('startBackend does nothing outside packaged app', () => {
  assert.equal(startBackend({ app: { isPackaged: false } }), null);
});
