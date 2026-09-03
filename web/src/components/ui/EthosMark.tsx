/**
 * The Ethos Network mark, for crediting where a BoneyScore's credibility half comes from.
 *
 * Ethos's own glyph, one path, filled with `currentColor` — so its container sets the colour, and one
 * class puts the mark and the word "Ethos" in the same `--brand-ethos` green. `aria-hidden` because
 * that word is always written beside it; the mark alone never carries the attribution.
 *
 * @param className Sizing and colour classes.
 * @returns The mark.
 */
export function EthosMark({className = ""}: {className?: string}) {
  return (
    <svg aria-hidden viewBox="0 0 40 40" className={className} fill="currentColor">
      <path d="M19.92 19.96C19.92 21.3282 19.8351 22.6765 19.6703 24H0V32H17.606C16.444 34.8973 14.875 37.5876 12.9697 40H40V32H17.606C18.6188 29.475 19.3225 26.7927 19.6703 24H40V16H19.6801C19.3395 13.208 18.6432 10.5257 17.638 8H40V0H13.0327C14.927 2.4141 16.4855 5.10421 17.638 8H0V16H19.6801C19.8385 17.2978 19.92 18.6194 19.92 19.96Z" />
    </svg>
  );
}
