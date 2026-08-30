"use client";

import {useState} from "react";
import Link from "next/link";
import {Modal} from "@/components/ui/Modal";
import {dismissWelcome, useWelcomeSeen} from "@/hooks/useWelcomeSeen";
import {shouldOpenWelcome, type WelcomeFigure} from "@/lib/welcome";

/** Eyebrow above a figure or a section: small, uppercase, widely tracked. */
const EYEBROW = "text-[11px] font-medium uppercase tracking-[0.16em] text-ink-muted";

/** Full-width pill CTA, at the app's touch target below `sm` and a little taller above it. */
const CTA =
  "mt-3.5 flex min-h-11 w-full items-center justify-center rounded-full text-[13px] font-semibold uppercase tracking-[0.1em] transition-colors sm:mt-4 sm:min-h-12";

/**
 * The first-visit introduction to the marketplace.
 *
 * Leads with the live escrowed total, then addresses the two sides of it in turn — promoters, who
 * join a campaign and get paid per verified result, and projects, who fund one. Each side carries
 * its own action: promoters are already looking at the campaign list behind the dialog, so theirs
 * closes it, while a project's goes to `/create`.
 *
 * Opens once per welcome version and records the dismissal, so a returning visitor lands straight on
 * the campaign list; `?welcome=1` reopens it. Held shut until the marketplace's numbers have landed,
 * because the figure it leads with is the live escrowed total rather than a placeholder.
 *
 * @param figure The headline number, from `lib/welcome`.
 * @param ready Whether the campaign list has loaded.
 * @returns The dialog, or nothing while it is shut.
 */
export function WelcomeDialog({figure, ready}: {figure: WelcomeFigure; ready: boolean}) {
  const seen = useWelcomeSeen();

  // Not folded into the store: a browser with storage disabled records nothing, and the close
  // control has to shut the dialog there too.
  const [closed, setClosed] = useState(false);

  const close = () => {
    setClosed(true);
    dismissWelcome();
  };

  return (
    <Modal
      open={ready && !closed && shouldOpenWelcome(seen)}
      onClose={close}
      title="Welcome to Boneyard beta testing"
      closeLabel="Close the welcome"
      hideTitle
      padded={false}
    >
      <div className="px-6 pb-7 pt-7 sm:px-8 sm:pb-9 sm:pt-8">
        {/*
          The accessible name is the dialog's own `sr-only` heading, so the mark is decoration.

          `leading-tight` rather than `leading-none`: this wraps, and the display face has enough
          ascender to collide with the line above it. Capped to a measure and centred like the page's
          own wordmark lockup — unbounded, its first line runs under the ✕ floating over this body.

          Size and measure are paired so the phone gets two lines rather than three: this is a bottom
          sheet that has to seat a figure and two calls to action above the fold on a 667px screen, and
          a third line of a display face is 25px of that budget.
        */}
        <p
          aria-hidden
          className="mx-auto max-w-[16rem] text-balance text-center font-display text-xl leading-tight text-ink sm:max-w-[19rem] sm:text-3xl"
        >
          welcome to boneyard beta testing<span className="text-brand">.</span>
        </p>

        <hr className="mt-6 border-hairline sm:mt-7" />

        <p className={`mt-5 sm:mt-6 ${EYEBROW}`}>{figure.label}</p>
        {/* Proportional figures: `tnum` gives every digit a `0`'s width, which reads loose at
            display size. */}
        <p className="mt-2 font-display text-4xl leading-none text-ink sm:text-5xl">{figure.value}</p>
        <p className={`mt-2.5 ${EYEBROW}`}>{figure.unit}</p>

        <hr className="mt-5 border-hairline sm:mt-6" />

        <p className={`mt-4 sm:mt-5 ${EYEBROW}`}>For promoters</p>
        <p className="mt-2 text-balance text-base leading-snug text-ink-muted sm:text-lg">
          Join a campaign, share your boneylink.
        </p>
        <p className="text-balance text-base font-medium leading-snug text-ink sm:text-lg">
          Get paid per verified result.
        </p>
        {/* The campaign list is already behind the dialog, so browsing is a dismissal, not a route. */}
        <button
          type="button"
          onClick={close}
          className={`${CTA} bg-brand text-plane hover:opacity-90`}
        >
          Browse campaigns
        </button>

        <hr className="mt-5 border-hairline sm:mt-6" />

        <p className={`mt-4 sm:mt-5 ${EYEBROW}`}>For projects</p>
        <p className="mt-2 text-balance text-base leading-snug text-ink-muted sm:text-lg">
          Set the KPI. Escrow the reward.
        </p>
        <p className="text-balance text-base font-medium leading-snug text-ink sm:text-lg">
          Pay for what&rsquo;s verified.
        </p>
        <Link
          href="/create"
          onClick={close}
          className={`${CTA} border border-hairline-strong text-ink hover:bg-surface-hover`}
        >
          Create a campaign
        </Link>
      </div>
    </Modal>
  );
}
