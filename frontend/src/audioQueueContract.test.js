import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./hooks/useAudioQueue.js', import.meta.url), 'utf8');

test('audio playback state triggers React renders', () => {
  assert.equal(source.includes('const [isPlaying, setIsPlaying] = useState(false)'), true);
  assert.equal(source.includes('isPlaying: isPlayingRef.current'), false);
  assert.equal(source.includes('currentAudioCleanupRef'), true);
  assert.equal(source.includes('currentAudioCleanupRef.current?.()'), true);
});
