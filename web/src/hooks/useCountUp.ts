"use client";

import {useEffect, useRef, useState} from "react";
import {useReducedMotion} from "@/hooks/useReducedMotion";
import {countUpProgress, countUpValue, COUNT_UP_MS} from "@/lib/countUp";

/**
 * A number that counts up to its value on a frame loop.
 *
 * The arithmetic is `lib/countUp.ts`; this owns the frames. Under reduced motion — which includes
 * every server render and the first client render, since `useReducedMotion` reports `true` for both —
 * the target is returned unchanged and no loop starts, so the settled number is what hydrates.
 *
 * @param target The value to reach. A change re-counts from the number currently on screen.
 * @param duration How long to take, in milliseconds.
 * @returns The value to render this frame.
 */
export function useCountUp(target: number, duration: number = COUNT_UP_MS): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(0);
  // Written only from the frame callback, so a target that changes mid-count resumes from the number
  // on screen rather than jumping back to 0.
  const shown = useRef(0);

  useEffect(() => {
    if (reduced || !Number.isFinite(target)) return;

    const from = shown.current;
    if (from === target) return;

    let frame = 0;
    let start: number | undefined;

    const step = (now: number) => {
      start ??= now;
      const progress = countUpProgress(now - start, duration);
      const next = countUpValue(from, target, progress);
      shown.current = next;
      setValue(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduced]);

  return reduced || !Number.isFinite(target) ? target : value;
}
