// Idle breathing scheduling: pure decisions so the Orb's idle cost stays near zero and is testable.

/** Idle breathing ticks at this rate (frames/s) instead of every display frame. */
export const IDLE_FPS = 9
/** After this many seconds with no stage change, breathing pauses entirely (settles at rest). */
export const IDLE_PAUSE_AFTER_S = 10

/** Milliseconds between idle ticks. */
export function idleTickInterval(fps: number = IDLE_FPS): number {
  return 1000 / fps
}

/**
 * Whether the idle breathing should render another frame.
 * - A hidden tab never ticks (saves battery while backgrounded).
 * - After IDLE_PAUSE_AFTER_S with no stage change, breathing pauses (returns false) so the
 *   scene settles and the demand frameloop draws nothing until the next stage change or pointer move.
 */
export function shouldIdleTick(
  hidden: boolean,
  elapsedSeconds: number,
  pauseAfter: number = IDLE_PAUSE_AFTER_S,
): boolean {
  if (hidden) return false
  return elapsedSeconds < pauseAfter
}
