"use client";

import {useEffect, useRef, useState} from "react";
import {useRouter} from "next/navigation";
import {Notice} from "@/components/ui/Notice";
import {TxErrorMessage} from "@/components/ui/TxErrorMessage";
import {useJoinCampaign, isPending} from "@/hooks/useWriteCampaign";
import {joinableCount, type JoinOption} from "@/lib/joinPicker";
import {projectName} from "@/lib/projects";
import {StatusPill} from "@/components/ui/StatusPill";

/**
 * "Promote a campaign" — a trigger that reveals the campaigns a promoter can join and signs the join
 * for whichever one they pick.
 *
 * Options and their refusals are decided in `lib/joinPicker`; this renders them and owns the
 * disclosure behaviour. A blocked campaign stays in the list with its reason as help text.
 */

/**
 * @param options Every offerable campaign with its eligibility, from `joinOptions`.
 * @param onJoined Called once the join confirms, so the caller can refetch membership.
 * @param loading Whether the campaign list is still arriving.
 * @param caption A line under the trigger saying what promoting a campaign gets you.
 * @param className Extra classes for the anchor the trigger and its panels position against.
 */
export function JoinCampaignMenu({
  options,
  onJoined,
  loading = false,
  caption,
  className = "",
}: {
  options: readonly JoinOption[];
  onJoined: () => void;
  loading?: boolean;
  caption?: string;
  className?: string;
}) {
  const router = useRouter();
  const join = useJoinCampaign();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<JoinOption | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigated = useRef(false);

  const busy = isPending(join.state);
  const enabledCount = joinableCount(options);

  /** Escape closes, arrows walk the list, and a pointer outside dismisses. */
  useEffect(() => {
    if (!open) return;

    const items = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
      );

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

      const focusable = items();
      if (focusable.length === 0) return;

      event.preventDefault();
      const at = focusable.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = at === -1 ? 0 : (at + step + focusable.length) % focusable.length;
      focusable[next].focus();
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

  /** A confirmed join lands on the campaign it just joined. */
  useEffect(() => {
    if (join.state.status !== "confirmed" || !pending || navigated.current) return;
    navigated.current = true;
    onJoined();
    router.push(`/campaign/${pending.view.campaignId}`);
  }, [join.state.status, pending, onJoined, router]);

  const label = busy
    ? `Promoting ${pending ? projectName(pending.view) : "campaign"}…`
    : "Promote a campaign";

  return (
    <div className={`relative flex flex-col gap-2 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((was) => !was)}
        disabled={loading || busy}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls="join-campaign-menu"
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-hairline-strong bg-surface-1 px-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
        <span aria-hidden className={`text-[10px] leading-none transition-transform ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>

      {/* In flow rather than absolute, so the panel and the wallet progress below it clear
          the caption instead of landing on top of it. */}
      {caption ? (
        <p className="text-balance text-center text-xs leading-snug text-ink-muted">{caption}</p>
      ) : null}

      {open ? (
        <div
          ref={panelRef}
          id="join-campaign-menu"
          role="menu"
          aria-label="Campaigns you can promote"
          className="absolute left-1/2 top-full z-30 mt-2 max-h-80 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto overscroll-contain rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-muted">
              No campaign is accepting promoters right now.
            </p>
          ) : (
            <>
              {enabledCount === 0 ? (
                <p className="px-3 pb-1 pt-2 text-xs text-ink-muted">
                  None of these are open to this wallet yet — each one says why.
                </p>
              ) : null}

              {options.map((option) => (
                <JoinMenuOption
                  key={option.view.campaign}
                  option={option}
                  onSelect={async () => {
                    setOpen(false);
                    setPending(option);
                    await join.join(option.view.campaign, {campaignName: projectName(option.view)});
                  }}
                />
              ))}
            </>
          )}
        </div>
      ) : null}

      <JoinFeedback state={join.state} onReset={join.reset} />
    </div>
  );
}

/**
 * One row of the menu.
 *
 * @param option The campaign and its eligibility.
 * @param onSelect Signs the join for this campaign.
 */
function JoinMenuOption({option, onSelect}: {option: JoinOption; onSelect: () => void}) {
  const {view, eligibility} = option;

  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      disabled={!eligibility.ok}
      className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{projectName(view)}</span>
        {eligibility.reason ? (
          <span className="mt-0.5 block text-xs leading-snug text-ink-muted">
            {eligibility.reason}
          </span>
        ) : null}
      </span>
      <StatusPill status={view.status} />
    </button>
  );
}

/**
 * Wallet progress for the join in flight, anchored under the trigger.
 *
 * @param state The join transaction's state.
 * @param onReset Clears an error.
 */
function JoinFeedback({
  state,
  onReset,
}: {
  state: ReturnType<typeof useJoinCampaign>["state"];
  onReset: () => void;
}) {
  if (state.status === "idle" || state.status === "confirmed") return null;

  if (state.status === "error") {
    return (
      <div className="absolute left-1/2 top-full z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2">
        <Notice
          tone="critical"
          title={<TxErrorMessage message={state.message} detail={state.detail} onDismiss={onReset} />}
        />
      </div>
    );
  }

  /* Absolute like the error above it: this appears and disappears mid-page, and in flow it would
     nudge the row it sits in every time a wallet prompt opens. */
  return (
    <p
      role="status"
      aria-live="polite"
      className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-xs text-ink-muted"
    >
      {state.status === "preparing" ? "Confirm in your wallet…" : "Submitted — waiting for confirmation."}
    </p>
  );
}
