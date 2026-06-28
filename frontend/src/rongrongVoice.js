// 通用短句唤醒（贾维斯模式）：不再依赖固定唤醒词。
// 检测到任意有意义的中文短句（≥2 字，非纯语气/否定词）即触发对话，
// 触发后进入 60 秒持续对话窗口，窗口内每次有效对话都续期。
// 这样 STT 即使把"绒绒你好"识别成"你好"也能正常响应。

export const RONGRONG_WAKE_WORD = '';
// 唤醒后会话窗口：60 秒。每次有效对话会续期，持续对话不会突然变聋。
export const RONGRONG_SESSION_MS = 60_000;

// 这些转写视为无意义噪声/语气，不触发对话。
// STT 在静音段常返回这类词，需要过滤避免误触发。
const NOISE_WORDS = new Set([
  '', '嗯', '啊', '哦', '噢', '呃', '唉', '嗨', '哈', '呵',
  '不', '是', '对', '好', '行', '哎', '嘿',
]);

// 判断是否为有意义的对话内容：至少 2 个字，且不是纯语气/否定单字。
function isMeaningful(transcript) {
  const t = transcript.replace(/[\s,，。.!！?？:：;；\-、~～]+/g, '').trim();
  if (t.length < 2) return false;
  // 去标点后若是已知噪声词（含重复如"嗯嗯"），也过滤。
  if (NOISE_WORDS.has(t)) return false;
  // 重复单字噪声：如"啊啊"、"嗯嗯"、"哦哦"
  if (t.length <= 3 && NOISE_WORDS.has(t[0]) && t.split('').every(c => c === t[0])) return false;
  return true;
}

export function wakeVoiceEnabledFromStorage(value) {
  return value !== 'false';
}

export function parseRongrongTranscript(text, nowMs = Date.now(), activeUntilMs = 0) {
  const transcript = String(text || '').trim();
  const inSession = nowMs < activeUntilMs;
  const meaningful = isMeaningful(transcript);

  // 通用短句唤醒：窗口外只要有意义就接受（开新会话）；
  // 窗口内同样要求有意义，但语气词也放过（不算续期也不打断）。
  if (!inSession && !meaningful) {
    return { accepted: false, command: '', woke: false, activeUntil: activeUntilMs };
  }
  if (inSession && !meaningful) {
    // 窗口内但只是噪声：保持窗口不变，不触发对话。
    return { accepted: false, command: '', woke: false, activeUntil: activeUntilMs };
  }

  return {
    accepted: true,
    command: transcript,
    woke: !inSession, // 窗口外首次触发算"唤醒"
    // 每次成功解析都续期窗口：持续对话不会中途变聋。
    activeUntil: nowMs + RONGRONG_SESSION_MS,
  };
}
