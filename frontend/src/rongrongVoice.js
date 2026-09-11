export const RONGRONG_WAKE_WORD = '绒绒';
export const RONGRONG_SESSION_MS = 60_000;

const LEADING_WAKE_RE = /^绒绒[\s,，。.!！?？:：;；-]*/;

export function wakeVoiceEnabledFromStorage(value) {
  return value !== 'false';
}

export function parseRongrongTranscript(text, nowMs = Date.now(), activeUntilMs = 0) {
  const transcript = String(text || '').trim();
  const hasWake = LEADING_WAKE_RE.test(transcript);
  const inSession = nowMs < activeUntilMs;

  if (!hasWake && !inSession) {
    return { accepted: false, command: '', woke: false, activeUntil: activeUntilMs };
  }

  const command = (hasWake ? transcript.replace(LEADING_WAKE_RE, '') : transcript).trim();
  return {
    accepted: Boolean(command),
    command,
    woke: hasWake,
    activeUntil: nowMs + RONGRONG_SESSION_MS,
  };
}
