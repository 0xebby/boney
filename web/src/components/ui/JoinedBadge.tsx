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
 * Colour is not the only carrier: the word is always present, which keeps the marker legible in
 * monochrome and to anyone who does not distinguish the hue. It carries no glyph — a decorative tick
 * was the widest part of the badge and said nothing the word does not.
 *
 * A tinted label with no border, sized to sit beside a campaign name without competing with it. It
 * never sets its column's width — the cell it lives in is capped, so the badge appearing with a
 * connected wallet leaves the table's columns where they were.
 */
export function JoinedBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded bg-brand/10 px-1 py-px text-[9px] font-medium uppercase leading-none tracking-wide text-brand"
      title="You have joined this campaign as a promoter"
    >
      Joined
    </span>
  );
}
