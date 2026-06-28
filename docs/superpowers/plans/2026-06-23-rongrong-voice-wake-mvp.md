# Rongrong Voice Wake MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable “绒绒” hands-free voice loop: wake word, 60 second session, auto phrase capture, and reliable barge-in cancellation.

**Architecture:** Reuse the current WebM recording, STT, LLM, TTS, WebSocket, and audio queue. Add a frontend wake/session helper and recorder hook; add a backend `voice_transcribe` packet that only returns transcript text; run user turns in a cancellable background task with a generation guard.

**Tech Stack:** React 18, browser MediaRecorder/WebAudio, FastAPI WebSocket, Python asyncio, existing OpenAI-compatible STT/TTS clients.

---

### Task 1: Wake Session Rules

**Files:**
- Create: `frontend/src/rongrongVoice.js`
- Test: `frontend/src/rongrongVoice.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RONGRONG_SESSION_MS,
  parseRongrongTranscript,
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
```

- [ ] **Step 2: Run red**

Run: `Set-Location D:\work\desktop-pet\frontend; node --test src/rongrongVoice.test.js`

Expected: FAIL because `rongrongVoice.js` does not exist.

- [ ] **Step 3: Implement the helper**

```javascript
export const RONGRONG_WAKE_WORD = '绒绒';
export const RONGRONG_SESSION_MS = 60_000;

const LEADING_WAKE_RE = /^绒绒[\s,，。.!！?？:：;；-]*/;

export function parseRongrongTranscript(text, nowMs = Date.now(), activeUntilMs = 0) {
  const transcript = String(text || '').trim();
  const hasWake = LEADING_WAKE_RE.test(transcript);
  const inSession = nowMs < activeUntilMs;

  if (!hasWake && !inSession) {
    return { accepted: false, command: '', woke: false, activeUntil: activeUntilMs };
  }

  const command = (hasWake ? transcript.replace(LEADING_WAKE_RE, '') : transcript).trim();
  const activeUntil = nowMs + RONGRONG_SESSION_MS;
  return { accepted: Boolean(command), command, woke: hasWake, activeUntil };
}
```

- [ ] **Step 4: Run green**

Run: `Set-Location D:\work\desktop-pet\frontend; node --test src/rongrongVoice.test.js`

Expected: PASS.

### Task 2: Backend Transcript Packet And Turn Cancellation

**Files:**
- Modify: `backend/protocol.py`
- Modify: `backend/main.py`
- Test: `backend/test_protocol.py`
- Create: `backend/test_turn_cancellation.py`

- [ ] **Step 1: Write failing protocol tests**

Add to `ClientProtocolTest`:

```python
    def test_accepts_voice_transcribe_audio_without_starting_a_turn(self):
        packet_type, payload = parse_client_packet(
            '{"type":"voice_transcribe","payload":{"audio_base64":"abc","format":"audio/webm"}}'
        )

        self.assertEqual(packet_type, "voice_transcribe")
        self.assertEqual(payload["audio_base64"], "abc")
```

Run: `Set-Location D:\work\desktop-pet\backend; python -m unittest test_protocol.ClientProtocolTest.test_accepts_voice_transcribe_audio_without_starting_a_turn -v`

Expected: FAIL with `unknown packet type`.

- [ ] **Step 2: Write failing cancellation test**

Create `backend/test_turn_cancellation.py`:

```python
import asyncio
import unittest

import main


class TurnGuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_stale_generation_does_not_send(self):
        sent = []
        current_generation = 2

        async def send_func(_type, _payload):
            sent.append((_type, _payload))

        guarded = main.make_generation_send(
            send_func,
            generation=1,
            is_current=lambda value: value == current_generation,
        )

        await guarded("audio_chunk", {"text": "old"})

        self.assertEqual(sent, [])

    async def test_current_generation_sends(self):
        sent = []

        async def send_func(_type, _payload):
            sent.append((_type, _payload))

        guarded = main.make_generation_send(
            send_func,
            generation=3,
            is_current=lambda value: value == 3,
        )

        await guarded("voice_transcript", {"text": "绒绒"})

        self.assertEqual(sent, [("voice_transcript", {"text": "绒绒"})])
```

Run: `Set-Location D:\work\desktop-pet\backend; python -m unittest test_turn_cancellation -v`

Expected: FAIL because `make_generation_send` is missing.

- [ ] **Step 3: Implement backend minimal code**

In `backend/protocol.py`, add `voice_transcribe` to `PACKET_TYPES` and validate it like `audio_input`.

In `backend/main.py`, add:

```python
def make_generation_send(send_func, generation, is_current):
    async def guarded_send(type_str, payload):
        if is_current(generation):
            await send_func(type_str, payload)
    return guarded_send
```

In `websocket_endpoint`, keep one `turn_task`, increment `turn_generation` for user turns and interrupts, create tasks for `text_input`, `audio_input`, and `voice_transcribe`, and cancel the active turn on `interrupt`.

- [ ] **Step 4: Run green**

Run:

```powershell
Set-Location D:\work\desktop-pet\backend
python -m unittest test_protocol.ClientProtocolTest.test_accepts_voice_transcribe_audio_without_starting_a_turn test_turn_cancellation -v
```

Expected: PASS.

### Task 3: Hands-Free Recorder Hook And UI Wiring

**Files:**
- Create: `frontend/src/hooks/useRongrongWakeVoice.js`
- Modify: `frontend/src/pages/MainPage.jsx`
- Modify: `frontend/src/components/Chat/InputArea.jsx`
- Modify: `frontend/src/components/Chat/VoiceInput.jsx`

- [ ] **Step 1: Implement minimal hook**

Create a hook that:

- starts `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })` when enabled;
- uses WebAudio RMS every 100 ms to detect speech and silence;
- records one WebM phrase with MediaRecorder;
- calls `onSpeechStart` quickly during speaking for barge-in;
- calls `onVoiceBlob(blob)` after silence;
- stops tracks and timers on disable/unmount.

- [ ] **Step 2: Wire MainPage**

Add message types:

```javascript
VOICE_TRANSCRIBE: "voice_transcribe",
VOICE_TRANSCRIPT: "voice_transcript",
```

On voice transcript:

```javascript
const result = parseRongrongTranscript(payload.text, Date.now(), voiceSessionUntilRef.current);
voiceSessionUntilRef.current = result.activeUntil;
if (result.woke) setWakeVoiceStatus('listening');
if (result.accepted) handleSendMessage(result.command);
```

Add `sendVoiceTranscribeBlob(blob)` that base64 encodes audio and sends `VOICE_TRANSCRIBE`.

- [ ] **Step 3: Wire InputArea and VoiceInput**

Pass `wakeEnabled`, `voiceStatus`, and `onWakeToggle`. The mic button toggles wake listening; F2 remains manual hold-to-talk.

- [ ] **Step 4: Run frontend tests**

Run:

```powershell
Set-Location D:\work\desktop-pet\frontend
node --test src/rongrongVoice.test.js
npm test
```

Expected: PASS.

### Task 4: Verification

**Files:** No new files.

- [ ] **Step 1: Run backend protocol tests**

Run:

```powershell
Set-Location D:\work\desktop-pet\backend
python -m unittest test_protocol test_turn_cancellation -v
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```powershell
Set-Location D:\work\desktop-pet\frontend
npm run build
```

Expected: PASS.

- [ ] **Step 3: State known boundary**

This MVP uses existing paid STT for wake transcript checks. It does not yet bundle local sherpa-onnx KWS.
