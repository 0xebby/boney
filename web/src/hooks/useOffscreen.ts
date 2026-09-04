"use client";

import {useEffect, useRef, useState, type RefObject} from "react";

/**
 * Whether an element has scrolled out of the viewport.
 *
 * Used for the leaderboard's sticky standing bar, which should appear only once the panel it
 * duplicates is no longer readable.
 *
 * @returns A ref to attach to the watched element, and whether it is currently out of view. Reports
 * `false` before the observer has run and wherever `IntersectionObserver` is unavailable, so the
 * duplicate never appears alongside the original.
 */
export function useOffscreen<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  offscreen: boolean;
} {
  const ref = useRef<T | null>(null);
  const [offscreen, setOffscreen] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver !== "function") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setOffscreen(!entry.isIntersecting);
      },
      {threshold: 0},
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return {ref, offscreen};
}
