/**
 * JoinedBadge — marks a campaign the connected wallet has already joined as a promoter.
 *
 * Deliberately not a `StatusPill` variant. That component carries the campaign's own lifecycle,
 * which is a fact about the campaign and identical for everyone looking at it; this is a fact about
 * the *viewer's* relationship to it and disappears when the wallet does. Reusing the status colours
 * would put a personal marker in the same visual channel as Active/Ended and make a row look like
 * it had two statuses, so this takes brand tinting instead.
 *
 * Only ever rendered in the affirmative — there is no "not joined" badge. Absence is the default
 * state of every row, so marking it would add noise to most of the table to say nothing.
 *
 * Colour is not the only carrier: the label is always present and the glyph is decorative, which
 * keeps the marker legible in monochrome and to anyone who does not distinguish the hue.
 */
export function JoinedBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-brand-dim bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand"
      title="You have joined this campaign as a promoter"
    >
      <span aria-hidden>✓</span>
      Joined
    </span>
  );
}
