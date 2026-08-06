"use client";

import {useSyncExternalStore} from "react";

/**
 * Current unix time in seconds, as an external store.
 *
 * Wall-clock time is an external system, not React state, so `useSyncExternalStore` is the
 * correct primitive: it avoids both the impure `Date.now()` during render and the cascading
 * re-render of setting state inside an effect.
 *
 * `getServerSnapshot` returns 0 so the server prerender and the first client render agree —
 * a real timestamp on the server would differ from the client's and produce a hydration
 * mismatch on every relative-time cell. Callers should treat 0 as "clock not ready".
 */

let currentSecond = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  const next = Math.floor(Date.now() / 1000);
  if (next === currentSecond) return;
  currentSecond = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // Populate immediately on first subscribe so the value is correct on the very next render.
  if (listeners.size === 1) {
    tick();
    // A minute is the right granularity for "3d 4h" style output; a per-second timer would
    // re-render the whole table 60× more often for no visible change.
    timer = setInterval(tick, 60_000);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return currentSecond;
}

function getServerSnapshot(): number {
  return 0;
}

/** Unix seconds, updated once a minute. Returns 0 until the clock is live. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
