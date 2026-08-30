"use client";

import {useSyncExternalStore} from "react";
import {WELCOME_SEEN_KEY, WELCOME_VERSION} from "@/lib/welcome";

/**
 * Whether the welcome has been dismissed, as an external store.
 *
 * Storage and the location are external systems, so `useSyncExternalStore` reads them rather than
 * an effect that sets state. `getServerSnapshot` reports the welcome as already dismissed, so the
 * server prerender and the first client render agree that no dialog is open; the real values arrive
 * on the snapshot after that.
 */

/** The browser state `shouldOpenWelcome` decides on. */
export type WelcomeSeen = {stored: string | null; search: string};

const SERVER: WelcomeSeen = Object.freeze({stored: WELCOME_VERSION, search: ""});

let snapshot: WelcomeSeen = SERVER;
const listeners = new Set<() => void>();

/**
 * Reads storage and the query string.
 *
 * @returns The current browser state.
 */
function read(): WelcomeSeen {
  let stored: string | null = null;

  // Storage access throws, rather than returning null, where a browser has it disabled.
  try {
    stored = window.localStorage.getItem(WELCOME_SEEN_KEY);
  } catch {
    stored = null;
  }

  return {stored, search: window.location.search};
}

/** Re-reads the browser state and notifies every reader when it moved. */
function refresh(): void {
  const next = read();
  if (next.stored === snapshot.stored && next.search === snapshot.search) return;

  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Registers a reader.
 *
 * @param listener Called when the stored value changes.
 * @returns The unsubscribe function.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // Populate on first subscribe so the value is correct on the very next render.
  if (listeners.size === 1) refresh();

  return () => {
    listeners.delete(listener);
  };
}

/** @returns The stored dismissal and query string, or the server's stand-in for them. */
function getSnapshot(): WelcomeSeen {
  return snapshot;
}

/** @returns The server's stand-in, which reads as dismissed. */
function getServerSnapshot(): WelcomeSeen {
  return SERVER;
}

/** Records the current welcome as dismissed. */
export function dismissWelcome(): void {
  try {
    window.localStorage.setItem(WELCOME_SEEN_KEY, WELCOME_VERSION);
  } catch {
    // Nothing to record it in — the welcome opens again on the next visit.
  }

  refresh();
}

/** @returns Whether the welcome has been dismissed, and the query string that can override it. */
export function useWelcomeSeen(): WelcomeSeen {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
