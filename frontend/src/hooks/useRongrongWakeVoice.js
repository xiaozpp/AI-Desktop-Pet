import { useEffect, useRef } from 'react';

const TICK_MS = 100;
const SPEECH_MS = 250;
const SILENCE_MS = 900;
const MAX_PHRASE_MS = 12_000;
const VOLUME_THRESHOLD = 0.025;

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
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (disposed) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        streamRef.current = stream;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioCtx();
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buffer = new Uint8Array(analyser.fftSize);
        setStatus('sleeping');

        intervalRef.current = setInterval(() => {
          const now = Date.now();
          const speaking = analyserVolume(analyser, buffer) >= VOLUME_THRESHOLD;
          const recording = recorderRef.current?.state === 'recording';

          if (speaking) {
            if (!speechStartedAtRef.current) speechStartedAtRef.current = now;
            silenceStartedAtRef.current = 0;

            const longEnough = now - speechStartedAtRef.current >= SPEECH_MS;
            if (longEnough && isAiSpeakingRef.current && !interruptedRef.current) {
              interruptedRef.current = true;
              callbacksRef.current.onSpeechStart?.();
            }
            if (longEnough && !recording) startPhrase();
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
            stopPhrase(true);
            setStatus('listening');
          }
        }, TICK_MS);
      } catch (err) {
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
