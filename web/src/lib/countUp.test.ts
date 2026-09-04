import {describe, expect, it} from "vitest";
import {countUpProgress, countUpValue, easeOutCubic, COUNT_UP_MS} from "./countUp";

/**
 * Count-up arithmetic tests.
 *
 * The only thing a counting figure must never do is settle on a number that is not the real one, so
 * the assertions concentrate on the endpoints: `t >= 1` is the final value exactly, and every clamp
 * holds for the frame timings a real `requestAnimationFrame` loop produces.
 */

describe("easeOutCubic", () => {
  it("runs from 0 to 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("is ahead of linear part-way through", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it("rises monotonically", () => {
    let previous = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const eased = easeOutCubic(t);
      expect(eased).toBeGreaterThanOrEqual(previous);
      previous = eased;
    }
  });

  it("clamps outside the unit interval", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(4)).toBe(1);
  });
});

describe("countUpProgress", () => {
  it("is 0 before the first frame and 1 at the end", () => {
    expect(countUpProgress(0, COUNT_UP_MS)).toBe(0);
    expect(countUpProgress(COUNT_UP_MS, COUNT_UP_MS)).toBe(1);
  });

  it("is a fraction in between", () => {
    expect(countUpProgress(COUNT_UP_MS / 2, COUNT_UP_MS)).toBeCloseTo(0.5);
  });

  /** A dropped frame or a backgrounded tab can hand the loop an elapsed far past the duration. */
  it("never exceeds 1", () => {
    expect(countUpProgress(COUNT_UP_MS * 40, COUNT_UP_MS)).toBe(1);
  });

  it("treats a zero duration as already finished", () => {
    expect(countUpProgress(1, 0)).toBe(1);
    expect(countUpProgress(1, -5)).toBe(1);
  });

  it("survives a negative or non-finite elapsed", () => {
    expect(countUpProgress(-10, COUNT_UP_MS)).toBe(0);
    expect(countUpProgress(Number.NaN, COUNT_UP_MS)).toBe(0);
  });
});

describe("countUpValue", () => {
  it("starts at the starting value and lands exactly on the final one", () => {
    expect(countUpValue(0, 18425, 0)).toBe(0);
    expect(countUpValue(0, 18425, 1)).toBe(18425);
  });

  /** Rounding part-way through must not overshoot the destination. */
  it("stays inside the interval it is crossing", () => {
    for (let t = 0; t <= 1; t += 0.1) {
      const value = countUpValue(0, 18425, t);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(18425);
    }
  });

  it("returns whole numbers", () => {
    expect(Number.isInteger(countUpValue(0, 1237, 0.37))).toBe(true);
  });

  it("counts down as readily as up", () => {
    expect(countUpValue(500, 100, 0)).toBe(500);
    expect(countUpValue(500, 100, 1)).toBe(100);
    expect(countUpValue(500, 100, 0.5)).toBeLessThan(500);
  });

  it("holds a figure that is not moving", () => {
    expect(countUpValue(42, 42, 0.5)).toBe(42);
  });

  /** Past the end the figure is the real number, never a rounded approximation of it. */
  it("is the final value for any progress at or past 1", () => {
    expect(countUpValue(0, 9730, 1.6)).toBe(9730);
  });
});
