/**
 * The arithmetic behind a counting figure.
 *
 * Pure, so the easing and the clamping are fixture-tested; `useCountUp` owns the frame loop.
 */

/** How long a figure takes to reach its value, in milliseconds. */
export const COUNT_UP_MS = 900;

/**
 * Cubic ease-out — fast first, settling at the end.
 *
 * @param t Progress from 0 to 1.
 * @returns The eased fraction, 0 at 0 and 1 at 1.
 */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

/**
 * Progress through a count-up.
 *
 * @param elapsed Milliseconds since the animation started.
 * @param duration Total milliseconds; a non-positive duration is already finished.
 * @returns Progress from 0 to 1.
 */
export function countUpProgress(elapsed: number, duration: number): number {
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  if (duration <= 0) return 1;
  return Math.min(1, elapsed / duration);
}

/**
 * The whole number a figure shows part-way through its count-up.
 *
 * @param from Starting value.
 * @param to Final value.
 * @param t Progress from 0 to 1.
 * @returns The rounded value at that point, exactly `to` once `t` reaches 1.
 */
export function countUpValue(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  return Math.round(from + (to - from) * easeOutCubic(t));
}
