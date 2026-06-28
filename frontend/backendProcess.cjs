const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function backendResourceDir(resourcesPath = process.resourcesPath) {
  return path.join(resourcesPath, 'backend');
}

function backendExecutablePath(resourceDir, platform = process.platform) {
  return path.join(resourceDir, 'neuro-backend', platform === 'win32' ? 'neuro-backend.exe' : 'neuro-backend');
}

function backendEnvPath(resourceDir) {
  return path.join(resourceDir, '.env');
}

function startBackend({
  app,
  env = process.env,
  fsImpl = fs,
  logger = console,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  spawnImpl = spawn,
} = {}) {
  if (!app || !app.isPackaged) return null;

  const resourceDir = backendResourceDir(resourcesPath);
  const exePath = backendExecutablePath(resourceDir, platform);
  if (!fsImpl.existsSync(exePath)) {
    logger.warn(`Packaged backend missing: ${exePath}`);
    return null;
  }

  const childEnv = { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  const envPath = backendEnvPath(resourceDir);
  if (fsImpl.existsSync(envPath)) childEnv.NEURO_ENV_FILE = envPath;

  const logPath = path.join(app.getPath('userData'), 'backend.log');
  const logFd = fsImpl.openSync(logPath, 'a');
  const child = spawnImpl(exePath, [], {
    cwd: path.dirname(exePath),
    env: childEnv,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });

  child.on?.('exit', () => {
    try {
      fsImpl.closeSync?.(logFd);
    } catch {
      // log fd cleanup is best-effort on shutdown
    }
  });

  return child;
}

function stopBackend(child) {
  if (child && !child.killed) child.kill();
}

module.exports = {
  backendEnvPath,
  backendExecutablePath,
  backendResourceDir,
  startBackend,
  stopBackend,
};
