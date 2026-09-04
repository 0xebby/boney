"use client";

import {useSyncExternalStore} from "react";

/**
 * Whether the OS asks for reduced motion, as an external store.
 *
 * `globals.css` already flattens every CSS animation under
 * `@media (prefers-reduced-motion: reduce)`. This is the JS half, for the count-up figures whose
 * numbers are driven by `requestAnimationFrame` and which a stylesheet cannot reach.
 *
 * `getServerSnapshot` returns `true` so the server prerenders settled final numbers: a figure that
 * starts at 0 on the server and animates on the client would otherwise hydrate against a mismatch.
 * The animation begins only once the client has confirmed motion is allowed.
 */

const QUERY = "(prefers-reduced-motion: reduce)";

function matcher(): MediaQueryList | undefined {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : undefined;
}

function subscribe(listener: () => void): () => void {
  const list = matcher();
  if (!list) return () => {};

  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}

function getSnapshot(): boolean {
  return matcher()?.matches ?? true;
}

function getServerSnapshot(): boolean {
  return true;
}

/** True when animation should be skipped and figures should show their final values immediately. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
