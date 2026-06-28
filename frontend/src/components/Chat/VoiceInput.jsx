import { useState, useRef, useEffect, useCallback } from 'react';

export default function VoiceInput({
  onAudioCaptured,
  onRecordStart,
  onRecordingChange,
  disabled,
  wakeEnabled,
  voiceStatus,
  onWakeToggle,
}) {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      onRecordStart?.();

      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        onAudioCaptured(audioBlob);
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      };

      mediaRecorder.start();
      setIsRecording(true);
      onRecordingChange?.(true);
    } catch (err) {
      console.error('无法启动麦克风:', err);
      alert('请允许麦克风权限，或检查麦克风设置');
    }
  }, [onAudioCaptured, onRecordStart, onRecordingChange]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      onRecordingChange?.(false);
    }
  }, [isRecording, onRecordingChange]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      onRecordingChange?.(false);
    };
  }, [onRecordingChange]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.repeat) return;
      if (e.key === 'F2' && !isRecording && !disabled) {
        startRecording();
      }
    };

    const handleKeyUp = (e) => {
      if (e.key === 'F2' && isRecording) {
        stopRecording();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [disabled, isRecording, startRecording, stopRecording]);

  const handleClick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      onWakeToggle?.();
    }
  };

  const wakeActive = wakeEnabled && !isRecording;
  const hearing = wakeActive && voiceStatus === 'hearing';
  const sleeping = wakeActive && voiceStatus === 'sleeping';
  const title = isRecording
    ? '点击停止'
    : wakeActive
      ? '绒绒正在待机，点击关闭麦克风'
      : '麦克风已关闭，点击恢复绒绒唤醒';

  return (
    <button
      className={`icon-button ${isRecording || hearing ? 'recording' : ''}`}
      onClick={handleClick}
      disabled={disabled}
      title={title}
      style={{
        backgroundColor: isRecording || hearing ? '#ff4d4f' : sleeping ? '#3b82f6' : 'transparent',
        color: isRecording || hearing || sleeping ? 'white' : 'inherit',
        border: isRecording || hearing || sleeping ? 'none' : '1px solid #ccc',
        transition: 'all 0.2s',
        minWidth: '40px',
        cursor: disabled ? 'not-allowed' : 'pointer'
      }}
    >
      {isRecording ? '⏹' : wakeActive ? '🎙' : '🎤'}
    </button>
  );
}
