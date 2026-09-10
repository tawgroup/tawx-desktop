import assert from 'node:assert/strict';
import test from 'node:test';
import {
  distanceFromBottom,
  FOLLOW_THRESHOLD_PX,
  isUpwardKey,
  shouldFollow,
} from '../src/lib/autoscroll.ts';

test('distance is measured from the bottom of the scrollable content', () => {
  assert.equal(distanceFromBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }), 600);
  assert.equal(distanceFromBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }), 0);
});

test('following continues while the viewport is at the bottom', () => {
  assert.equal(shouldFollow({ distance: 0 }), true);
  assert.equal(shouldFollow({ distance: FOLLOW_THRESHOLD_PX }), true);
  assert.equal(shouldFollow({ distance: FOLLOW_THRESHOLD_PX + 1 }), false);
});

/**
 * The bug this guards: during streaming the message list is replaced on every
 * token, so the follow decision runs before the browser dispatches the reader's
 * `scroll` event. Judging by position alone, the transcript is still "at the
 * bottom" at that instant and yanks back, cancelling the flick.
 */
test('an upward gesture stops following immediately, before any measurement agrees', () => {
  // Still measured as at the bottom — the scroll has not been applied yet.
  assert.equal(shouldFollow({ distance: 0, gestureDeltaY: -40 }), false);
  assert.equal(shouldFollow({ distance: 10, gestureDeltaY: -1 }), false);
});

test('a downward gesture is judged by position, not by direction', () => {
  // Scrolling down while still far from the bottom must not re-pin, or the
  // transcript would jump past the content the reader is moving through.
  assert.equal(shouldFollow({ distance: 800, gestureDeltaY: 40 }), false);
  assert.equal(shouldFollow({ distance: 5, gestureDeltaY: 40 }), true);
});

test('content growing below the fold never re-pins on its own', () => {
  // No gesture, and the distance grew because output was appended.
  assert.equal(shouldFollow({ distance: 2000 }), false);
});

test('the keys a reader leaves the bottom with are recognised', () => {
  for (const key of ['ArrowUp', 'PageUp', 'Home']) assert.equal(isUpwardKey(key), true, key);
  for (const key of ['ArrowDown', 'PageDown', 'End', 'a', 'Enter']) {
    assert.equal(isUpwardKey(key), false, key);
  }
});
