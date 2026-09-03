"use client";

import {useEffect, useRef, useState, type Dispatch, type SetStateAction} from "react";
import {
  activeFilterCount,
  EMPTY_FILTERS,
  type CampaignFilters as Filters,
  type StatusFilter,
} from "@/lib/filters";

/**
 * Filter order, most-asked-for first: a visitor scanning the marketplace wants what is running
 * now, so Active leads and the rest follow the lifecycle.
 *
 * Spelled out rather than spread from `CAMPAIGN_STATUS`, because that array mirrors the Solidity
 * enum and its indices are load-bearing (`statusFromIndex`) — it cannot be reordered to suit the
 * UI. `satisfies` keeps the two from drifting apart on spelling; this list must name every status.
 */
const STATUS_OPTIONS = [
  "all",
  "Active",
  "Pending",
  "Paused",
  "Ended",
  "Cancelled",
] as const satisfies readonly StatusFilter[];

/**
 * Everything that narrows the campaign table, behind one control in the table's own header.
 *
 * @param filters The current filter state.
 * @param setFilters Applies a change to that state.
 */
export function CampaignFilters({
  filters,
  setFilters,
}: {
  filters: Filters;
  setFilters: Dispatch<SetStateAction<Filters>>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const count = activeFilterCount(filters);

  /* Escape closes and a pointer outside dismisses — but no arrow-key walk, unlike the promote menu:
     this panel holds a text field, and the arrows belong to it. */
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  /* Opening lands in the field: search is the filter most people came for, and it is a keystroke
     away rather than a second click. */
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-controls="campaign-filters"
        className={`flex min-h-11 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors sm:min-h-8 ${
          count > 0
            ? "border-brand-dim text-ink"
            : "border-hairline-strong text-ink-secondary hover:border-brand-dim hover:text-ink"
        }`}
      >
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 3.5h12L9.75 8.5v4.25L6.25 11V8.5L2 3.5Z" />
        </svg>
        Filters
        {/* The count is the whole reason a collapsed row is still honest: a filtered table never
            hides that it is filtered. */}
        {count > 0 ? (
          <span className="tnum rounded bg-brand px-1 text-[10px] font-semibold leading-4 text-plane">
            {count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id="campaign-filters"
          className="absolute right-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-hairline bg-surface-1 p-3 text-left shadow-lg"
        >
          <div>
            <label className="sr-only" htmlFor="campaign-search">
              Search campaigns, project names, or campaign IDs
            </label>
            <input
              ref={searchRef}
              id="campaign-search"
              type="search"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({...f, search: e.target.value}))}
              placeholder="Search campaigns, projects, or IDs…"
              className="h-11 w-full rounded-md border border-hairline-strong bg-surface-1 px-2.5 text-xs text-ink transition-colors placeholder:text-ink-muted hover:border-brand-dim focus:border-brand sm:h-8"
            />
          </div>

          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
              Status
            </p>

            {/* `flex-wrap`: six chips measure wider than a phone’s content column, and wrapping
                inside their own box keeps every status visible — an `overflow-x-auto` strip would
                put half of them behind a gesture nothing advertises. */}
            <div className="flex flex-wrap items-center gap-1 rounded-md border border-hairline p-0.5">
              {STATUS_OPTIONS.map((option) => {
                const active = filters.status === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setFilters((f) => ({...f, status: option}))}
                    aria-pressed={active}
                    className={`rounded px-2 py-1.5 text-xs transition-colors sm:py-1 ${
                      active ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {option === "all" ? "All" : option}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex min-h-11 cursor-pointer items-center gap-1.5 text-xs text-ink-secondary sm:min-h-0">
            <input
              type="checkbox"
              checked={filters.joinableOnly}
              onChange={(e) => setFilters((f) => ({...f, joinableOnly: e.target.checked}))}
              className="size-3.5 accent-[var(--brand)]"
            />
            Open to me
          </label>

          {count > 0 ? (
            <div className="flex justify-end border-t border-hairline pt-2">
              <button
                type="button"
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="min-h-11 rounded-md px-2 text-xs text-ink-secondary transition-colors hover:text-ink sm:min-h-0 sm:py-1"
              >
                Clear filters
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
