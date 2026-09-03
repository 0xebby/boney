/**
 * The welcome dialog's open state and headline figure.
 *
 * Pure: what makes the dialog open, and which of the marketplace's own numbers it leads with.
 */

import {formatUsd} from "@/lib/format";

/** Storage key holding the welcome version a visitor has dismissed. */
export const WELCOME_SEEN_KEY = "boney:welcome-seen";

/** The current welcome. A visitor who dismissed an earlier version sees this one once. */
export const WELCOME_VERSION = "1";

/** Query parameter that reopens the dialog for a visitor who has already dismissed it. */
export const WELCOME_PARAM = "welcome";

/**
 * Whether the welcome dialog opens on this visit.
 *
 * @param stored The dismissed version from storage, or null when nothing is stored.
 * @param search The location's query string, with or without its leading `?`.
 * @returns True when the dialog should open.
 */
export function shouldOpenWelcome({
  stored,
  search,
}: {
  stored: string | null;
  search: string;
}): boolean {
  if (new URLSearchParams(search).get(WELCOME_PARAM) === "1") return true;
  return stored !== WELCOME_VERSION;
}

/** The dialog's headline number: a muted label, the figure, and its denomination. */
export type WelcomeFigure = {label: string; value: string; unit: string};

/**
 * The marketplace's headline figure.
 *
 * Escrowed value leads whenever anything is escrowed; otherwise the count of live campaigns
 * stands in.
 *
 * @param pool Total reward pool across the visible campaigns, in dollars.
 * @param activeCount How many of them are active.
 * @returns The label, value and unit to render.
 */
export function welcomeFigure({
  pool,
  activeCount,
}: {
  pool: number;
  activeCount: number;
}): WelcomeFigure {
  if (pool > 0) {
    return {
      label: "Escrowed right now",
      value: formatUsd(pool),
      unit: "in reward pools",
    };
  }

  return {
    label: "Live right now",
    value: activeCount.toLocaleString("en-US"),
    unit: activeCount === 1 ? "campaign paying for results" : "campaigns paying for results",
  };
}
