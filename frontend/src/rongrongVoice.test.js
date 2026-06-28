import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RONGRONG_SESSION_MS,
  parseRongrongTranscript,
  wakeVoiceEnabledFromStorage,
} from './rongrongVoice.js';

test('wake word starts a session without sending an empty command', () => {
  assert.deepEqual(parseRongrongTranscript('绒绒', 1000, 0), {
    accepted: false,
    command: '',
    woke: true,
    activeUntil: 1000 + RONGRONG_SESSION_MS,
  });
});

test('wake word prefix strips punctuation and keeps the command', () => {
  assert.deepEqual(parseRongrongTranscript('绒绒，帮我看看天气', 2000, 0), {
    accepted: true,
    command: '帮我看看天气',
    woke: true,
    activeUntil: 2000 + RONGRONG_SESSION_MS,
  });
});

test('active session accepts follow-up speech without repeating the wake word', () => {
  assert.deepEqual(parseRongrongTranscript('继续说', 3000, 4000), {
    accepted: true,
    command: '继续说',
    woke: false,
    activeUntil: 3000 + RONGRONG_SESSION_MS,
  });
});

test('sleeping session ignores speech without the wake word', () => {
  assert.deepEqual(parseRongrongTranscript('今天天气', 5000, 4000), {
    accepted: false,
    command: '',
    woke: false,
    activeUntil: 4000,
  });
});

test('wake voice is enabled by default like a smart speaker standby mode', () => {
  assert.equal(wakeVoiceEnabledFromStorage(null), true);
  assert.equal(wakeVoiceEnabledFromStorage(undefined), true);
});

test('wake voice only stays off when the user explicitly disabled it', () => {
  assert.equal(wakeVoiceEnabledFromStorage('false'), false);
  assert.equal(wakeVoiceEnabledFromStorage('true'), true);
});
