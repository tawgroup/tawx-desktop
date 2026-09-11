import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampVolume,
  createFocusSoundEngine,
  FOCUS_SOUNDS,
  gainForVolume,
  isFocusSoundId,
} from '../src/lib/focusSound.ts';
import { DEFAULT_SETTINGS } from '../src/types.ts';

test('every preset is a distinct, labelled sound', () => {
  const ids = FOCUS_SOUNDS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of FOCUS_SOUNDS) {
    assert.ok(preset.label.length > 0);
    assert.ok(preset.hint.length > 0);
  }
});

test('the remembered preset names a sound that still exists', () => {
  assert.ok(isFocusSoundId(DEFAULT_SETTINGS.focusSoundPreset));
  assert.equal(isFocusSoundId('gamelan'), false);
});

test('volume stays inside the slider range even when storage is nonsense', () => {
  assert.equal(clampVolume(0.5), 0.5);
  assert.equal(clampVolume(-3), 0);
  assert.equal(clampVolume(42), 1);
  assert.equal(clampVolume(Number.NaN), 0);
});

test('gain rises more slowly than the slider so the sweep feels even', () => {
  assert.equal(gainForVolume(0), 0);
  assert.equal(gainForVolume(1), 1);
  assert.ok(gainForVolume(0.5) < 0.5);
  assert.ok(gainForVolume(0.8) > gainForVolume(0.4));
});

test('nothing reaches the speakers until a preset is played', () => {
  let contexts = 0;
  const engine = createFocusSoundEngine(() => {
    contexts += 1;
    return {} as AudioContext;
  });
  engine.stop();
  engine.setVolume(0.9);
  assert.equal(contexts, 0, 'stop and volume changes must not open an AudioContext');
});
