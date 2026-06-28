import { useEffect, useRef } from 'react';

const TICK_MS = 100;
const SPEECH_MS = 250;
const SILENCE_MS = 900;
const MAX_PHRASE_MS = 12_000;
// 待机时（AI 没说话）的音量阈值。
const VOLUME_THRESHOLD = 0.025;
// AI 说话时扬声器声音会回灌进麦克风，提高阈值避免回声误触发。
const VOLUME_THRESHOLD_WHEN_AI_SPEAKING = 0.06;

function recorderOptions() {
  const preferred = 'audio/webm;codecs=opus';
  if (globalThis.MediaRecorder?.isTypeSupported?.(preferred)) {
    return { mimeType: preferred };
  }
  return {};
}

function analyserVolume(analyser, buffer) {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) {
    sum += Math.abs((sample - 128) / 128);
  }
  return sum / buffer.length;
}

export function useRongrongWakeVoice({
  enabled,
  disabled,
  isAiSpeaking,
  onVoiceBlob,
  onSpeechStart,
  onStatusChange,
  onError,
  prewarmedStream,
}) {
  const callbacksRef = useRef({ onVoiceBlob, onSpeechStart, onStatusChange, onError });
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const intervalRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const emitRecordingRef = useRef(false);
  const speechStartedAtRef = useRef(0);
  const silenceStartedAtRef = useRef(0);
  const phraseStartedAtRef = useRef(0);
  const interruptedRef = useRef(false);
  const isAiSpeakingRef = useRef(isAiSpeaking);
  // 点击事件中预授权好的 stream（保留用户手势），避免 useEffect 中调用 getUserMedia 被拒
  const prewarmedStreamRef = useRef(prewarmedStream);

  useEffect(() => {
    prewarmedStreamRef.current = prewarmedStream;
  }, [prewarmedStream]);

  useEffect(() => {
    callbacksRef.current = { onVoiceBlob, onSpeechStart, onStatusChange, onError };
  }, [onVoiceBlob, onSpeechStart, onStatusChange, onError]);

  useEffect(() => {
    isAiSpeakingRef.current = isAiSpeaking;
  }, [isAiSpeaking]);

  useEffect(() => {
    const shouldRun = enabled && !disabled;
    let disposed = false;

    const setStatus = (status) => callbacksRef.current.onStatusChange?.(status);

    const stopPhrase = (emit = true) => {
      emitRecordingRef.current = emit;
      const recorder = recorderRef.current;
      if (recorder?.state === 'recording') recorder.stop();
    };

    const cleanup = () => {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      stopPhrase(false);
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      audioContextRef.current?.close?.();
      audioContextRef.current = null;
      recorderRef.current = null;
      chunksRef.current = [];
      speechStartedAtRef.current = 0;
      silenceStartedAtRef.current = 0;
      phraseStartedAtRef.current = 0;
      interruptedRef.current = false;
    };

    const startPhrase = () => {
      if (recorderRef.current?.state === 'recording' || !streamRef.current) return;

      chunksRef.current = [];
      emitRecordingRef.current = true;
      phraseStartedAtRef.current = Date.now();
      const recorder = new MediaRecorder(streamRef.current, recorderOptions());
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        recorderRef.current = null;
        if (!disposed && emitRecordingRef.current && chunks.length) {
          callbacksRef.current.onVoiceBlob?.(new Blob(chunks, { type: 'audio/webm' }));
        }
      };
      recorder.start();
      setStatus('hearing');
    };

    const start = async () => {
      if (!shouldRun || !navigator.mediaDevices?.getUserMedia) {
        setStatus('disabled');
        return;
      }

      try {
        let stream;
        const prewarmed = prewarmedStreamRef.current;
        if (prewarmed) {
          // 点击事件中预先获取的 stream（保留用户手势上下文，避免 NotAllowedError）
          console.log('🎤 使用预授权麦克风流, tracks:', prewarmed.getAudioTracks().length);
          prewarmedStreamRef.current = null; // 消费一次
          stream = prewarmed;
        } else {
          // 兜底：自行请求（可能因缺少用户手势而被拒）
          console.log('🎤 请求麦克风权限...');
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          console.log('🎤 麦克风已获得, tracks:', stream.getAudioTracks().length);
        }
        if (disposed) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        streamRef.current = stream;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioCtx();
        audioContextRef.current = audioContext;

        // 修复：Chromium 自动播放策略下 AudioContext 默认 suspended，
        // 必须显式 resume()，否则 analyser 永远返回静音。
        if (audioContext.state === 'suspended') {
          console.log('🎤 AudioContext 处于挂起状态，正在恢复...');
          await audioContext.resume();
        }
        console.log('🎤 AudioContext 状态:', audioContext.state);

        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buffer = new Uint8Array(analyser.fftSize);
        setStatus('sleeping');
        console.log('🎤 绒绒唤醒已启动，等待唤醒词... (阈值:', VOLUME_THRESHOLD, ')');

        // 调试：每 2 秒打印一次音量（避免 100ms 刷屏）
        let debugTick = 0;

        intervalRef.current = setInterval(() => {
          const now = Date.now();
          const aiSpeaking = isAiSpeakingRef.current;
          // AI 说话时提高阈值，避免自己 TTS 的回声被当成用户说话。
          const threshold = aiSpeaking ? VOLUME_THRESHOLD_WHEN_AI_SPEAKING : VOLUME_THRESHOLD;
          const vol = analyserVolume(analyser, buffer);
          const speaking = vol >= threshold;
          const recording = recorderRef.current?.state === 'recording';

          // 每秒打印一次音量用于诊断（仅在非录音状态）
          debugTick++;
          if (debugTick % 20 === 0 && !recording) {
            console.log(`🎤 音量: ${vol.toFixed(4)} | 阈值: ${threshold} | 说话: ${speaking ? '是' : '否'} | AI说话: ${aiSpeaking ? '是' : '否'}`);
          }

          if (speaking) {
            if (!speechStartedAtRef.current) {
              speechStartedAtRef.current = now;
              console.log('🎤 检测到语音开始 (vol=' + vol.toFixed(3) + ')');
            }
            silenceStartedAtRef.current = 0;

            const longEnough = now - speechStartedAtRef.current >= SPEECH_MS;
            if (longEnough && aiSpeaking && !interruptedRef.current) {
              interruptedRef.current = true;
              console.log('🎤 用户插话，打断 AI');
              callbacksRef.current.onSpeechStart?.();
            }
            if (longEnough && !recording) {
              console.log('🎤 开始录音短语');
              startPhrase();
            }
            return;
          }

          speechStartedAtRef.current = 0;
          interruptedRef.current = false;

          if (!recording) {
            setStatus('sleeping');
            return;
          }

          if (!silenceStartedAtRef.current) silenceStartedAtRef.current = now;
          const silentLongEnough = now - silenceStartedAtRef.current >= SILENCE_MS;
          const tooLong = now - phraseStartedAtRef.current >= MAX_PHRASE_MS;
          if (silentLongEnough || tooLong) {
            console.log(`🎤 短语结束 (silentEnd=${silentLongEnough}, tooLong=${tooLong}), chunks=${chunksRef.current.length}`);
            stopPhrase(true);
            setStatus('listening');
          }
        }, TICK_MS);
      } catch (err) {
        console.error('🎤 getUserMedia 失败:', err.name, err.message, err);
        cleanup();
        setStatus('disabled');
        callbacksRef.current.onError?.(err);
      }
    };

    start();
    return () => {
      disposed = true;
      cleanup();
      setStatus('disabled');
    };
  }, [enabled, disabled]);
}
