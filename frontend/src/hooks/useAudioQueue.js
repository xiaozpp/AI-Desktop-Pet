import { useState, useRef, useCallback } from 'react';

// 模块级复用单个 AudioContext（Electron renderer sandbox 下可用）。
// 首次用户交互后创建；失败则降级到无口型的普通 Audio 播放。
let sharedAudioCtx = null;
function getAudioContext() {
  if (sharedAudioCtx) return sharedAudioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sharedAudioCtx = new Ctx();
    return sharedAudioCtx;
  } catch (err) {
    console.warn('AudioContext 不可用，口型同步降级关闭:', err);
    return null;
  }
}

export function useAudioQueue(live2dRef) {
  const [subtitle, setSubtitle] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const currentAudioRef = useRef(null);
  const currentAudioCleanupRef = useRef(null);
  // analyser 暴露给口型同步 hook 读取实时音量。
  const analyserRef = useRef(null);

  // === 内部工具：播放 Base64 音频（经 WebAudio，便于采样音量驱动口型）===
  // mimeType: 后端告知的音频格式（如 audio/ogg）；缺省时用 audio/mpeg 兼容旧逻辑。
  const playAudioBlob = (base64Data, mimeType = 'audio/mpeg') => {
    return new Promise((resolve, reject) => {
      try {
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: mimeType });
        const url = URL.createObjectURL(blob);

        const audio = new Audio(url);
        currentAudioRef.current = audio;

        const ctx = getAudioContext();
        let sourceNode = null;
        let analyser = null;
        if (ctx) {
          try {
            // AudioContext 可能因自动播放策略处于 suspended，播放前恢复。
            if (ctx.state === 'suspended') ctx.resume();
            sourceNode = ctx.createMediaElementSource(audio);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.6;
            sourceNode.connect(analyser);
            analyser.connect(ctx.destination);
            analyserRef.current = analyser;
          } catch (err) {
            // MediaElementSource 创建失败（例如同一元素已连过）则降级直连播放。
            console.warn('WebAudio 图构建失败，降级播放:', err);
            try { sourceNode && sourceNode.connect(ctx.destination); } catch { /* ignore */ }
          }
        }

        const cleanup = () => {
          URL.revokeObjectURL(url);
          if (currentAudioRef.current === audio) currentAudioRef.current = null;
          if (currentAudioCleanupRef.current === finishPlayback) {
            currentAudioCleanupRef.current = null;
          }
          if (analyserRef.current === analyser) analyserRef.current = null;
          // 断开 WebAudio 节点，避免图累积。
          try { sourceNode && sourceNode.disconnect(); } catch { /* ignore */ }
          try { analyser && analyser.disconnect(); } catch { /* ignore */ }
        };
        const finishPlayback = () => {
          cleanup();
          resolve();
        };
        currentAudioCleanupRef.current = finishPlayback;

        audio.onended = () => {
          cleanup();
          resolve();
        };

        audio.onerror = (e) => {
          cleanup();
          reject(e);
        };

        audio.play().catch(finishPlayback);
      } catch (e) {
        reject(e);
      }
    });
  };

  // === 内部逻辑：处理队列 ===
  const processQueue = useCallback(async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;

    isPlayingRef.current = true;
    setIsPlaying(true);
    const item = audioQueueRef.current.shift();

    try {
      // 1. 设置表情
      if (item.expression && live2dRef.current) {
        live2dRef.current.showExpression(item.expression);
      }
      // 2. 设置字幕
      setSubtitle(item.text);

      // 3. 播放音频或模拟阅读
      if (item.audio_base64) {
        await playAudioBlob(item.audio_base64, item.audio_format || 'audio/ogg');
      } else {
        await new Promise(r => setTimeout(r, 1000 + item.text.length * 100));
      }
    } catch (err) {
      console.error("播放错误:", err);
    } finally {
      isPlayingRef.current = false;
      setIsPlaying(false);
      // 递归消费
      if (audioQueueRef.current.length > 0) {
        processQueue();
      } else {
        // 全部播完
        setSubtitle("");
        if (live2dRef.current) live2dRef.current.resetExpression();
      }
    }
  }, [live2dRef]);

  // === 对外暴露：添加任务 ===
  const queueAudioChunk = useCallback((chunk) => {
    audioQueueRef.current.push(chunk);
    processQueue();
  }, [processQueue]);

  // === 对外暴露：打断 ===
  const stopAudio = useCallback(() => {
    audioQueueRef.current = [];
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
    }
    currentAudioCleanupRef.current?.();
    currentAudioRef.current = null;
    analyserRef.current = null;
    isPlayingRef.current = false;
    setIsPlaying(false);
    setSubtitle("");
    if (live2dRef.current) live2dRef.current.resetExpression();
  }, [live2dRef]);

  return {
    subtitle,
    isPlaying,
    queueAudioChunk,
    stopAudio,
    analyserRef
  };
}
