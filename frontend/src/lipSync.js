// frontend/src/lipSync.js
// 口型同步纯函数：把 AnalyserNode 的时域采样转成嘴开合量。
// 不依赖 React / Web，可被 Node 测试直接 import。

// 从 AnalyserNode 的 getByteTimeDomainData (Uint8Array, 0~255, 中点128) 算 RMS 音量。
// 返回 0~1 归一化音量。
export function rmsVolume(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = (samples[i] - 128) / 128; // -1..1
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

// 把 0~1 音量映射成 0~1 嘴开合。
// 用幂函数（0.6 次方）增强小音量，让轻声也能看到嘴动；上限钳到 1。
export function volumeToMouth(volume) {
  const clamped = Math.max(0, Math.min(1, volume));
  return Math.min(1, Math.pow(clamped, 0.6) * 1.5);
}

// 一阶低通平滑：避免嘴型逐帧抖动。alpha 越大越跟随、越小越平滑。
export function smoothMouth(prev, target, alpha = 0.35) {
  if (typeof prev !== 'number' || !Number.isFinite(prev)) prev = 0;
  return prev + (target - prev) * alpha;
}
