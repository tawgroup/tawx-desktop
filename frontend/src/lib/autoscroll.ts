/**
 * Whether the transcript should keep following new output.
 *
 * The decision lives here rather than in the component because the component
 * cannot be tested and the rule is subtle: during streaming the message list is
 * replaced on every token, so the follow decision runs dozens of times a
 * second and can beat the browser's own `scroll` event. Reading only the
 * measured position therefore loses a race — the reader flicks up, a token
 * lands before the scroll event dispatches, the transcript is still marked as
 * following, and it yanks back to the bottom, cancelling the flick.
 *
 * So an upward gesture stops the following immediately, without waiting to be
 * confirmed by a measurement.
 */

/** How close to the bottom still counts as "at the bottom". */
export const FOLLOW_THRESHOLD_PX = 120;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

export interface FollowDecision {
  /** Pixels from the bottom of the transcript. */
  distance: number;
  /**
   * Vertical delta of a wheel or touch gesture, when the decision was prompted
   * by one. Negative means the reader scrolled up. Omitted for a decision
   * prompted by a scroll event or by new content.
   */
  gestureDeltaY?: number;
}

/**
 * An upward gesture always stops following. Otherwise following resumes only
 * when the viewport is genuinely back at the bottom, so content growing below
 * the fold never re-pins on its own.
 */
export function shouldFollow(decision: FollowDecision): boolean {
  if (decision.gestureDeltaY !== undefined && decision.gestureDeltaY < 0) return false;
  return decision.distance <= FOLLOW_THRESHOLD_PX;
}

/** Keys a reader uses to leave the bottom of a transcript. */
const UPWARD_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

export function isUpwardKey(key: string): boolean {
  return UPWARD_KEYS.has(key);
}
