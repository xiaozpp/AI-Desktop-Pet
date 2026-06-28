import { useState, useRef, useCallback, useEffect } from 'react';
import Live2DController from '../components/Live2D/Live2DController';
import InputArea from '../components/Chat/InputArea';
import LoadingDots from '../components/LoadingDots';
import CodeStatusBar from '../components/CodeStatusBar';
import PersonaSwitcher from '../components/PersonaSwitcher';
import Sidebar from '../components/Sidebar';
import MemoryPanel from '../components/MemoryPanel';
import { getApiBaseUrl, getWsBaseUrl } from '../apiConfig';
import { DEFAULT_PERSONA_ID, PERSONA_OPTIONS, resolvePersonaOption } from '../personas';
import '../App.css';

// 引入刚才写的 Hook
import { useAudioQueue } from '../hooks/useAudioQueue';
import { useNeuroSocket } from '../hooks/useNeuroSocket';
import { useIdleAnimations } from '../hooks/useIdleAnimations';
import { useWalkCycle } from '../hooks/useWalkCycle';
import { useLipSync } from '../hooks/useLipSync';
import { useSpeakingGesture } from '../hooks/useSpeakingGesture';
import { useThinkPose } from '../hooks/useThinkPose';
import { useRongrongWakeVoice } from '../hooks/useRongrongWakeVoice';
import { parseRongrongTranscript, wakeVoiceEnabledFromStorage } from '../rongrongVoice';

const API_BASE_URL = getApiBaseUrl();
const WS_BASE_URL = getWsBaseUrl();
const AUTH_STORAGE_KEY = 'desktop_pet_auth';
const WAKE_VOICE_STORAGE_KEY = 'rongrong_wake_voice_enabled';
const MSG_TYPE = {
  TEXT_INPUT: "text_input",
  AUDIO_INPUT: "audio_input",
  VOICE_TRANSCRIBE: "voice_transcribe",
  INTERRUPT: "interrupt",
  STATE_UPDATE: "state_update",
  AUDIO_CHUNK: "audio_chunk",
  VOICE_TRANSCRIPT: "voice_transcript",
  CANCELED: "canceled",
  ERROR: "error",
  // 阶段2/3 预留：编程状态、养成状态、养成动作
  CODE_STATUS: "code_status",
  PERSONA_STATE: "persona_state",
  PERSONA_CHANGE: "persona_change"
};

const CONNECTION_LABELS = {
  idle: '未连接',
  connecting: '连接中',
  open: '已连接',
  error: '连接异常',
  closed: '未连接',
};

const CODE_EMOTION_MAP = {
  coding: 'neutral',
  thinking: 'bored',
  idle_recent: 'happy',
  idle: 'bored'
};

// 活力档位（renderer 侧映射）。模式名（quiet/standby/roaming/lively）是与 main process 的契约，
// main 侧据名配置漫游开关/速度/停留；renderer 侧只关心 microInterval（微动作间隔）与 label。
// 与 frontend/vitalityModes.cjs 的 microInterval 保持一致。
const VITALITY_MODES = {
  quiet:   { label: '安静', microInterval: [30000, 60000] },
  standby: { label: '待机', microInterval: [8000, 20000] },
  roaming: { label: '漫游', microInterval: [8000, 20000] },
  lively:  { label: '活泼', microInterval: [4000, 10000] },
};

export default function MainPage() {
  // === UI State ===
  const [authState, setAuthState] = useState({
    status: 'checking',
    token: null,
    username: '',
  });
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ username: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [messages, setMessages] = useState([]);
  const [neuroState, setNeuroState] = useState("idle");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [codeStatus, setCodeStatus] = useState(null);  // 编程监控状态
  const [personaState, setPersonaState] = useState({
    active_persona_id: DEFAULT_PERSONA_ID,
    personas: PERSONA_OPTIONS,
  });
  const [panelOpen, setPanelOpen] = useState(false);   // 控制坞默认收起，不遮挡角色
  const [movementState, setMovementState] = useState({ phase: 'disabled', direction: 'right', speed: 0 });
  // 活力档位：默认 standby，由 main process 启动恢复后经 onVitalityMode 同步。
  const [vitalityMode, setVitalityMode] = useState('standby');
  const [wakeVoiceEnabled, setWakeVoiceEnabled] = useState(
    () => wakeVoiceEnabledFromStorage(localStorage.getItem(WAKE_VOICE_STORAGE_KEY))
  );
  const [wakeVoiceStatus, setWakeVoiceStatus] = useState('disabled');
  const [pendingVoiceTranscript, setPendingVoiceTranscript] = useState('');
  // 记忆面板：让用户查看/管理桌宠的记忆（事实 + 经历）。
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);

  const live2dRef = useRef(null);
  const fileInputRef = useRef(null);
  const voiceSessionUntilRef = useRef(0);
  // 点击时预授权麦克风的 stream，避免 useEffect 中 getUserMedia 因缺少用户手势被拒
  const wakeStreamRef = useRef(null);

  useEffect(() => {
    let canceled = false;
    const saved = localStorage.getItem(AUTH_STORAGE_KEY);

    if (!saved) {
      setAuthState({ status: 'unauthenticated', token: null, username: '' });
      return () => {
        canceled = true;
      };
    }

    const verifySavedToken = async () => {
      try {
        const parsed = JSON.parse(saved);
        if (!parsed?.token) throw new Error('missing token');

        const res = await fetch(`${API_BASE_URL}/verify`, {
          headers: { Authorization: `Bearer ${parsed.token}` },
        });
        const data = await res.json();

        if (!canceled && data.valid) {
          setAuthState({
            status: 'authenticated',
            token: parsed.token,
            username: data.username || parsed.username || '',
          });
        } else if (!canceled) {
          localStorage.removeItem(AUTH_STORAGE_KEY);
          setAuthState({ status: 'unauthenticated', token: null, username: '' });
        }
      } catch {
        if (!canceled) {
          localStorage.removeItem(AUTH_STORAGE_KEY);
          setAuthState({ status: 'unauthenticated', token: null, username: '' });
        }
      }
    };

    verifySavedToken();

    return () => {
      canceled = true;
    };
  }, []);

  // === 1. 使用音频 Hook (逻辑外包) ===
  const { subtitle, isPlaying, queueAudioChunk, stopAudio, analyserRef } = useAudioQueue(live2dRef);

  // === 1.5 程序化待机动画（眨眼/呼吸/环顾/伸懒腰），让角色活过来 ===
  const getModel = useCallback(() => live2dRef.current?.getModel?.(), []);
  // walk 与 idle 互斥：走路时关掉 idle 的呼吸/环顾，交给 walk cycle，
  // 否则两组 RAF 会同时写身体参数打架。
  const isWalking = movementState.phase === 'walking';
  const patrolMode = isWalking && !panelOpen && !sidebarOpen;
  useIdleAnimations(getModel, !isWalking, VITALITY_MODES[vitalityMode]?.microInterval);
  // 口型同步：播放 TTS 时采集音量驱动嘴型，不播放时嘴闭合。
  useLipSync(getModel, analyserRef, isPlaying);
  // 说话手势：AI 说话时手部/肩膀轻微摆动，增加表达感。
  useSpeakingGesture(getModel, isPlaying);
  // 思考表情：AI 思考时抬头、聚眉、眯眼，表现"在想"。
  useThinkPose(getModel, neuroState === 'thinking');
  useWalkCycle(getModel, movementState);

  useEffect(() => window.petAPI?.onMovementState?.(setMovementState), []);

  // main process 启动恢复或用户在托盘切换模式时，同步到 renderer（保持 UI 与实际行为一致）
  useEffect(() => window.petAPI?.onVitalityMode?.(setVitalityMode), []);

  useEffect(() => {
    window.petAPI?.setRoamingPaused?.('auth', authState.status !== 'authenticated');
  }, [authState.status]);

  // 记忆面板打开时暂停漫游（避免边走边管记忆），关闭即恢复。
  useEffect(() => {
    window.petAPI?.setRoamingPaused?.('panel-open', panelOpen || memoryPanelOpen);
  }, [panelOpen, memoryPanelOpen]);

  useEffect(() => {
    live2dRef.current?.setMovementState?.(movementState);
  }, [movementState]);

  useEffect(() => {
    window.petAPI?.setRoamingPaused?.('panel-open', panelOpen || sidebarOpen);
  }, [panelOpen, sidebarOpen]);

  useEffect(() => {
    window.petAPI?.setRoamingPaused?.('thinking', neuroState === 'thinking');
    window.petAPI?.setRoamingPaused?.('speaking', neuroState === 'speaking' || isPlaying);
  }, [neuroState, isPlaying]);

  useEffect(() => {
    const onFocus = (event) => {
      if (event.target.matches?.('input, textarea')) window.petAPI?.setRoamingPaused?.('typing', true);
    };
    const onBlur = (event) => {
      if (event.target.matches?.('input, textarea')) window.petAPI?.setRoamingPaused?.('typing', false);
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
    };
  }, []);

  // === 2. 定义收到消息的处理逻辑 ===
  const handleServerPacket = useCallback((packet) => {
    const { type, payload } = packet;

    switch (type) {
      case MSG_TYPE.STATE_UPDATE:
        setNeuroState(payload.state);
        break;
      
      case MSG_TYPE.AUDIO_CHUNK:
        setNeuroState("idle"); 
        // 收到音频，直接丢给 Hook 处理
        queueAudioChunk(payload);
        setMessages(prev => [...prev, { type: 'assistant', content: payload.text }]);
        break;

      case MSG_TYPE.VOICE_TRANSCRIPT:
        setPendingVoiceTranscript(payload.text || '');
        break;
        
      case MSG_TYPE.CANCELED:
        console.log("🛑 打断确认");
        break;
        
      case MSG_TYPE.ERROR:
        setMessages(prev => [...prev, { type: 'system', content: `❌ ${payload.info}` }]);
        setNeuroState("idle");
        break;

      case MSG_TYPE.CODE_STATUS:
        setCodeStatus(payload);
        if (neuroState === "idle" && live2dRef.current) {
          const emotion = CODE_EMOTION_MAP[payload.state];
          if (emotion) live2dRef.current.showExpression?.(emotion);
        }
        break;

      case MSG_TYPE.PERSONA_STATE:
        setPersonaState(payload);
        break;

      default:
        console.warn("未知消息:", type);
    }
  }, [queueAudioChunk, neuroState]);

  // === 3. 使用 Socket Hook (逻辑外包) ===
  const wsUrl = authState.status === 'authenticated' && authState.token
    ? `${WS_BASE_URL}?token=${encodeURIComponent(authState.token)}`
    : null;
  const { sendPacket, connectionStatus } = useNeuroSocket(wsUrl, handleServerPacket);

  // === 4. 用户交互逻辑 (保持原来的功能) ===

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    setAuthError('');

    const username = authForm.username.trim();
    const password = authForm.password;
    if (!username || !password) {
      setAuthError('请输入用户名和密码');
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.detail || '登录失败');
      }

      const nextAuth = {
        token: data.token,
        username: data.username || username,
      };
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextAuth));
      setAuthState({
        status: 'authenticated',
        token: nextAuth.token,
        username: nextAuth.username,
      });
      setAuthForm({ username: '', password: '' });
    } catch (err) {
      setAuthError(err.message || '登录失败');
    }
  };

  const handleLogout = () => {
    stopAudio();
    localStorage.removeItem(AUTH_STORAGE_KEY);
    setMessages([]);
    setPersonaState({
      active_persona_id: DEFAULT_PERSONA_ID,
      personas: PERSONA_OPTIONS,
    });
    setCodeStatus(null);
    setAuthState({ status: 'unauthenticated', token: null, username: '' });
  };
  
  // 触发打断
  const interruptNeuro = () => {
    stopAudio(); // 停止前端
    sendPacket({ type: MSG_TYPE.INTERRUPT }); // 停止后端
  };

  // 发送文本
  const handleSendMessage = (text) => {
    if (!text.trim()) return;
    if (neuroState === "speaking" || isPlaying) interruptNeuro();

    setMessages(prev => [...prev, { type: 'user', content: text }]);
    sendPacket({ 
      type: MSG_TYPE.TEXT_INPUT, 
      payload: { text } 
    });
  };

  // 语音转写结果处理（通用短句唤醒 / 持续对话窗口）。
  // 关键：每次收到转写都重新解析 + 续期窗口，保证持续对话不会中途变聋。
  useEffect(() => {
    const transcript = pendingVoiceTranscript.trim();
    if (!transcript) return;

    setPendingVoiceTranscript('');
    const result = parseRongrongTranscript(
      transcript,
      Date.now(),
      voiceSessionUntilRef.current,
    );
    voiceSessionUntilRef.current = result.activeUntil;
    if (result.woke || result.accepted) setWakeVoiceStatus('listening');
    if (!result.accepted) {
      console.log('🎤 转写视为噪声/语气词，已忽略:', JSON.stringify(transcript));
      return;
    }

    // 持续对话：若 AI 正在说话/播放，先打断再发新消息（贾维斯式插话）。
    if (neuroState === "speaking" || isPlaying) {
      stopAudio();
      sendPacket({ type: MSG_TYPE.INTERRUPT });
    }
    console.log('🎤 语音指令已接受:', JSON.stringify(result.command));
    setMessages(prev => [...prev, { type: 'user', content: result.command }]);
    sendPacket({
      type: MSG_TYPE.TEXT_INPUT,
      payload: { text: result.command },
    });
  }, [pendingVoiceTranscript, neuroState, isPlaying, sendPacket, stopAudio]);

  const sendVoiceTranscribeBlob = useCallback((audioBlob) => {
    if (!audioBlob || connectionStatus !== 'open') {
      console.warn('🎤 sendVoiceTranscribeBlob 跳过: blob=', !!audioBlob, 'conn=', connectionStatus);
      return;
    }
    console.log('🎤 发送语音转写, blob大小:', audioBlob.size, '类型:', audioBlob.type);

    const reader = new FileReader();
    reader.onload = () => {
      const base64Full = reader.result;
      const base64Data = String(base64Full).split(',')[1];
      if (!base64Data) {
        console.warn('🎤 base64 提取失败');
        return;
      }
      console.log('🎤 发送 voice_transcribe, base64长度:', base64Data.length);
      sendPacket({
        type: MSG_TYPE.VOICE_TRANSCRIBE,
        payload: {
          audio_base64: base64Data,
          format: audioBlob.type || 'audio/webm',
        },
      });
    };
    reader.readAsDataURL(audioBlob);
  }, [connectionStatus, sendPacket]);

  // 发送文件 (逻辑没变，只是复用了 sendPacket)
  const handleUpload = (file) => {
    if (!file) return;
    const mimeType = file.type;
    if (!mimeType.startsWith('audio/') && !mimeType.startsWith('image/')) {
      setMessages(prev => [...prev, { type: 'system', content: '目前仅支持图片和音频' }]);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessages(prev => [...prev, { type: 'system', content: '文件不能超过 5 MB' }]);
      return;
    }
    interruptNeuro();

    const reader = new FileReader();
    reader.onload = () => {
      const base64Full = reader.result;
      const base64Data = base64Full.split(',')[1];
      let msgType = MSG_TYPE.TEXT_INPUT;
      let payload = {};

      if (mimeType.startsWith('audio/')) {
        msgType = MSG_TYPE.AUDIO_INPUT;
        payload = { audio_base64: base64Data, format: mimeType };
      } else if (mimeType.startsWith('image/')) {
        payload = {
          text: `[上传了图片: ${file.name}]`,
          image_base64: base64Data,
          image_mime: mimeType,
        };
      }

      setMessages(prev => [...prev, { type: 'user', content: `已上传 ${file.name}` }]);
      sendPacket({ type: msgType, payload });
    };
    reader.readAsDataURL(file);
  };

  const handlePersonaChange = (personaId) => {
    setPersonaState(prev => ({
      ...(prev || {}),
      active_persona_id: personaId,
      personas: prev?.personas?.length ? prev.personas : PERSONA_OPTIONS,
    }));
    sendPacket({
      type: MSG_TYPE.PERSONA_CHANGE,
      payload: { persona_id: personaId },
    });
  };

  const handleRecordingChange = useCallback((recording) => {
    window.petAPI?.setRoamingPaused?.('recording', recording);
  }, []);

  // 切换活力档位：本地立即更新 UI 与 idle 间隔，并通知 main process 应用到漫游行为。
  const handleVitalityChange = useCallback((mode) => {
    if (!VITALITY_MODES[mode]) return;
    setVitalityMode(mode);
    window.petAPI?.setVitalityMode?.(mode);
  }, []);

  const handleWakeVoiceToggle = useCallback(async () => {
    // 用 ref 读到当前最新值（避免闭包陈旧引用）
    const currentlyEnabled = wakeVoiceEnabled;
    const next = !currentlyEnabled;

    if (next) {
      // ✅ 在用户点击事件内直接获取麦克风（保留 transient activation），
      //    避免 useEffect 中调用 getUserMedia 被 Electron/Chromium 拒绝。
      try {
        console.log('🎤 点击开启唤醒，在用户手势内请求麦克风...');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        console.log('🎤 预授权成功, tracks:', stream.getAudioTracks().length);
        wakeStreamRef.current = stream;
        setWakeVoiceEnabled(true);
      } catch (err) {
        console.error('🎤 预授权失败:', err.name, err.message);
        // 直接走 hook 的 onError 逻辑（但 hook 还未启动，手动弹窗）
        const errName = err?.name || 'UnknownError';
        const info = errName === 'NotAllowedError'
          ? `麦克风权限被拒绝 (${err.message || ''})。请在 Windows 设置 → 隐私 → 麦克风 → 允许桌面应用访问麦克风，然后重新点击麦克风按钮。`
          : `麦克风不可用 (${errName})，请确认电脑有可用输入设备。`;
        window.alert(info);
        setWakeVoiceEnabled(false);
      }
    } else {
      // 关闭：清掉预授权的 stream
      if (wakeStreamRef.current) {
        wakeStreamRef.current.getTracks().forEach(t => t.stop());
        wakeStreamRef.current = null;
      }
      voiceSessionUntilRef.current = 0;
      setWakeVoiceStatus('disabled');
      setWakeVoiceEnabled(false);
    }
  }, [wakeVoiceEnabled]);

  useEffect(() => {
    localStorage.setItem(WAKE_VOICE_STORAGE_KEY, wakeVoiceEnabled ? 'true' : 'false');
  }, [wakeVoiceEnabled]);

  useRongrongWakeVoice({
    enabled: wakeVoiceEnabled,
    disabled: connectionStatus !== 'open' || authState.status !== 'authenticated',
    isAiSpeaking: neuroState === "speaking" || isPlaying,
    prewarmedStream: wakeStreamRef.current,
    onVoiceBlob: sendVoiceTranscribeBlob,
    onSpeechStart: interruptNeuro,
    onStatusChange: (status) => {
      if (wakeVoiceEnabled) setWakeVoiceStatus(status);
    },
    onError: (err) => {
      setWakeVoiceEnabled(false);
      const errName = err?.name || 'UnknownError';
      const errMsg = err?.message || '';
      console.error('🎤 语音唤醒错误:', errName, errMsg, err);
      const info = errName === 'NotAllowedError'
        ? `麦克风权限被拒绝 (${errMsg})。请在 Windows 设置 → 隐私 → 麦克风 → 允许桌面应用访问麦克风，然后重新点击麦克风按钮。`
        : `麦克风不可用 (${errName}: ${errMsg})，请确认电脑有可用输入设备。`;
      window.alert(info);
      setMessages(prev => [...prev, { type: 'system', content: `${info} 语音唤醒已关闭。` }]);
    },
  });

  if (authState.status !== 'authenticated') {
    const isChecking = authState.status === 'checking';
    return (
      <div className="app auth-app">
        <div className="auth-panel">
          <div className="auth-title">Neuro 桌宠</div>
          <div className="auth-subtitle">
            {isChecking ? '正在确认身份...' : '登录后同步你的长期记忆和角色偏好'}
          </div>

          {!isChecking && (
            <form className="auth-form" onSubmit={handleAuthSubmit}>
              <input
                className="auth-input"
                value={authForm.username}
                onChange={(e) => setAuthForm(prev => ({ ...prev, username: e.target.value }))}
                placeholder="用户名"
                autoComplete="username"
              />
              <input
                className="auth-input"
                type="password"
                value={authForm.password}
                onChange={(e) => setAuthForm(prev => ({ ...prev, password: e.target.value }))}
                placeholder="密码"
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
              />

              {authError && <div className="auth-error">{authError}</div>}

              <button className="auth-submit" type="submit">
                {authMode === 'login' ? '登录' : '注册'}
              </button>
              <button
                className="auth-switch"
                type="button"
                onClick={() => {
                  setAuthError('');
                  setAuthMode(mode => mode === 'login' ? 'register' : 'login');
                }}
              >
                {authMode === 'login' ? '没有账号？注册一个' : '已有账号？去登录'}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // === 5. 渲染 UI ===
  // 注意：不加 onMouseEnter/Leave 穿透切换 —— 那会导致拖动失效（mouseleave 时窗口变穿透，
  // drag 区域收不到鼠标事件）。窗口默认不穿透，整个 .app 区域可拖（app-region:drag），
  // 需要穿透时用托盘菜单手动开。
  const activePersona = resolvePersonaOption(personaState.active_persona_id);

  return (
    <div className={`app ${patrolMode ? 'patrol-mode' : ''}`}>
      {/* 拖动条：窗口顶部细条（视觉提示，实际整个 app 都能拖） */}
      <div className="drag-handle" title="按住任意空白处拖动窗口" />
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        messages={messages}
      />

      <div className={`control-dock-wrap ${panelOpen ? 'open' : 'collapsed'}`}>
        <button
          className="control-dock-toggle"
          onClick={() => setPanelOpen(o => !o)}
          title={panelOpen ? '收起控制坞' : '展开控制坞'}
        >
          <span className={`connection-dot ${connectionStatus}`} />
          <span className="control-dock-label">{activePersona.title}</span>
          <span className="control-dock-chevron">{panelOpen ? '×' : '›'}</span>
        </button>
        {panelOpen && (
          <div className="control-dock">
            <div className="control-dock-header">
              <span className="session-user">{authState.username || 'Neuro'}</span>
              <span className={`socket-state ${connectionStatus}`}>
                {CONNECTION_LABELS[connectionStatus] || '未连接'}
              </span>
            </div>
            <PersonaSwitcher
              personaState={personaState}
              onChange={handlePersonaChange}
              disabled={connectionStatus !== 'open'}
            />
            <div className="vitality-switcher" role="group" aria-label="活力档位">
              {Object.entries(VITALITY_MODES).map(([id, { label }]) => (
                <button
                  key={id}
                  type="button"
                  className={`vitality-btn ${vitalityMode === id ? 'active' : ''}`}
                  onClick={() => handleVitalityChange(id)}
                  title={`活力档位：${label}`}
                  aria-pressed={vitalityMode === id}
                >
                  {label}
                </button>
              ))}
            </div>
            <CodeStatusBar codeStatus={codeStatus} />
            <div className="control-dock-actions">
              <button
                className="history-toggle"
                onClick={() => setSidebarOpen(true)}
                title="查看本次对话"
              >
                本次对话 ({messages.length})
              </button>
              <button
                className="memory-toggle"
                onClick={() => setMemoryPanelOpen(true)}
                title="查看 Neuro 的记忆"
              >
                🧠 记忆
              </button>
              <button className="session-logout" onClick={handleLogout}>退出</button>
            </div>
          </div>
        )}
      </div>

      {memoryPanelOpen && (
        <MemoryPanel onClose={() => setMemoryPanelOpen(false)} />
      )}

      <div className="live2d-main">
        <Live2DController ref={live2dRef} />
        
        {/* 字幕区域 */}
        <div className="subtitles">
          {neuroState === "thinking" ? (
             <div className="status-indicator">
               <LoadingDots /> <span style={{marginLeft:8}}>让我想想</span>
             </div>
          ) : (
             subtitle && <div className="subtitle-text">{subtitle}</div>
          )}
        </div>
      </div>

      <InputArea
        onSendMessage={handleSendMessage}
        onRecordStart={interruptNeuro}
        onRecordingChange={handleRecordingChange}
        fileInputRef={fileInputRef}
        onFileUpload={handleUpload}
        disabled={connectionStatus !== 'open'}
        isAiSpeaking={neuroState === "speaking" || isPlaying}
        wakeEnabled={wakeVoiceEnabled}
        voiceStatus={wakeVoiceStatus}
        onWakeToggle={handleWakeVoiceToggle}
      />
    </div>
  );
}
